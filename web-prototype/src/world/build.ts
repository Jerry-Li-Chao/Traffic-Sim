// Road placement planning + application: snapping anchors, crossing detection,
// grade separation checks, cost, and splitting existing roads into junctions.
import {
  type Vec2,
  type Bezier,
  type Polyline,
  quadToCubic,
  straightBezier,
  sampleBezier,
  polyIntersections,
  polyAt,
  closestOnPolyline,
  splitBezier,
  dist,
  dot,
  norm,
  sub,
  minRadius,
  smoothstep,
  angleOf,
  wrapAngle,
  pointInPolygon,
} from '../core/math';
import { World, type WSegment, crossSection, segmentCost, elevationMultiplier } from './World';
import { refreshDefaultControls } from './control';
import { CLEARANCE, MAX_GRADE, getClass, levelZ, LEVEL_STEP, MIN_LEVEL, MAX_LEVEL } from './roads';
import { railHits } from './rail';

export type Anchor =
  | { kind: 'node'; node: number; pos: Vec2 }
  | { kind: 'seg'; seg: number; t: number; along: number; pos: Vec2 }
  | { kind: 'free'; pos: Vec2 };

export interface RoadProposal {
  start: Anchor;
  end: Anchor;
  /** quadratic control point; omitted = straight */
  control?: Vec2;
  cls: string;
  /** level used for free anchors */
  level: number;
  lanesF?: number;
  lanesB?: number;
}

export interface CrossingHit {
  seg: number;
  /** bezier t on the existing segment */
  t: number;
  /** arc length on the new road */
  along: number;
  pos: Vec2;
  level: number;
  /** snap to this existing node instead of splitting */
  node?: number;
}

export interface RoadPlan {
  proposal: RoadProposal;
  valid: boolean;
  reason?: string;
  bezier: Bezier;
  poly: Polyline;
  startLevel: number;
  endLevel: number;
  length: number;
  cost: number;
  hits: CrossingHit[];
  /** level crossings with railways */
  railCrossings: number;
}

export const LEVEL_CROSSING_COST = 6000;

export interface MapBounds {
  width: number;
  height: number;
  /** highways and ramps must cross other roads on a different level */
  gradeSeparated?: boolean;
}

const MIN_PIECE = 8;
const SNAP_NODE_ON_HIT = 10;

/** Bezier parameter t for the arc length `along` on a polyline sampled uniformly in t. */
export function tAtAlong(poly: Polyline, along: number): number {
  const n = poly.cum.length - 1;
  if (n <= 0) return 0;
  for (let i = 0; i < n; i++) {
    if (poly.cum[i + 1] >= along) {
      const seg = poly.cum[i + 1] - poly.cum[i];
      const f = seg > 0 ? (along - poly.cum[i]) / seg : 0;
      return (i + f) / n;
    }
  }
  return 1;
}

/** Height level for a height z: whole levels where flat, fractions part-way up a slope. */
export function fracLevel(z: number): number {
  const lv = Math.round(z / LEVEL_STEP);
  if (Math.abs(z - levelZ(lv)) < 0.05) return lv;
  return Math.round((z / LEVEL_STEP) * 1000) / 1000;
}

/** Would cutting segment `seg` at `along` (height level `lv`) leave either half too steep? */
function splitTooSteep(world: World, seg: number, along: number, lv: number): boolean {
  const s = world.seg(seg);
  const L = world.poly(s).length;
  const za = levelZ(world.node(s.a).level),
    zb = levelZ(world.node(s.b).level),
    zs = levelZ(lv);
  const g1 = (1.5 * Math.abs(zs - za)) / Math.max(1, along),
    g2 = (1.5 * Math.abs(zb - zs)) / Math.max(1, L - along);
  return Math.max(g1, g2) > MAX_GRADE + 1e-6;
}

export function anchorLevel(world: World, a: Anchor, freeLevel: number): number | null {
  if (a.kind === 'node') return world.node(a.node).level;
  if (a.kind === 'seg') {
    // anywhere on a road, slopes included: the junction takes the road's height there
    const z = world.zAt(world.seg(a.seg), a.along);
    return fracLevel(z);
  }
  return freeLevel;
}

/** Find the best anchor for a cursor position. */
export function snapAnchor(
  world: World,
  p: Vec2,
  radius: number,
  opts: { grid?: number; level?: number; exclude?: Set<number> } = {},
): Anchor {
  let bestNode: { id: number; d: number } | null = null;
  for (const n of world.nodes.values()) {
    if (opts.exclude?.has(n.id)) continue;
    const d = dist(n, p);
    const r = radius + (world.degree(n.id) > 0 ? nodeRadius(world, n.id) * 0.6 : 0);
    if (d < r && (!bestNode || d < bestNode.d)) bestNode = { id: n.id, d };
  }
  if (bestNode) {
    const n = world.node(bestNode.id);
    return { kind: 'node', node: n.id, pos: { x: n.x, y: n.y } };
  }
  let bestSeg: { seg: WSegment; along: number; d: number; x: number; y: number; z: number } | null = null;
  for (const s of world.segments.values()) {
    const poly = world.poly(s);
    const c = closestOnPolyline(poly, p);
    const half = crossSection(s).width / 2;
    if (c.d > half + radius * 0.5) continue;
    const z = world.zAt(s, c.s);
    // prefer segments at the requested level when stacked
    const levelPenalty = opts.level !== undefined ? Math.abs(z - levelZ(opts.level)) * 2 : 0;
    const score = c.d + levelPenalty;
    if (!bestSeg || score < bestSeg.d) bestSeg = { seg: s, along: c.s, d: score, x: c.x, y: c.y, z };
  }
  if (bestSeg) {
    const poly = world.poly(bestSeg.seg);
    // Too close to an end: snap to that node instead.
    if (bestSeg.along < SNAP_NODE_ON_HIT) {
      const n = world.node(bestSeg.seg.a);
      return { kind: 'node', node: n.id, pos: { x: n.x, y: n.y } };
    }
    if (bestSeg.along > poly.length - SNAP_NODE_ON_HIT) {
      const n = world.node(bestSeg.seg.b);
      return { kind: 'node', node: n.id, pos: { x: n.x, y: n.y } };
    }
    return {
      kind: 'seg',
      seg: bestSeg.seg.id,
      along: bestSeg.along,
      t: tAtAlong(poly, bestSeg.along),
      pos: { x: bestSeg.x, y: bestSeg.y },
    };
  }
  if (opts.grid) {
    const g = opts.grid;
    return { kind: 'free', pos: { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g } };
  }
  return { kind: 'free', pos: { ...p } };
}

/** Rough radius of the junction area around a node (max half width of attached roads). */
export function nodeRadius(world: World, nodeId: number) {
  let r = 0;
  for (const s of world.segmentsAt(nodeId)) r = Math.max(r, crossSection(s).width / 2);
  return r;
}

export function proposalBezier(p: RoadProposal): Bezier {
  return p.control ? quadToCubic(p.start.pos, p.control, p.end.pos) : straightBezier(p.start.pos, p.end.pos);
}

/** Elevation along the planned road. */
export function planZ(plan: Pick<RoadPlan, 'startLevel' | 'endLevel' | 'length'>, along: number) {
  const za = levelZ(plan.startLevel),
    zb = levelZ(plan.endLevel);
  return za + (zb - za) * smoothstep(Math.min(1, Math.max(0, along / (plan.length || 1))));
}

export function planRoad(world: World, proposal: RoadProposal, map: MapBounds, money = Infinity): RoadPlan {
  const bezier = proposalBezier(proposal);
  const poly = sampleBezier(bezier, 2);
  const length = poly.length;
  const sl = anchorLevel(world, proposal.start, proposal.level);
  const el = anchorLevel(world, proposal.end, proposal.level);
  const plan: RoadPlan = {
    proposal,
    valid: true,
    bezier,
    poly,
    startLevel: sl ?? 0,
    endLevel: el ?? 0,
    length,
    cost: 0,
    hits: [],
    railCrossings: 0,
  };
  const fail = (reason: string) => {
    plan.valid = false;
    plan.reason = plan.reason ?? reason;
    return plan;
  };
  const cls = getClass(proposal.cls);
  // cost estimate even for invalid plans (for the tooltip)
  plan.cost = estimateCost(plan, proposal);

  if (sl === null || el === null) return fail("Can't connect on a slope");
  if (length < MIN_PIECE + 2) return fail('Too short');
  for (const pt of [proposal.start.pos, proposal.end.pos, proposal.control].filter(Boolean) as Vec2[]) {
    if (pt.x < -1 || pt.y < -1 || pt.x > map.width + 1 || pt.y > map.height + 1) return fail('Outside the site');
  }
  if (proposal.start.kind === 'node' && proposal.end.kind === 'node' && proposal.start.node === proposal.end.node)
    return fail('Same start and end');
  if (sl < MIN_LEVEL || sl > MAX_LEVEL || el < MIN_LEVEL || el > MAX_LEVEL) return fail('Invalid height');
  const grade = (1.5 * Math.abs(levelZ(sl) - levelZ(el))) / length;
  if (grade > MAX_GRADE) return fail(`Too steep (${Math.round(grade * 100)}% grade)`);
  if (minRadius(poly) < Math.max(10, cls.laneWidth * (cls.lanesF + cls.lanesB))) return fail('Curve too tight');

  // Already-connected check
  if (proposal.start.kind === 'node' && proposal.end.kind === 'node') {
    const a = proposal.start.node,
      b = proposal.end.node;
    for (const s of world.segments.values()) {
      if ((s.a === a && s.b === b) || (s.a === b && s.b === a)) {
        const mid = polyAt(world.poly(s), world.poly(s).length / 2);
        const mine = polyAt(poly, length / 2);
        if (dist(mid, mine) < 4) return fail('Already connected');
      }
    }
  }

  // Joining angle at anchors.
  for (const [anchor, dir] of [
    [proposal.start, poly2dir(poly, 0)],
    [proposal.end, poly2dir(poly, length)],
  ] as const) {
    if (anchor.kind === 'node') {
      for (const s of world.segmentsAt(anchor.node)) {
        const t = world.tangentFrom(s, anchor.node);
        const ang = Math.abs(wrapAngle(angleOf(t) - angleOf(dir)));
        // highways/ramps may merge at shallow angles; ordinary streets need a proper junction
        const limit = cls.highway && getClass(s.cls).highway ? 4 : 12;
        if (ang < (limit * Math.PI) / 180) return fail('Angle too sharp');
      }
    } else if (anchor.kind === 'seg') {
      const s = world.seg(anchor.seg);
      const p = polyAt(world.poly(s), anchor.along);
      const c = Math.abs(dot(norm({ x: p.tx, y: p.ty }), dir));
      const limit = cls.highway && getClass(s.cls).highway ? 4 : 15;
      if (c > Math.cos((limit * Math.PI) / 180)) return fail('Angle too sharp');
    }
  }

  // Crossings with existing roads.
  const startSeg = proposal.start.kind === 'seg' ? proposal.start.seg : -1;
  const endSeg = proposal.end.kind === 'seg' ? proposal.end.seg : -1;
  const endNodes = new Set<number>();
  if (proposal.start.kind === 'node') endNodes.add(proposal.start.node);
  if (proposal.end.kind === 'node') endNodes.add(proposal.end.node);
  for (const s of world.segments.values()) {
    const spoly = world.poly(s);
    const hits = polyIntersections(poly, spoly);
    for (const h of hits) {
      // Ignore the touching points at our own anchors.
      const nearStart = h.sa < 4,
        nearEnd = h.sa > length - 4;
      if (nearStart && (s.id === startSeg || endNodes.has(s.a) || endNodes.has(s.b))) continue;
      if (nearEnd && (s.id === endSeg || endNodes.has(s.a) || endNodes.has(s.b))) continue;
      if ((nearStart || nearEnd) && (s.id === startSeg || s.id === endSeg)) continue;
      const zNew = planZ(plan, h.sa);
      const zOld = world.zAt(s, h.sb);
      const dz = Math.abs(zNew - zOld);
      if (dz >= CLEARANCE) continue; // grade separated
      if (dz > 0.4) return fail('Not enough clearance');
      const lv = fracLevel(zOld);
      const tOld = polyAt(spoly, h.sb);
      const tNew = polyAt(poly, h.sa);
      const c = Math.abs(tOld.tx * tNew.tx + tOld.ty * tNew.ty);
      if (c > Math.cos((15 * Math.PI) / 180)) return fail('Crossing angle too shallow');
      if (map.gradeSeparated && (cls.highway || getClass(s.cls).highway)) return fail('Highways cross on a bridge or in a tunnel here');
      const hit: CrossingHit = { seg: s.id, t: tAtAlong(spoly, h.sb), along: h.sa, pos: { x: h.x, y: h.y }, level: lv };
      if (h.sb < SNAP_NODE_ON_HIT) hit.node = s.a;
      else if (h.sb > spoly.length - SNAP_NODE_ON_HIT) hit.node = s.b;
      if (hit.node !== undefined && endNodes.has(hit.node)) continue;
      plan.hits.push(hit);
    }
  }
  plan.hits.sort((a, b) => a.along - b.along);
  // merge hits snapping to the same node
  plan.hits = plan.hits.filter((h, i, arr) => !(h.node !== undefined && arr.findIndex((o) => o.node === h.node) !== i));
  let prev = 0;
  for (const h of plan.hits) {
    if (h.along - prev < MIN_PIECE) return fail('Too close to another junction');
    prev = h.along;
  }
  if (length - prev < MIN_PIECE) return fail('Too close to another junction');
  // joining a slope cuts it in two: neither half may end up too steep, and neither may our road
  for (const a of [proposal.start, proposal.end]) {
    if (a.kind === 'seg' && splitTooSteep(world, a.seg, a.along, anchorLevel(world, a, 0)!)) return fail('The slope is too steep to join here');
  }
  for (const h of plan.hits) {
    if (h.node === undefined && splitTooSteep(world, h.seg, closestAlong(world, h.seg, h.pos), h.level)) return fail('The slope is too steep to join here');
  }
  {
    const chain = [{ along: 0, lv: sl }, ...plan.hits.map((h) => ({ along: h.along, lv: h.node !== undefined ? world.node(h.node).level : h.level })), { along: length, lv: el }];
    for (let i = 0; i + 1 < chain.length; i++) {
      const g = (1.5 * Math.abs(levelZ(chain[i + 1].lv) - levelZ(chain[i].lv))) / Math.max(1, chain[i + 1].along - chain[i].along);
      if (g > MAX_GRADE + 1e-6) return fail(`Too steep (${Math.round(g * 100)}% grade)`);
    }
  }
  // Junction spacing on the existing roads we split.
  for (const a of [proposal.start, proposal.end]) {
    if (a.kind === 'seg') {
      const sp = world.poly(world.seg(a.seg));
      if (a.along < MIN_PIECE || sp.length - a.along < MIN_PIECE) return fail('Too close to another junction');
    }
  }
  // Railways: level crossings (same height) or grade separation; nothing in between.
  const rail = railHits(world, poly, (a) => planZ(plan, a));
  if (rail.clash) return fail('Not enough clearance over the railway');
  for (const h of rail.same) {
    if (h.cos > Math.cos((20 * Math.PI) / 180)) return fail('Crossing the railway too shallow');
    if (h.along < 12 || h.along > length - 12) return fail('Too close to the railway');
    if (plan.hits.some((x) => Math.abs(x.along - h.along) < 15)) return fail('Junction too close to the railway');
  }
  plan.railCrossings = rail.same.length;
  // Rivers and built-up areas: only bridges (z >= 5) or tunnels (z <= -9) may pass
  if (world.obstacles.length) {
    for (let a = 0; a <= length; a += 2) {
      const p = polyAt(poly, a);
      const z = planZ(plan, a);
      if (z >= 5 || z <= -9) continue;
      for (const o of world.obstacles) {
        if (pointInPolygon(p, o.pts.map(([x, y]) => ({ x, y })))) return fail(o.kind === 'water' ? 'Needs a bridge over the water' : 'Cannot build through the town');
      }
    }
  }
  plan.cost += rail.same.length * LEVEL_CROSSING_COST;
  if (plan.cost > money) return fail('Not enough money');
  return plan;
}

function closestAlong(world: World, seg: number, p: Vec2) {
  return closestOnPolyline(world.poly(world.seg(seg)), p).s;
}

function poly2dir(poly: Polyline, along: number) {
  const a = polyAt(poly, Math.min(poly.length, Math.max(0, along)));
  return along <= 0 ? { x: a.tx, y: a.ty } : { x: -a.tx, y: -a.ty };
}

function estimateCost(plan: RoadPlan, p: RoadProposal) {
  const c = getClass(p.cls);
  const n = Math.max(2, Math.ceil(plan.length / 5));
  let mult = 0;
  for (let i = 0; i < n; i++) mult += elevationMultiplier(planZ(plan, ((i + 0.5) / n) * plan.length));
  const lanes = (p.lanesF ?? c.lanesF) + (p.lanesB ?? c.lanesB);
  const lf = lanes / Math.max(1, c.lanesF + c.lanesB);
  return Math.round(c.costPerM * plan.length * (mult / n) * (0.4 + 0.6 * lf));
}

/** Split a segment at several bezier parameters; returns the created node ids in order of t. */
export function splitMany(world: World, segId: number, ts: number[], levels?: number[]): number[] {
  const order = ts.map((t, i) => ({ t, i })).sort((a, b) => b.t - a.t);
  const out: number[] = new Array(ts.length);
  let current = segId;
  let rangeEnd = 1;
  for (const { t, i } of order) {
    const local = t / rangeEnd;
    const r = world.splitSegmentEx(current, local, levels?.[i]);
    out[i] = r.node.id;
    current = r.left.id;
    rangeEnd = t;
  }
  return out;
}

/** Apply a valid plan to the world. Returns ids of the new segments. */
export function applyRoad(world: World, plan: RoadPlan): number[] {
  if (!plan.valid) throw new Error('invalid plan: ' + plan.reason);
  const p = plan.proposal;

  // 1) group split operations by existing segment (anchors + crossing hits)
  const splits = new Map<number, { t: number; key: string; level: number }[]>();
  const addSplit = (seg: number, t: number, key: string, level: number) => {
    if (!splits.has(seg)) splits.set(seg, []);
    splits.get(seg)!.push({ t, key, level });
  };
  if (p.start.kind === 'seg') addSplit(p.start.seg, p.start.t, 'start', plan.startLevel);
  if (p.end.kind === 'seg') addSplit(p.end.seg, p.end.t, 'end', plan.endLevel);
  plan.hits.forEach((h, i) => {
    if (h.node === undefined) addSplit(h.seg, h.t, `hit${i}`, h.level);
  });
  const nodeFor = new Map<string, number>();
  for (const [seg, list] of splits) {
    const ids = splitMany(
      world,
      seg,
      list.map((l) => l.t),
      list.map((l) => l.level),
    );
    list.forEach((l, i) => nodeFor.set(l.key, ids[i]));
  }

  const resolve = (a: Anchor, key: string, level: number): number => {
    if (a.kind === 'node') return a.node;
    if (a.kind === 'seg') return nodeFor.get(key)!;
    return world.addNode(a.pos.x, a.pos.y, level).id;
  };
  const startNode = resolve(p.start, 'start', plan.startLevel);
  const endNode = resolve(p.end, 'end', plan.endLevel);
  const chain: { node: number; along: number }[] = [{ node: startNode, along: 0 }];
  plan.hits.forEach((h, i) => chain.push({ node: h.node ?? nodeFor.get(`hit${i}`)!, along: h.along }));
  chain.push({ node: endNode, along: plan.length });

  // 2) cut the new bezier into pieces between consecutive chain nodes
  const created: number[] = [];
  let rest = plan.bezier;
  let restStartT = 0;
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i],
      b = chain[i + 1];
    let piece: Bezier;
    if (i === chain.length - 2) piece = rest;
    else {
      const tGlobal = tAtAlong(plan.poly, b.along);
      const local = (tGlobal - restStartT) / (1 - restStartT);
      const [l, r] = splitBezier(rest, local);
      piece = l;
      rest = r;
      restStartT = tGlobal;
    }
    const na = world.node(a.node),
      nb = world.node(b.node);
    // keep inner control points but snap shape to exact node positions
    const dA = sub(na, piece.p0),
      dB = sub(nb, piece.p3);
    const seg = world.addSegment(
      a.node,
      b.node,
      { c1: { x: piece.p1.x + dA.x, y: piece.p1.y + dA.y }, c2: { x: piece.p2.x + dB.x, y: piece.p2.y + dB.y } },
      p.cls,
      { ...(p.lanesF !== undefined ? { lanesF: p.lanesF } : {}), ...(p.lanesB !== undefined ? { lanesB: p.lanesB } : {}) },
    );
    seg.cost = segmentCost(world, seg);
    created.push(seg.id);
  }
  refreshDefaultControls(world);
  return created;
}

export const levelLabel = (lv: number) => (lv === 0 ? 'Ground' : lv > 0 ? `+${lv}` : `${lv}`);
