// Roundabout placement: cut roads at a circle, remove what is inside, and build a one-way ring.
import { type Vec2, polyIntersections, makePolyline, dist, wrapAngle } from '../core/math';
import { World, segmentCost } from './World';
import { splitMany, tAtAlong, type MapBounds } from './build';
import { getClass, levelZ } from './roads';

export interface RoundaboutPlan {
  valid: boolean;
  reason?: string;
  center: Vec2;
  radius: number;
  cls: string;
  /** points where existing roads meet the ring */
  legs: { seg: number; t: number; pos: Vec2; angle: number }[];
  cost: number;
}

const circle = (c: Vec2, r: number, n = 72) => makePolyline(Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + r * Math.cos((i / n) * Math.PI * 2), y: c.y + r * Math.sin((i / n) * Math.PI * 2) })));

export function planRoundabout(world: World, center: Vec2, radius: number, cls: string, map: MapBounds, level = 0, money = Infinity): RoundaboutPlan {
  const plan: RoundaboutPlan = { valid: true, center, radius, cls, legs: [], cost: 0 };
  const fail = (r: string) => {
    plan.valid = false;
    plan.reason = plan.reason ?? r;
    return plan;
  };
  const ring = circle(center, radius);
  plan.cost = Math.round(getClass(cls).costPerM * 2 * Math.PI * radius * (level === 0 ? 1 : 2.5));
  if (center.x - radius < 5 || center.y - radius < 5 || center.x + radius > map.width - 5 || center.y + radius > map.height - 5) return fail('Outside the site');
  const z = levelZ(level);
  for (const s of world.segments.values()) {
    const poly = world.poly(s);
    for (const h of polyIntersections(poly, ring)) {
      const zz = world.zAt(s, h.sa);
      if (Math.abs(zz - z) >= 5) continue; // passes over/under
      if (Math.abs(zz - z) > 0.4) return fail('A road crosses on a slope');
      if (h.sa < 6 || h.sa > poly.length - 6) {
        // touching an existing node exactly on the ring: use it as a leg if it lies on the circle
        const nodeId = h.sa < 6 ? s.a : s.b;
        const n = world.node(nodeId);
        if (Math.abs(dist(n, center) - radius) > 6) return fail('Too close to another junction');
      }
      const ang = Math.atan2(h.y - center.y, h.x - center.x);
      plan.legs.push({ seg: s.id, t: tAtAlong(poly, h.sa), pos: { x: h.x, y: h.y }, angle: ang });
    }
  }
  // ports / locked nodes inside the circle cannot be removed
  for (const n of world.nodes.values()) {
    if (dist(n, center) < radius - 1 && (n.port !== undefined || world.segmentsAt(n.id).some((s) => s.locked))) return fail('Fixed road inside the roundabout');
  }
  plan.legs.sort((a, b) => a.angle - b.angle);
  for (let i = 0; i < plan.legs.length; i++) {
    const a = plan.legs[i],
      b = plan.legs[(i + 1) % plan.legs.length];
    if (plan.legs.length > 1) {
      let gap = b.angle - a.angle;
      if (gap <= 0) gap += Math.PI * 2;
      if (gap < (28 * Math.PI) / 180) return fail('Roads meet the ring too close together');
    }
  }
  if (plan.cost > money) return fail('Not enough money');
  return plan;
}

/** Apply a roundabout plan. Returns ring segment ids. */
export function applyRoundabout(world: World, plan: RoundaboutPlan, level = 0): number[] {
  const { center, radius } = plan;
  // 1) split crossing roads at the ring
  const bySeg = new Map<number, number[]>();
  for (const l of plan.legs) {
    if (!bySeg.has(l.seg)) bySeg.set(l.seg, []);
    bySeg.get(l.seg)!.push(l.t);
  }
  const legNodes: number[] = [];
  for (const [seg, ts] of bySeg) {
    const poly = world.poly(world.seg(seg));
    // reuse end nodes that already sit on the ring
    const inner = ts.filter((t) => t * poly.length > 6 && t * poly.length < poly.length - 6);
    for (const t of ts) {
      if (t * poly.length <= 6) legNodes.push(world.seg(seg).a);
      else if (t * poly.length >= poly.length - 6) legNodes.push(world.seg(seg).b);
    }
    if (inner.length) legNodes.push(...splitMany(world, seg, inner, inner.map(() => level)));
  }
  // 2) remove everything inside the circle
  for (const s of [...world.segments.values()]) {
    const poly = world.poly(s);
    const mid = { x: poly.pts[Math.floor(poly.pts.length / 4) * 2], y: poly.pts[Math.floor(poly.pts.length / 4) * 2 + 1] };
    const m2 = world.bezier(s);
    const midPt = { x: (m2.p0.x + 3 * m2.p1.x + 3 * m2.p2.x + m2.p3.x) / 8, y: (m2.p0.y + 3 * m2.p1.y + 3 * m2.p2.y + m2.p3.y) / 8 };
    void mid;
    if (dist(midPt, center) < radius - 0.5 && Math.abs(world.zAt(s, poly.length / 2) - levelZ(level)) < 5) world.removeSegment(s.id);
  }
  // 3) ring nodes: legs + fillers so arcs are <= 60°
  const nodes = [...new Set(legNodes)].filter((id) => world.nodes.has(id)).map((id) => {
    const n = world.node(id);
    // snap leg nodes exactly onto the circle
    const a = Math.atan2(n.y - center.y, n.x - center.x);
    n.x = center.x + Math.cos(a) * radius;
    n.y = center.y + Math.sin(a) * radius;
    return { id, angle: a };
  });
  nodes.sort((a, b) => a.angle - b.angle);
  const all: { id: number; angle: number }[] = [];
  const maxArc = (60 * Math.PI) / 180;
  if (nodes.length === 0) {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      all.push({ id: world.addNode(center.x + Math.cos(a) * radius, center.y + Math.sin(a) * radius, level).id, angle: a });
    }
  } else {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i],
        b = nodes[(i + 1) % nodes.length];
      all.push(a);
      let gap = wrapAngle(b.angle - a.angle);
      if (gap <= 0) gap += Math.PI * 2;
      if (nodes.length === 1) gap = Math.PI * 2;
      const extra = Math.ceil(gap / maxArc) - 1;
      for (let k = 1; k <= extra; k++) {
        const ang = a.angle + (gap * k) / (extra + 1);
        all.push({ id: world.addNode(center.x + Math.cos(ang) * radius, center.y + Math.sin(ang) * radius, level).id, angle: ang });
      }
    }
  }
  // 4) counter-clockwise one-way ring (right-hand traffic)
  const ids: number[] = [];
  for (let i = 0; i < all.length; i++) {
    const a = all[i],
      b = all[(i + 1) % all.length];
    let d = b.angle - a.angle;
    while (d <= 0) d += Math.PI * 2;
    const k = (4 / 3) * Math.tan(d / 4) * radius;
    const pa = world.node(a.id),
      pb = world.node(b.id);
    const ta = { x: -Math.sin(a.angle), y: Math.cos(a.angle) };
    const tb = { x: -Math.sin(a.angle + d), y: Math.cos(a.angle + d) };
    const seg = world.addSegment(a.id, b.id, { c1: { x: pa.x + ta.x * k, y: pa.y + ta.y * k }, c2: { x: pb.x - tb.x * k, y: pb.y - tb.y * k } }, plan.cls, { roundabout: true });
    seg.cost = segmentCost(world, seg);
    ids.push(seg.id);
  }
  // leg segments: re-straighten their inner control points toward the new node positions
  for (const id of legNodes) {
    if (!world.nodes.has(id)) continue;
    for (const s of world.segmentsAt(id)) {
      if (s.roundabout) continue;
      const other = world.node(world.otherEnd(s, id));
      const n = world.node(id);
      // keep the far control point, pull the near one onto the radial direction
      const radial = { x: (n.x - center.x) / radius, y: (n.y - center.y) / radius };
      const L = dist(n, other);
      const near = { x: n.x + radial.x * L * 0.33, y: n.y + radial.y * L * 0.33 };
      if (s.a === id) s.c1 = near;
      else s.c2 = near;
    }
  }
  world.touch();
  return ids;
}
