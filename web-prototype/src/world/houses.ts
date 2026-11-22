// Houses: small player-placed trip makers beside the road, each joined by a short driveway.
import { type Vec2, closestOnPolyline, polyAt } from '../core/math';
import { World, crossSection, HOUSE_PORT_BASE } from './World';
import { planRoad, applyRoad, snapAnchor, type MapBounds, type RoadPlan } from './build';
import { getClass } from './roads';

export const HOUSE_COST = 6000;
/** how far the house stands back from the edge of the road */
const SETBACK = 12;
/** house body size (m), and how far behind the driveway end its centre sits */
export const HOUSE_SIZE = { w: 9, d: 8, h: 4.5, back: 6 };

export interface HousePlan {
  valid: boolean;
  reason?: string;
  cost: number;
  pos: Vec2;
  /** direction from the road towards the house */
  angle: number;
  driveway?: RoadPlan;
}

/** Plan a house beside the road nearest to `p`, on the side `p` is on. */
export function planHouse(world: World, p: Vec2, map: MapBounds, money = Infinity): HousePlan {
  let best: { seg: number; x: number; y: number; s: number; d: number } | null = null;
  for (const s of world.segments.values()) {
    const c = closestOnPolyline(world.poly(s), p);
    if (c.d < 45 && (!best || c.d < best.d)) best = { seg: s.id, x: c.x, y: c.y, s: c.s, d: c.d };
  }
  const none: HousePlan = { valid: false, reason: 'Point beside a street to build a house', cost: HOUSE_COST, pos: p, angle: 0 };
  if (!best) return none;
  const seg = world.seg(best.seg);
  const cls = getClass(seg.cls);
  if (cls.highway) return { ...none, reason: 'Houses need a street, not a highway' };
  if (seg.roundabout) return { ...none, reason: 'Not on a roundabout' };
  if (Math.abs(world.zAt(seg, best.s)) > 0.4) return { ...none, reason: 'Houses go beside roads at ground level' };
  const q = polyAt(world.poly(seg), best.s);
  // the side of the road the cursor is on
  const side = Math.sign(q.tx * (p.y - q.y) - q.ty * (p.x - q.x)) || 1;
  const n = { x: -q.ty * side, y: q.tx * side };
  const off = crossSection(seg).width / 2 + SETBACK;
  const pos = { x: q.x + n.x * off, y: q.y + n.y * off };
  const angle = Math.atan2(n.y, n.x);
  for (const o of world.nodes.values()) {
    if (o.house && Math.hypot(o.x - pos.x, o.y - pos.y) < 16) return { ...none, pos, angle, reason: 'Too close to another house' };
  }
  const end = snapAnchor(world, { x: q.x, y: q.y }, 2);
  const driveway = planRoad(world, { start: { kind: 'free', pos }, end, cls: 'lane', level: 0 }, map);
  const cost = HOUSE_COST + driveway.cost;
  if (!driveway.valid) return { valid: false, reason: driveway.reason, cost, pos, angle, driveway };
  if (cost > money) return { valid: false, reason: 'Not enough money', cost, pos, angle, driveway };
  return { valid: true, cost, pos, angle, driveway };
}

/** Build a planned house; returns its node id. */
export function applyHouse(world: World, plan: HousePlan): number {
  if (!plan.valid || !plan.driveway) throw new Error(plan.reason ?? 'invalid house');
  const ids = applyRoad(world, plan.driveway);
  const node = world.node(world.seg(ids[0]).a);
  node.house = { angle: plan.angle };
  node.port = HOUSE_PORT_BASE + node.id;
  world.touch();
  return node.id;
}

/** Centre of a house's body (for drawing and for clicking it). */
export function houseCentre(n: { x: number; y: number; house?: { angle: number } }): Vec2 {
  const a = n.house?.angle ?? 0;
  return { x: n.x + Math.cos(a) * HOUSE_SIZE.back, y: n.y + Math.sin(a) * HOUSE_SIZE.back };
}

/** Remove a house and its driveway. */
export function removeHouse(world: World, nodeId: number) {
  for (const s of world.segmentsAt(nodeId)) world.removeSegment(s.id);
  world.nodes.delete(nodeId);
  world.touch();
}
