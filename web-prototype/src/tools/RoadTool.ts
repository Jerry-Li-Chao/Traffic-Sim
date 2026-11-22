import type { Tool, ToolContext } from './Tool';
import type { PointerInfo } from '../game/Input';
import { type Anchor, planRoad, applyRoad, snapAnchor, planZ, type RoadPlan, type RoadProposal } from '../world/build';
import { type Vec2, dot, sub, angleOf, makePolyline, wrapAngle } from '../core/math';
import { getUI, setUI, toast } from '../game/store';
import { crossSection } from '../world/World';
import { getClass, MAX_LEVEL, MIN_LEVEL, levelZ, LEVEL_NAMES, LEVEL_STEP } from '../world/roads';

const DEG = Math.PI / 180;

/**
 * Draw straight or curved roads, chaining from the last end point.
 * Precision aids (after the Cities: Skylines road tools and mods such as Precision Engineering
 * and Fine Road Tools): live length / bearing / relative angle / grade / height read-outs,
 * angle, length and grid snapping, and guide lines along the extension of existing roads.
 */
export class RoadTool implements Tool {
  id = 'road';
  start: Anchor | null = null;
  control: Vec2 | null = null;
  lastPlan: RoadPlan | null = null;
  private cursor: PointerInfo | null = null;
  /** what snapped the end point this frame (for the read-out and the guide overlay) */
  private snapNote: string | null = null;
  private guide: { from: Vec2; to: Vec2 } | null = null;

  constructor(private ctx: ToolContext) {}

  activate() {
    this.reset();
  }
  deactivate() {
    this.reset();
    this.ctx.overlay.clear('ghost');
    this.ctx.overlay.clear('ghost-m');
    this.ctx.overlay.clear('ghost-guide');
    this.ctx.overlay.clear('ghost-target');
    setUI({ ghostInfo: null });
  }
  private committing = false;

  refresh() {
    if (this.committing) return;
    // drop anchors that no longer exist (undo, split by another edit)
    if (this.start && !this.anchorAlive(this.start)) this.reset();
    if (this.cursor) this.onMove(this.cursor);
  }

  private anchorAlive(a: Anchor) {
    if (a.kind === 'node') return this.ctx.world.nodes.has(a.node);
    if (a.kind === 'seg') return this.ctx.world.segments.has(a.seg);
    return true;
  }

  reset() {
    this.start = null;
    this.control = null;
    this.lastPlan = null;
  }

  private snapRadius() {
    return Math.max(6, this.ctx.cam.mpp * 14);
  }

  private anchorAt(p: PointerInfo, exclude?: Set<number>): Anchor {
    const ui = getUI();
    const a = snapAnchor(this.ctx.world, p.world, this.snapRadius(), {
      grid: ui.gridSnap ? 8 : undefined,
      level: ui.level,
      exclude,
    });
    this.snapNote = null;
    this.guide = null;
    if (a.kind !== 'free' || !this.start || this.control) return a;
    const s = this.start.pos;
    // 1) guide lines: continue the line of an existing road
    if (ui.snapGuides && !p.shift) {
      const g = this.guideSnap(a.pos);
      if (g) {
        a.pos = g.pos;
        this.guide = { from: g.from, to: g.pos };
        this.snapNote = 'on guide';
        return a;
      }
    }
    const d = sub(a.pos, s);
    let L = Math.hypot(d.x, d.y);
    let ang = angleOf(d);
    // 2) angle: 15° steps against the world and against the road we start from;
    //    always with Shift held, otherwise only when already close
    if (ui.snapAngle || p.shift) {
      const ref = this.referenceDir();
      const bases = ref ? [0, angleOf(ref)] : [0];
      let best: { a: number; err: number; rel: number | null } | null = null;
      for (const [bi, b] of bases.entries()) {
        const k = Math.round(wrapAngle(ang - b) / (15 * DEG));
        const cand = b + k * 15 * DEG;
        const err = Math.abs(wrapAngle(ang - cand));
        // prefer the start road's frame when tied (perpendicular branches)
        if (!best || err < best.err + (bi ? 0.2 * DEG : 0)) best = { a: cand, err, rel: bi ? Math.abs(k * 15) : null };
      }
      if (best && (p.shift || best.err < 4 * DEG)) {
        ang = best.a;
        const rel = best.rel === null ? null : best.rel % 180;
        this.snapNote = rel === null ? 'angle' : rel === 0 ? 'in line with road' : rel === 90 ? 'square to road' : `${Math.min(rel, 180 - rel)}° to road`;
      }
    }
    // 3) length: whole 5 m steps
    if (ui.snapLength) L = Math.max(5, Math.round(L / 5) * 5);
    a.pos = { x: s.x + Math.cos(ang) * L, y: s.y + Math.sin(ang) * L };
    return a;
  }

  /** Direction of the road we are building from (to measure angles against). */
  private referenceDir(): Vec2 | null {
    const st = this.start;
    if (!st) return null;
    const w = this.ctx.world;
    if (st.kind === 'node') {
      const segs = w.segmentsAt(st.node);
      if (!segs.length) return null;
      const t = w.tangentFrom(segs[0], st.node);
      return { x: -t.x, y: -t.y };
    }
    if (st.kind === 'seg') {
      const seg = w.seg(st.seg);
      const poly = w.poly(seg);
      const i = Math.max(0, Math.min(poly.cum.length - 2, poly.cum.findIndex((c) => c >= st.along) - 1));
      const dx = poly.pts[i * 2 + 2] - poly.pts[i * 2],
        dy = poly.pts[i * 2 + 3] - poly.pts[i * 2 + 1];
      const l = Math.hypot(dx, dy) || 1;
      return { x: dx / l, y: dy / l };
    }
    return null;
  }

  /** Snap onto the straight-ahead extension of a nearby road end. */
  private guideSnap(p: Vec2): { pos: Vec2; from: Vec2 } | null {
    const w = this.ctx.world;
    const tol = Math.max(2.5, this.ctx.cam.mpp * 9);
    let best: { pos: Vec2; from: Vec2; d: number } | null = null;
    for (const n of w.nodes.values()) {
      if (this.start?.kind === 'node' && this.start.node === n.id) continue;
      const segs = w.segmentsAt(n.id);
      if (segs.length !== 1 && segs.length !== 2) continue;
      for (const sg of segs) {
        const t = w.tangentFrom(sg, n.id);
        const dir = { x: -t.x, y: -t.y }; // carrying on past the node
        const rel = sub(p, n);
        const along = dot(rel, dir);
        if (along < 8 || along > 400) continue;
        const off = Math.abs(rel.x * dir.y - rel.y * dir.x);
        if (off > tol || (best && off >= best.d)) continue;
        best = { pos: { x: n.x + dir.x * along, y: n.y + dir.y * along }, from: { x: n.x, y: n.y }, d: off };
      }
    }
    return best;
  }

  /** Direction a road continuing from a dead-end node should take. */
  private continuation(a: Anchor): Vec2 | null {
    if (a.kind !== 'node') return null;
    const segs = this.ctx.world.segmentsAt(a.node);
    if (segs.length !== 1) return null;
    const t = this.ctx.world.tangentFrom(segs[0], a.node);
    return { x: -t.x, y: -t.y };
  }

  private constrainedControl(p: Vec2): Vec2 {
    const dir = this.start ? this.continuation(this.start) : null;
    if (!dir || !this.start) return p;
    const s = this.start.pos;
    const along = Math.max(8, dot(sub(p, s), dir));
    return { x: s.x + dir.x * along, y: s.y + dir.y * along };
  }

  proposal(end: Anchor): RoadProposal {
    const ui = getUI();
    return { start: this.start!, end, control: this.control ?? undefined, cls: ui.roadClass, level: ui.level };
  }

  onMove(p: PointerInfo) {
    this.cursor = p;
    const ctx = this.ctx;
    const ui = getUI();
    if (!this.start) {
      const a = this.anchorAt(p);
      this.drawAnchor(a, null);
      ctx.overlay.clear('ghost');
      setUI({ ghostInfo: null });
      return;
    }
    if (ui.curveMode && !this.control) {
      // choosing the bend point: show a straight preview toward the cursor
      const ctrl = this.constrainedControl(p.world);
      const plan = planRoad(ctx.world, { ...this.proposal({ kind: 'free', pos: ctrl }) }, ctx.map, this.budget());
      this.drawPlan(plan, true);
      return;
    }
    const exclude = this.start.kind === 'node' ? new Set([this.start.node]) : undefined;
    const end = this.anchorAt(p, exclude);
    const plan = planRoad(ctx.world, this.proposal(end), ctx.map, this.budget());
    this.lastPlan = plan;
    this.drawPlan(plan, false);
  }

  private budget() {
    return this.ctx.unlimited() ? Infinity : this.ctx.money();
  }

  onDown(p: PointerInfo) {
    if (p.button !== 0) return false;
    const ui = getUI();
    if (!this.start) {
      const a = this.anchorAt(p);
      this.start = a;
      this.onMove(p);
      return true;
    }
    if (ui.curveMode && !this.control) {
      this.control = this.constrainedControl(p.world);
      this.onMove(p);
      return true;
    }
    this.onMove(p);
    const plan = this.lastPlan;
    if (!plan) return true;
    if (!plan.valid) {
      toast(plan.reason ?? 'Invalid road', 'warn');
      return true;
    }
    let created: number[] = [];
    this.committing = true;
    const ok = this.ctx.commit(`Build ${getClass(ui.roadClass).name}`, plan.cost, () => {
      created = applyRoad(this.ctx.world, plan);
    });
    this.committing = false;
    if (ok && created.length) {
      const last = this.ctx.world.seg(created[created.length - 1]);
      const n = this.ctx.world.node(last.b);
      this.start = { kind: 'node', node: n.id, pos: { x: n.x, y: n.y } };
      this.control = null;
      this.lastPlan = null;
    }
    this.onMove(p);
    return true;
  }

  onCancel() {
    const busy = !!(this.start || this.control);
    if (this.control) this.control = null;
    else this.start = null;
    this.lastPlan = null;
    if (this.cursor) this.onMove(this.cursor);
    return busy;
  }

  onKey(k: string) {
    const ui = getUI();
    if (k === 'c') {
      setUI({ curveMode: !ui.curveMode });
      this.control = null;
      return true;
    }
    if (k === 'g') {
      setUI({ gridSnap: !ui.gridSnap });
      return true;
    }
    if (k === 'pageup' || k === '=' || k === '+' || k === ']') {
      setUI({ level: Math.min(MAX_LEVEL, ui.level + 1) });
      this.refresh();
      return true;
    }
    if (k === 'pagedown' || k === '-' || k === '[') {
      setUI({ level: Math.max(MIN_LEVEL, ui.level - 1) });
      this.refresh();
      return true;
    }
    return false;
  }

  private drawAnchor(a: Anchor, plan: RoadPlan | null) {
    const ui = getUI();
    const markers = [];
    const z = a.kind === 'free' ? levelZ(ui.level) : a.kind === 'node' ? levelZ(this.ctx.world.node(a.node).level) : 0;
    const color = a.kind === 'node' ? '#2f7fd6' : a.kind === 'seg' ? '#e08a1e' : '#ffffff';
    markers.push({ pos: a.pos, radius: a.kind === 'free' ? 1.5 : 2.5, color, z });
    if (plan) {
      for (const h of plan.hits) markers.push({ pos: h.pos, radius: 2.5, color: '#e08a1e', z: 0, ring: true });
      if (this.control) markers.push({ pos: this.control, radius: 1.2, color: '#ffffff', z: 0 });
      if (this.start) markers.push({ pos: this.start.pos, radius: 2.5, color: '#2f7fd6', z: 0, ring: true });
    }
    this.ctx.overlay.markers('ghost-m', markers);
    // light up the road we would connect to, at its own height (a bridge, not the road beneath)
    const tgt = a.kind === 'seg' ? a.seg : null;
    const g = tgt !== null ? this.ctx.geom.segs.get(tgt) : undefined;
    this.ctx.overlay.ribbons('ghost-target', g ? [{ line: g.center, halfWidth: g.cs.width / 2 + 0.6, color: '#7cc4ff', opacity: 0.3, z: g.z.map((v) => v + 0.3) }] : []);
  }

  private drawPlan(plan: RoadPlan, provisional: boolean) {
    const cls = getClass(plan.proposal.cls);
    const fake = { cls: cls.id, lanesF: cls.lanesF, lanesB: cls.lanesB } as Parameters<typeof crossSection>[0];
    const half = crossSection(fake).width / 2;
    const z = plan.poly.cum.map((c) => planZ(plan, c));
    const valid = plan.valid || provisional;
    this.ctx.overlay.ribbons('ghost', [
      { line: plan.poly, z, halfWidth: half, color: valid ? '#3f9b5f' : '#c0392b', opacity: 0.45 },
      { line: plan.poly, z, halfWidth: 0.35, color: '#ffffff', opacity: 0.8 },
    ]);
    this.drawAnchor(plan.proposal.end, plan);
    this.ctx.overlay.lines('ghost-guide', this.guide ? [{ line: makePolyline([this.guide.from, this.guide.to]), color: '#7cc4ff', width: 0.6, z: z[z.length - 1], opacity: 0.9 }] : []);
    setUI({
      ghostInfo: {
        cost: plan.cost,
        length: plan.length,
        valid,
        reason: provisional ? 'Click to set the bend' : plan.reason,
        detail: provisional ? undefined : this.readout(plan),
      },
    });
  }

  /** Precision read-out: bearing, angle to the connected road, grade and height. */
  private readout(plan: RoadPlan): string {
    const parts: string[] = [];
    const p = plan.poly;
    const n = p.pts.length / 2;
    if (n >= 2) {
      // compass bearing of the road at its start (north up, clockwise)
      const dx = p.pts[2] - p.pts[0],
        dy = p.pts[3] - p.pts[1];
      const bearing = Math.round(((90 - Math.atan2(dy, dx) / DEG) % 360 + 360) % 360);
      parts.push(`${bearing}° bearing`);
      const ref = this.referenceDir();
      if (ref) {
        const l = Math.hypot(dx, dy) || 1;
        const rel = Math.round(Math.acos(Math.max(-1, Math.min(1, (dx * ref.x + dy * ref.y) / l))) / DEG);
        parts.push(rel === 0 ? 'straight on' : `${rel}° turn`);
      }
    }
    const rise = levelZ(plan.endLevel) - levelZ(plan.startLevel);
    if (rise !== 0) parts.push(`grade ${((1.5 * Math.abs(rise)) / Math.max(1, plan.length) * 100).toFixed(1)}%`);
    const lv = plan.endLevel;
    const h = Math.round(lv * LEVEL_STEP * 10) / 10;
    parts.push(lv === 0 ? 'ground' : Number.isInteger(lv) ? `${LEVEL_NAMES[lv]} ${lv > 0 ? '+' : ''}${h} m` : `${h > 0 ? '+' : ''}${h} m (on a slope)`);
    if (this.snapNote) parts.push(`⌖ ${this.snapNote}`);
    return parts.join(' · ');
  }
}
