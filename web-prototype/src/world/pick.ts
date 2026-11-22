import { type Vec2, closestOnPolyline, dist } from '../core/math';
import type { World } from './World';
import type { NetGeometry } from './geometry';

/** Segment under a point, preferring the top-most (highest z) road. */
export function pickSegment(world: World, geom: NetGeometry, p: Vec2, slack = 0): { seg: number; along: number; z: number } | null {
  let best: { seg: number; along: number; z: number; score: number } | null = null;
  for (const s of world.segments.values()) {
    const g = geom.segs.get(s.id);
    if (!g) continue;
    const c = closestOnPolyline(g.full, p);
    if (c.d > g.cs.width / 2 + slack) continue;
    const z = world.zAt(s, c.s);
    const score = -z * 10 + c.d;
    if (!best || score < best.score) best = { seg: s.id, along: c.s, z, score };
  }
  return best ? { seg: best.seg, along: best.along, z: best.z } : null;
}

/** Junction node under a point. */
export function pickNode(world: World, geom: NetGeometry, p: Vec2, slack = 2): number | null {
  let best: { id: number; d: number } | null = null;
  for (const n of world.nodes.values()) {
    const ng = geom.nodes.get(n.id);
    if (!ng) continue;
    const r = Math.max(4, ...ng.arms.map((a) => Math.min(a.trim, 30))) + slack;
    const d = dist(n, p);
    if (d < r && (!best || d < best.d)) best = { id: n.id, d };
  }
  return best?.id ?? null;
}
