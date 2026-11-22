// Lane-level topology: directional lanes and junction connectors (default turn rules + overrides).
import {
  type Vec2,
  type Bezier,
  type Polyline,
  offsetPolyline,
  reversePolyline,
  polyAt,
  sampleBezier,
  quadToCubic,
  angleOf,
  wrapAngle,
  dist,
  add,
  scale,
  sub,
} from '../core/math';
import type { World, WSegment } from './World';
import type { NetGeometry } from './geometry';

export type Dir = 'f' | 'b';
export type Turn = 'R' | 'S' | 'L' | 'U';

export interface LaneRef {
  seg: number;
  dir: Dir;
  idx: number; // 0 = outer (right-most) lane in travel direction
}

export const laneKey = (r: LaneRef) => `${r.seg}:${r.dir}:${r.idx}`;
/** node-local key used by overrides: seg + lane index */
export const nodeLaneKey = (seg: number, idx: number) => `${seg}:${idx}`;

export interface LaneGeom {
  ref: LaneRef;
  poly: Polyline;
  z: number[];
  /** node where the lane ends / starts */
  endNode: number;
  startNode: number;
}

export interface Connector {
  node: number;
  from: LaneRef;
  to: LaneRef;
  turn: Turn;
  bezier: Bezier;
  poly: Polyline;
  z: number;
  /** seamless joint: lanes continue directly, zero-length */
  direct: boolean;
}

export interface Approach {
  seg: number;
  /** travel direction of lanes arriving at node */
  inDir: Dir | null;
  inLanes: number;
  outDir: Dir | null;
  outLanes: number;
  /** unit direction pointing away from the node */
  away: Vec2;
}

export function approaches(world: World, nodeId: number): Approach[] {
  return world.segmentsAt(nodeId).map((s) => {
    const atB = s.b === nodeId;
    return {
      seg: s.id,
      inDir: atB ? (s.lanesF > 0 ? 'f' : null) : s.lanesB > 0 ? 'b' : null,
      inLanes: atB ? s.lanesF : s.lanesB,
      outDir: atB ? (s.lanesB > 0 ? 'b' : null) : s.lanesF > 0 ? 'f' : null,
      outLanes: atB ? s.lanesB : s.lanesF,
      away: world.tangentFrom(s, nodeId),
    };
  });
}

/** Geometry of one directional lane between the trimmed ends of its segment. */
export function laneGeometry(world: World, geom: NetGeometry, ref: LaneRef): LaneGeom {
  const s = world.seg(ref.seg);
  const g = geom.segs.get(ref.seg)!;
  const off = ref.dir === 'f' ? g.cs.fwdOffset(ref.idx) : g.cs.bwdOffset(ref.idx);
  let poly = offsetPolyline(g.center, off);
  let z = g.z.slice();
  if (ref.dir === 'b') {
    poly = reversePolyline(poly);
    z = z.reverse();
  }
  return { ref, poly, z, startNode: ref.dir === 'f' ? s.a : s.b, endNode: ref.dir === 'f' ? s.b : s.a };
}

function laneEnd(world: World, geom: NetGeometry, seg: WSegment, dir: Dir, idx: number, atEnd: boolean) {
  const lg = laneGeometry(world, geom, { seg: seg.id, dir, idx });
  const p = polyAt(lg.poly, atEnd ? lg.poly.length : 0);
  return { pos: { x: p.x, y: p.y }, dir: { x: p.tx, y: p.ty }, z: atEnd ? lg.z[lg.z.length - 1] : lg.z[0] };
}

function connectorCurve(p0: Vec2, d0: Vec2, p3: Vec2, d3: Vec2): Bezier {
  const D = dist(p0, p3);
  // Try tangent-line intersection for a clean quadratic arc.
  const den = d0.x * d3.y - d0.y * d3.x;
  if (Math.abs(den) > 0.05) {
    const w = sub(p3, p0);
    const s = (w.x * d3.y - w.y * d3.x) / den;
    const t = -(w.x * d0.y - w.y * d0.x) / den;
    if (s > 0.5 && t > 0.5 && s < D * 2 && t < D * 2) {
      return quadToCubic(p0, add(p0, scale(d0, s)), p3);
    }
  }
  const k = D * 0.4;
  return { p0, p1: add(p0, scale(d0, k)), p2: sub(p3, scale(d3, k)), p3 };
}

function classify(theta: number, u: boolean): Turn {
  if (u) return 'U';
  const deg = (theta * 180) / Math.PI;
  if (deg < -35) return 'R';
  if (deg > 35) return 'L';
  return 'S';
}

/** Default lane -> exit assignment for one approach. Returns per lane the list of (exitIdx, outLane). */
export function defaultLaneMap(
  nIn: number,
  exits: { turn: Turn; theta: number; outLanes: number; idx: number }[],
): { lane: number; exit: number; outLane: number }[] {
  const res: { lane: number; exit: number; outLane: number }[] = [];
  if (nIn === 0 || exits.length === 0) return res;
  const sorted = [...exits].sort((a, b) => a.theta - b.theta); // right-most first
  const S = sorted.filter((e) => e.turn === 'S');
  const R = sorted.filter((e) => e.turn === 'R');
  const L = sorted.filter((e) => e.turn === 'L');
  const U = sorted.filter((e) => e.turn === 'U');
  // lane ranges per exit (inclusive start, exclusive end)
  const ranges = new Map<number, [number, number]>();
  const partition = (group: typeof sorted, lo: number, hi: number) => {
    // split lanes [lo,hi) across group (right-most exit gets right-most lanes) proportional to outLanes
    const n = hi - lo;
    if (group.length === 0 || n <= 0) return;
    if (group.length >= n) {
      group.forEach((e, i) => ranges.set(e.idx, [lo + Math.min(n - 1, Math.floor((i * n) / group.length)), lo + Math.min(n - 1, Math.floor((i * n) / group.length)) + 1]));
      return;
    }
    const total = group.reduce((a, e) => a + Math.max(1, e.outLanes), 0);
    let at = lo;
    group.forEach((e, i) => {
      const share = i === group.length - 1 ? hi - at : Math.max(1, Math.round((n * Math.max(1, e.outLanes)) / total));
      const end = Math.min(hi - (group.length - 1 - i), at + share);
      ranges.set(e.idx, [at, Math.max(at + 1, end)]);
      at = Math.max(at + 1, end);
    });
  };
  const through = S.length > 1 ? S.reduce((a, b) => (b.outLanes > a.outLanes || (b.outLanes === a.outLanes && Math.abs(b.theta) < Math.abs(a.theta)) ? b : a)) : null;
  if (through && through.outLanes >= nIn) {
    // Diverge: the through road keeps every lane, branches share the outer lanes on their side.
    ranges.set(through.idx, [0, nIn]);
    for (const e of S) {
      if (e === through) continue;
      const c = Math.min(nIn, Math.max(1, Math.min(e.outLanes, nIn - 1)));
      ranges.set(e.idx, e.theta < through.theta ? [0, c] : [nIn - c, nIn]);
    }
    for (const e of R) ranges.set(e.idx, [0, 1]);
    for (const e of L) ranges.set(e.idx, [nIn - 1, nIn]);
  } else if (S.length) {
    partition(S, 0, nIn);
    for (const e of R) ranges.set(e.idx, [0, 1]);
    for (const e of L) ranges.set(e.idx, [nIn - 1, nIn]);
  } else if (R.length && L.length) {
    const split = Math.max(1, Math.floor(nIn / 2));
    partition(R, 0, split);
    partition(L, nIn === 1 ? 0 : split, nIn);
  } else if (R.length) partition(R, 0, nIn);
  else if (L.length) partition(L, 0, nIn);
  for (const e of U) ranges.set(e.idx, [nIn - 1, nIn]);

  for (const e of sorted) {
    const r = ranges.get(e.idx);
    if (!r || e.outLanes === 0) continue;
    const [a, b] = r;
    const c = b - a;
    const m = e.outLanes;
    for (let l = a; l < b; l++) {
      const i = l - a;
      let out: number;
      if (e.turn === 'R') out = Math.min(m - 1, i);
      else if (e.turn === 'L' || e.turn === 'U') out = Math.max(0, m - c + i);
      else if (c <= m) out = i;
      else out = Math.max(0, i - (c - m));
      res.push({ lane: l, exit: e.idx, outLane: Math.max(0, Math.min(m - 1, out)) });
    }
  }
  return res;
}

/** All connectors at a node (default rules, then overrides, then merge-alignment). */
export function nodeConnectors(world: World, geom: NetGeometry, nodeId: number): Connector[] {
  const node = world.node(nodeId);
  const ng = geom.nodes.get(nodeId);
  const apps = approaches(world, nodeId);
  const out: Connector[] = [];
  if (!ng) return out;
  const seamless = !ng.junction && apps.length === 2;
  const deadEnd = apps.length === 1 && node.port === undefined;

  type Link = { from: Approach; lane: number; to: Approach; outLane: number; turn: Turn };
  const links: Link[] = [];
  for (const A of apps) {
    if (!A.inDir || A.inLanes === 0) continue;
    const inTravel = { x: -A.away.x, y: -A.away.y };
    const exits = apps
      .map((B, idx) => ({ B, idx }))
      .filter(({ B }) => B.outDir && B.outLanes > 0 && (B.seg !== A.seg || deadEnd))
      .map(({ B, idx }) => {
        const theta = wrapAngle(angleOf(B.away) - angleOf(inTravel));
        return { idx, theta, outLanes: B.outLanes, turn: classify(theta, B.seg === A.seg) };
      });
    const overrides = node.lanes;
    const hasOverride = overrides && Array.from({ length: A.inLanes }, (_, l) => nodeLaneKey(A.seg, l)).some((k) => k in overrides);
    if (hasOverride) {
      for (let l = 0; l < A.inLanes; l++) {
        for (const tk of overrides![nodeLaneKey(A.seg, l)] ?? []) {
          const [ts, tl] = tk.split(':').map(Number);
          const ex = exits.find((e) => apps[e.idx].seg === ts);
          if (!ex || tl >= ex.outLanes) continue;
          links.push({ from: A, lane: l, to: apps[ex.idx], outLane: tl, turn: ex.turn });
        }
      }
    } else if (seamless) {
      const B = apps.find((x) => x !== A)!;
      if (B.outDir) for (let l = 0; l < Math.min(A.inLanes, B.outLanes); l++) links.push({ from: A, lane: l, to: B, outLane: l, turn: 'S' });
    } else {
      for (const m of defaultLaneMap(A.inLanes, exits)) {
        links.push({ from: A, lane: m.lane, to: apps[m.exit], outLane: m.outLane, turn: exits.find((e) => e.idx === m.exit)!.turn });
      }
    }
  }

  // Merge alignment: when several approaches go straight into one exit and fit side by side,
  // give each its own lanes (right-most approach gets right-most lanes) instead of merging.
  if (!node.lanes) {
    for (const B of apps) {
      if (!B.outDir) continue;
      const feeding = apps.filter((A) => A !== B && links.some((k) => k.from === A && k.to === B && k.turn === 'S'));
      if (feeding.length < 2) continue;
      const sumLanes = feeding.reduce((a, A) => a + links.filter((k) => k.from === A && k.to === B).length, 0);
      if (sumLanes > B.outLanes) continue;
      // order approaches right-to-left as seen when travelling out along B
      // approaches on the right-hand side of the exit get the right-most lanes
      const ordered = [...feeding];
      ordered.sort((x, y) => sideOf(B.away, y.away) - sideOf(B.away, x.away));
      let at = 0;
      for (const A of ordered) {
        const ls = links.filter((k) => k.from === A && k.to === B).sort((p, q) => p.lane - q.lane);
        for (const k of ls) k.outLane = Math.min(B.outLanes - 1, at++);
      }
    }
  }

  for (const k of links) {
    const fromSeg = world.seg(k.from.seg),
      toSeg = world.seg(k.to.seg);
    const fromRef: LaneRef = { seg: fromSeg.id, dir: k.from.inDir!, idx: k.lane };
    const toRef: LaneRef = { seg: toSeg.id, dir: k.to.outDir!, idx: k.outLane };
    const a = laneEnd(world, geom, fromSeg, fromRef.dir, fromRef.idx, true);
    const b = laneEnd(world, geom, toSeg, toRef.dir, toRef.idx, false);
    const bezier = connectorCurve(a.pos, a.dir, b.pos, b.dir);
    out.push({
      node: nodeId,
      from: fromRef,
      to: toRef,
      turn: k.turn,
      bezier,
      poly: sampleBezier(bezier, 1),
      z: ng.z,
      direct: seamless && dist(a.pos, b.pos) < 0.5,
    });
  }
  // dedupe identical links
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = laneKey(c.from) + '>' + laneKey(c.to);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** positive if `other` (pointing away from node) lies to the right of travel direction `out` */
function sideOf(out: Vec2, other: Vec2) {
  // approach comes from -other direction; vehicles arriving from the right of the exit
  // have their "away" vector rotated clockwise from the exit's reverse.
  return -(out.x * other.y - out.y * other.x);
}

export function allConnectors(world: World, geom: NetGeometry): Map<number, Connector[]> {
  const m = new Map<number, Connector[]>();
  for (const n of world.nodes.values()) m.set(n.id, nodeConnectors(world, geom, n.id));
  return m;
}
