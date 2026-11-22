import type { Tool, ToolContext } from './Tool';
import type { PointerInfo } from '../game/Input';
import { planRoundabout, applyRoundabout, type RoundaboutPlan } from '../world/roundabout';
import { setUI, toast } from '../game/store';
import { type Vec2, makePolyline, closestOnPolyline } from '../core/math';
import { pickNode } from '../world/pick';
import { levelZ, LEVEL_NAMES, LEVEL_STEP, MIN_LEVEL, MAX_LEVEL } from '../world/roads';

export const ROUNDABOUT_SIZES = [
  { id: 'small', label: 'Small', radius: 16, cls: 'roundabout' },
  { id: 'medium', label: 'Medium', radius: 24, cls: 'roundabout' },
  { id: 'large', label: 'Large 2-lane', radius: 32, cls: 'roundabout2' },
];

/**
 * Click to drop a roundabout; existing roads crossing the circle become its legs.
 * It is built at the height of the road under the cursor (a bridge, a cutting ...), and the
 * roads it will join are highlighted. L cycles between the levels stacked under the cursor.
 */
export class RoundaboutTool implements Tool {
  id = 'roundabout';
  size = 1;
  private cursor: PointerInfo | null = null;
  /** index into the levels found under the cursor (L to cycle) */
  private levelPick = 0;
  constructor(private ctx: ToolContext) {}

  deactivate() {
    this.ctx.overlay.clear('ghost');
    this.ctx.overlay.clear('ghost-legs');
    setUI({ ghostInfo: null });
  }
  refresh() {
    if (this.cursor) this.onMove(this.cursor);
  }

  /** Height levels of the roads under the cursor, top-most first (always includes ground). */
  private levelsAt(p: Vec2): number[] {
    const found = new Set<number>();
    for (const s of this.ctx.world.segments.values()) {
      if (s.roundabout) continue;
      const g = this.ctx.geom.segs.get(s.id);
      if (!g) continue;
      const c = closestOnPolyline(g.full, p);
      if (c.d > g.cs.width / 2 + 3) continue;
      const z = this.ctx.world.zAt(s, c.s);
      found.add(Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(z / LEVEL_STEP))));
    }
    found.add(0);
    return [...found].sort((a, b) => b - a);
  }

  private level(p: Vec2) {
    const levels = this.levelsAt(p);
    return levels[this.levelPick % levels.length];
  }

  private center(p: Vec2, level: number) {
    // snap to an existing junction at this height when hovering one
    const n = pickNode(this.ctx.world, this.ctx.geom, p, 4);
    if (n !== null) {
      const node = this.ctx.world.node(n);
      if (node.level === level) return { x: node.x, y: node.y };
    }
    return p;
  }

  private plan(p: PointerInfo): { plan: RoundaboutPlan; level: number } {
    const sz = ROUNDABOUT_SIZES[this.size];
    const level = this.level(p.world);
    const plan = planRoundabout(this.ctx.world, this.center(p.world, level), sz.radius, sz.cls, this.ctx.map, level, this.ctx.unlimited() ? Infinity : this.ctx.money());
    return { plan, level };
  }

  onMove(p: PointerInfo) {
    // moving to a different spot starts again from the top-most road
    if (this.cursor && Math.hypot(p.world.x - this.cursor.world.x, p.world.y - this.cursor.world.y) > 40) this.levelPick = 0;
    this.cursor = p;
    const { plan, level } = this.plan(p);
    const z = levelZ(level);
    const ring = makePolyline(Array.from({ length: 65 }, (_, i) => ({ x: plan.center.x + plan.radius * Math.cos((i / 64) * Math.PI * 2), y: plan.center.y + plan.radius * Math.sin((i / 64) * Math.PI * 2) })));
    this.ctx.overlay.ribbons('ghost', [{ line: ring, halfWidth: ROUNDABOUT_SIZES[this.size].cls === 'roundabout2' ? 5 : 3.2, color: plan.valid ? '#3f9b5f' : '#c0392b', opacity: 0.5, z: [z + 0.4] }]);
    // highlight the roads (at this height) that will become the roundabout's legs
    const seen = new Set<number>();
    const legs = plan.legs
      .filter((l) => !seen.has(l.seg) && seen.add(l.seg))
      .map((l) => {
        const g = this.ctx.geom.segs.get(l.seg)!;
        return { line: g.center, halfWidth: g.cs.width / 2 + 0.8, color: '#7cc4ff', opacity: 0.35, z: g.z.map((v) => v + 0.3) };
      });
    this.ctx.overlay.ribbons('ghost-legs', legs);
    const where = level === 0 ? '' : `${LEVEL_NAMES[level]} · `;
    const stacked = this.levelsAt(p.world).length > 1 ? ' · L: change level' : '';
    setUI({ ghostInfo: { cost: plan.cost, length: 2 * Math.PI * plan.radius, valid: plan.valid, reason: plan.reason ?? `${where}${plan.legs.length} legs · [ smaller · ] larger${stacked}` } });
  }

  onDown(p: PointerInfo) {
    if (p.button !== 0) return false;
    const { plan, level } = this.plan(p);
    if (!plan.valid) {
      toast(plan.reason ?? 'Cannot place roundabout here', 'warn');
      return true;
    }
    this.ctx.commit('Build roundabout', plan.cost, () => {
      applyRoundabout(this.ctx.world, plan, level);
    });
    this.onMove(p);
    return true;
  }

  onKey(k: string) {
    if (k === '[' || k === '-') {
      this.size = Math.max(0, this.size - 1);
      setUI({ hover: ROUNDABOUT_SIZES[this.size].label });
      this.refresh();
      return true;
    }
    if (k === ']' || k === '=' || k === '+') {
      this.size = Math.min(ROUNDABOUT_SIZES.length - 1, this.size + 1);
      setUI({ hover: ROUNDABOUT_SIZES[this.size].label });
      this.refresh();
      return true;
    }
    if (k === 'l' || k === 'L') {
      this.levelPick++;
      this.refresh();
      return true;
    }
    return false;
  }
}
