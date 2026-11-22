import type { Tool, ToolContext } from './Tool';
import type { PointerInfo } from '../game/Input';
import { pickSegment } from '../world/pick';
import { setUI, toast } from '../game/store';
import { type Vec2, subPolyline } from '../core/math';
import { splitMany, tAtAlong } from '../world/build';
import type { World } from '../world/World';
import { houseCentre, removeHouse, HOUSE_COST } from '../world/houses';

export const REFUND = 0.75;
/** Long roads are demolished in sections of about this length. */
export const PIECE_LENGTH = 50;

/** A drawn bulldozer (blade at the hot spot), shown while the button is held. */
const DOZER_CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='36' height='36' viewBox='0 0 36 36'>
    <rect x='2' y='10' width='4' height='17' rx='1' fill='#8a8f96' stroke='#3a3d42' stroke-width='1.2'/>
    <rect x='6' y='16' width='5' height='4' fill='#3a3d42'/>
    <rect x='11' y='13' width='18' height='11' rx='2' fill='#f2b21b' stroke='#3a3d42' stroke-width='1.2'/>
    <rect x='19' y='6' width='9' height='8' rx='1.5' fill='#f2b21b' stroke='#3a3d42' stroke-width='1.2'/>
    <rect x='21' y='8' width='5' height='4' fill='#bfe3f5'/>
    <rect x='10' y='24' width='21' height='6' rx='3' fill='#3a3d42'/>
    <circle cx='13.5' cy='27' r='1.6' fill='#8a8f96'/><circle cx='27.5' cy='27' r='1.6' fill='#8a8f96'/>
  </svg>`,
)}") 4 18, crosshair`;

/** The demolition section of segment `seg` around arc length `along` (k of n equal sections). */
export function pieceAt(world: World, seg: number, along: number): { s0: number; s1: number; k: number; n: number } {
  const s = world.seg(seg);
  const L = world.poly(s).length;
  // ramps (height changes) and short roads go in one piece
  if (world.node(s.a).level !== world.node(s.b).level || L <= PIECE_LENGTH * 1.5) return { s0: 0, s1: L, k: 0, n: 1 };
  const n = Math.max(2, Math.round(L / PIECE_LENGTH));
  const len = L / n;
  const k = Math.max(0, Math.min(n - 1, Math.floor(along / len)));
  return { s0: k * len, s1: (k + 1) * len, k, n };
}

/** Share of the segment's build cost that the section around `along` accounts for. */
export function pieceCost(world: World, seg: number, along: number): number {
  const s = world.seg(seg);
  const piece = pieceAt(world, seg, along);
  return ((s.cost ?? 0) * (piece.s1 - piece.s0)) / (world.poly(s).length || 1);
}

/** Cut out and remove the demolition section of `seg` around `along`. */
export function removePiece(world: World, seg: number, along: number) {
  const s = world.seg(seg);
  const piece = pieceAt(world, seg, along);
  if (piece.n === 1) {
    world.removeSegment(seg);
    return;
  }
  const poly = world.poly(s);
  const level = world.node(s.a).level;
  const ts: number[] = [];
  if (piece.k > 0) ts.push(tAtAlong(poly, piece.s0));
  if (piece.k < piece.n - 1) ts.push(tAtAlong(poly, piece.s1));
  const a = s.a,
    b = s.b;
  const ids = splitMany(
    world,
    seg,
    ts,
    ts.map(() => level),
  );
  const left = piece.k > 0 ? ids[0] : a;
  const right = piece.k < piece.n - 1 ? ids[ids.length - 1] : b;
  const mid = world.segmentsAt(left).find((x) => world.otherEnd(x, left) === right);
  if (mid) world.removeSegment(mid.id);
}

/**
 * Remove roads one section (~50 m) at a time, refunding part of their cost. Hold the button and
 * sweep across roads to bulldoze everything the cursor touches; one sweep is one undo step.
 */
export class BulldozeTool implements Tool {
  id = 'bulldoze';
  hover: { seg: number; along: number } | null = null;
  private cursor: PointerInfo | null = null;
  /** sweeping with the button held */
  private sweeping = false;
  private sweepCount = 0;
  private last: Vec2 | null = null;
  constructor(private ctx: ToolContext) {}

  activate() {
    this.ctx.setCursor('crosshair');
  }

  deactivate() {
    this.ctx.overlay.clear('hover');
    this.hover = null;
    this.endSweep();
    this.ctx.setCursor(null);
    setUI({ hover: null });
  }

  refresh() {
    if (this.cursor) this.highlight(this.cursor.world);
  }

  private highlight(p: Vec2) {
    const house = this.houseAt(p);
    if (house !== null) {
      const n = this.ctx.world.node(house);
      const c = houseCentre(n);
      this.ctx.overlay.ribbons('hover', [{ line: { pts: [c.x - 5, c.y, c.x + 5, c.y], cum: [0, 10], length: 10 }, halfWidth: 5, color: '#c0392b', opacity: 0.5, z: [5] }]);
      setUI({ hover: this.sweeping ? 'Bulldozing… release to stop' : `Remove house · refund $${Math.round(HOUSE_COST * REFUND)}` });
      return;
    }
    const hit = pickSegment(this.ctx.world, this.ctx.geom, p, 2);
    this.hover = hit ? { seg: hit.seg, along: hit.along } : null;
    if (!hit) {
      this.ctx.overlay.clear('hover');
      setUI({ hover: this.sweeping ? 'Bulldozing… release to stop' : null });
      return;
    }
    const w = this.ctx.world;
    const s = w.seg(hit.seg);
    const g = this.ctx.geom.segs.get(hit.seg)!;
    const piece = pieceAt(w, hit.seg, hit.along);
    // highlight just the section that will go, at its own height
    const a = Math.max(piece.s0, g.s0),
      b = Math.min(piece.s1, g.s1);
    const line = subPolyline(w.poly(s), a, Math.max(a + 0.5, b));
    const z = line.cum.map((c) => w.zAt(s, a + c));
    this.ctx.overlay.ribbons('hover', [{ line, z, halfWidth: g.cs.width / 2 + 0.5, color: s.locked ? '#888888' : '#c0392b', opacity: 0.5 }]);
    setUI({
      hover: s.locked
        ? 'Fixed road — cannot be removed'
        : this.sweeping
          ? 'Bulldozing… release to stop'
          : `Remove · refund $${Math.round(pieceCost(w, hit.seg, hit.along) * REFUND)} · hold and drag to clear more`,
    });
  }

  /** House whose body is under p, if any. */
  private houseAt(p: Vec2): number | null {
    for (const n of this.ctx.world.nodes.values()) {
      if (!n.house) continue;
      const c = houseCentre(n);
      if (Math.hypot(c.x - p.x, c.y - p.y) < 6) return n.id;
    }
    return null;
  }

  /** Bulldoze the house or road section under p (fixed site roads are skipped). */
  private dozeAt(p: Vec2, explain: boolean) {
    const w = this.ctx.world;
    const house = this.houseAt(p);
    if (house !== null) {
      const refund = Math.round((HOUSE_COST + w.segmentsAt(house).reduce((a, s) => a + (s.cost ?? 0), 0)) * REFUND);
      if (this.ctx.commit('Bulldoze', -refund, () => removeHouse(w, house), { merge: this.sweepCount > 0 })) this.sweepCount++;
      return;
    }
    const hit = pickSegment(w, this.ctx.geom, p, 2);
    if (!hit) return;
    if (w.seg(hit.seg).locked) {
      if (explain) toast('This road is part of the site and cannot be removed', 'warn');
      return;
    }
    const refund = Math.round(pieceCost(w, hit.seg, hit.along) * REFUND);
    const ok = this.ctx.commit('Bulldoze', -refund, () => removePiece(w, hit.seg, hit.along), { merge: this.sweepCount > 0 });
    if (ok) this.sweepCount++;
  }

  onMove(p: PointerInfo) {
    this.cursor = p;
    if (this.sweeping && this.last) {
      // sample the path since the last event so fast sweeps don't skip roads
      const dx = p.world.x - this.last.x,
        dy = p.world.y - this.last.y;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 3));
      for (let i = 1; i <= steps; i++) this.dozeAt({ x: this.last.x + (dx * i) / steps, y: this.last.y + (dy * i) / steps }, false);
      this.last = { ...p.world };
    }
    this.highlight(p.world);
  }

  onDown(p: PointerInfo) {
    if (p.button !== 0) return false;
    this.sweeping = true;
    this.sweepCount = 0;
    this.last = { ...p.world };
    this.ctx.setCursor(DOZER_CURSOR);
    this.dozeAt(p.world, true);
    this.highlight(p.world);
    // always take the drag (no camera pan), so a sweep can start off the road
    return true;
  }

  onUp() {
    this.endSweep();
    if (this.cursor) this.highlight(this.cursor.world);
  }

  onCancel() {
    const busy = this.sweeping;
    this.endSweep();
    return busy;
  }

  private endSweep() {
    if (this.sweeping && this.sweepCount > 1) toast(`Bulldozed ${this.sweepCount} road sections · ⌘Z undoes the whole sweep`);
    this.sweeping = false;
    this.sweepCount = 0;
    this.last = null;
    this.ctx.setCursor('crosshair');
  }
}
