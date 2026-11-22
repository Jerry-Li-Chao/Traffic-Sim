// Derived network geometry: trimmed segment centre-lines and junction polygons.
import {
  type Vec2,
  type Polyline,
  subPolyline,
  angleOf,
  perp,
  add,
  scale,
  bezierPoint,
  quadToCubic,
  sampleBezier,
  makePolyline,
  dist,
  polyAt,
} from '../core/math';
import { World, type WSegment, crossSection, type CrossSection } from './World';
import { levelZ, getClass } from './roads';

export interface Arm {
  seg: number;
  /** unit direction pointing away from the node */
  dir: Vec2;
  angle: number;
  halfWidth: number;
  trim: number;
  /** true if the segment starts at this node (a end) */
  isStart: boolean;
  /** corner points at the trim line (looking away from node) */
  left: Vec2;
  right: Vec2;
  /** centre point at trim line */
  center: Vec2;
}

export interface NodeGeom {
  id: number;
  z: number;
  arms: Arm[];
  /** junction surface polygon (ccw). Empty for dead ends and seamless joints. */
  polygon: Vec2[];
  junction: boolean;
  /** seamless bend between two matching roads: a curved piece of road filling the corner */
  bend?: { seg: number; reversed: boolean; center: Polyline; z: number };
  /**
   * Lane-count change between two roads (e.g. 1+1 into 2+1): still a junction for the
   * simulation, but drawn as a tapered piece of road instead of a junction area.
   * `a` is the road travelled from, `b` the road travelled onto; each `reversed` says whether
   * that road's own direction runs against the A -> B travel direction.
   */
  taper?: { a: { seg: number; reversed: boolean }; b: { seg: number; reversed: boolean }; center: Polyline; z: number };
  /**
   * Merge / diverge: a road joining another at a shallow angle. The through road is drawn
   * continuously (as `taper`) and the joining road fills in with a tapered gore.
   */
  merge?: { gore: Vec2[]; goreZ: number[]; edge: [Vec2, Vec2]; edgeZ: [number, number]; highway: boolean };
}

/**
 * Half-length of a transition that shifts lanes sideways by `shift` metres gently enough to be
 * driven at the road's speed limit (lane connectors take their speed from their curvature).
 */
function shiftTrim(shift: number, speedKmh: number): number {
  if (shift < 0.05) return 0;
  const v = speedKmh / 3.6;
  // an S-curve of length L shifting by d has radius ≈ L² / (4d); keep v²/R under ~2.2 m/s²
  const L = Math.sqrt((4 * shift * v * v) / 2.2);
  return Math.min(45, L / 2 + 2);
}

/** Sideways shift of the outermost lane and of the centre line between two oriented roads. */
function laneShift(a: WSegment, b: WSegment): number {
  const ca = crossSection(a),
    cb = crossSection(b);
  return Math.max(Math.abs(ca.carriage - cb.carriage) / 2, Math.abs(ca.medianOffset - cb.medianOffset));
}

/** Largest angle (between a joining road and the road it runs along) treated as a merge. */
const MERGE_ANGLE = (40 * Math.PI) / 180;

/** At a 3-way node: a through pair (i, j) plus a branch k joining at a shallow angle. */
function findMerge(arms: Arm[]): { i: number; j: number; k: number; near: number; theta: number } | null {
  if (arms.length !== 3) return null;
  let best: { i: number; j: number; k: number; near: number; theta: number; d: number } | null = null;
  const between = (a: Vec2, b: Vec2) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y)));
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const d = arms[i].dir.x * arms[j].dir.x + arms[i].dir.y * arms[j].dir.y;
      if (d > -Math.cos((30 * Math.PI) / 180)) continue; // not a through pair
      const k = 3 - i - j;
      const ti = between(arms[k].dir, arms[i].dir),
        tj = between(arms[k].dir, arms[j].dir);
      const theta = Math.min(ti, tj);
      if (theta > MERGE_ANGLE || theta < 1e-3) continue;
      if (!best || d < best.d) best = { i, j, k, near: ti < tj ? i : j, theta, d };
    }
  }
  return best;
}

export interface SegGeom {
  id: number;
  full: Polyline;
  s0: number;
  s1: number;
  /** trimmed centre line (a -> b) */
  center: Polyline;
  /** z per vertex of `center` */
  z: number[];
  cs: CrossSection;
}

export interface NetGeometry {
  segs: Map<number, SegGeom>;
  nodes: Map<number, NodeGeom>;
}

const JUNCTION_MARGIN = 1.5;

/** Should this degree-2 node be a seamless joint (no junction area)? */
export function isSeamless(world: World, nodeId: number): boolean {
  const segs = world.segmentsAt(nodeId);
  if (segs.length !== 2) return false;
  const [s1, s2] = segs;
  if (s1.id === s2.id) return false;
  const d1 = world.tangentFrom(s1, nodeId),
    d2 = world.tangentFrom(s2, nodeId);
  // any joint between two matching roads is drawn as a smooth bend (the planner forbids hairpins)
  if (d1.x * d2.x + d1.y * d2.y > Math.cos((15 * Math.PI) / 180)) return false;
  // same lane configuration in the same travel direction
  const inOut = (s: WSegment) => (s.b === nodeId ? [s.lanesF, s.lanesB] : [s.lanesB, s.lanesF]);
  const [in1, out1] = inOut(s1);
  const [in2, out2] = inOut(s2);
  return in1 === out2 && out1 === in2;
}

/**
 * Should this degree-2 node be drawn as a taper (roads continue, but lane counts differ)?
 * Both roads must carry traffic in the same travel directions so the carriageways line up.
 */
export function isTaper(world: World, nodeId: number): boolean {
  const segs = world.segmentsAt(nodeId);
  if (segs.length !== 2) return false;
  const [s1, s2] = segs;
  if (s1.id === s2.id || isSeamless(world, nodeId)) return false;
  const d1 = world.tangentFrom(s1, nodeId),
    d2 = world.tangentFrom(s2, nodeId);
  if (d1.x * d2.x + d1.y * d2.y > Math.cos((60 * Math.PI) / 180)) return false;
  const inOut = (s: WSegment) => (s.b === nodeId ? [s.lanesF, s.lanesB] : [s.lanesB, s.lanesF]);
  const [in1, out1] = inOut(s1);
  const [in2, out2] = inOut(s2);
  return in1 > 0 === out2 > 0 && out1 > 0 === in2 > 0;
}

/** A segment viewed in a travel direction: lanesF are the lanes running that way. */
function orient(s: WSegment, reversed: boolean): WSegment {
  return reversed ? { ...s, lanesF: s.lanesB, lanesB: s.lanesF } : s;
}

/** Tangent-continuous cubic between two trimmed road ends (dirs point away from the node). */
function cornerCurve(A: Arm, B: Arm): Polyline {
  const cosT = -(A.dir.x * B.dir.x + A.dir.y * B.dir.y);
  const defl = Math.acos(Math.max(-1, Math.min(1, cosT)));
  const chord = Math.hypot(B.center.x - A.center.x, B.center.y - A.center.y);
  // handle lengths approximating a circular arc between the two ends
  const k = defl > 1e-3 ? (chord / (2 * Math.sin(defl / 2))) * (4 / 3) * Math.tan(defl / 4) : chord / 3;
  const bz = {
    p0: A.center,
    p1: { x: A.center.x - A.dir.x * k, y: A.center.y - A.dir.y * k },
    p2: { x: B.center.x - B.dir.x * k, y: B.center.y - B.dir.y * k },
    p3: B.center,
  };
  // overlap each neighbouring road slightly so no hairline gap opens at the outer edges
  const curve = sampleBezier(bz, 1.5);
  const pts: Vec2[] = [{ x: A.center.x + A.dir.x * 0.4, y: A.center.y + A.dir.y * 0.4 }];
  for (let i = 0; i < curve.pts.length; i += 2) pts.push({ x: curve.pts[i], y: curve.pts[i + 1] });
  pts.push({ x: B.center.x + B.dir.x * 0.4, y: B.center.y + B.dir.y * 0.4 });
  return makePolyline(pts);
}

function lineIntersect(p: Vec2, d: Vec2, q: Vec2, e: Vec2): { s: number; t: number } | null {
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-9) return null;
  const wx = q.x - p.x,
    wy = q.y - p.y;
  return { s: (wx * e.y - wy * e.x) / den, t: (wx * d.y - wy * d.x) / den };
}

export function computeNetGeometry(world: World): NetGeometry {
  const nodes = new Map<number, NodeGeom>();
  const trims = new Map<string, number>(); // `${seg}:${node}` -> trim

  const mergeOf = new Map<number, NonNullable<ReturnType<typeof findMerge>>>();
  for (const n of world.nodes.values()) {
    const segs = world.segmentsAt(n.id);
    const arms: Arm[] = segs.map((s) => {
      const dir = world.tangentFrom(s, n.id);
      return {
        seg: s.id,
        dir,
        angle: angleOf(dir),
        halfWidth: crossSection(s).width / 2,
        trim: 0,
        isStart: s.a === n.id,
        left: { x: 0, y: 0 },
        right: { x: 0, y: 0 },
        center: { x: 0, y: 0 },
      };
    });
    arms.sort((a, b) => a.angle - b.angle);
    const seamless = isSeamless(world, n.id);
    const taper = !seamless && isTaper(world, n.id);
    const junction = arms.length >= 3 || (arms.length === 2 && !seamless);
    const merge = junction ? findMerge(arms) : null;
    if (junction && !taper) {
      const maxHalf = Math.max(...arms.map((a) => a.halfWidth));
      for (const a of arms) a.trim = Math.max(2, arms.length >= 3 ? maxHalf * 0.6 : 2);
      for (let i = 0; i < arms.length; i++) {
        const A = arms[i],
          B = arms[(i + 1) % arms.length];
        if (A === B) continue;
        // A's left edge vs B's right edge (B is counter-clockwise of A)
        const pa = scale(perp(A.dir), A.halfWidth);
        const pb = scale(perp(B.dir), -B.halfWidth);
        const hit = lineIntersect(pa, A.dir, pb, B.dir);
        let gap = B.angle - A.angle;
        if (gap <= 0) gap += Math.PI * 2;
        if (hit && gap < Math.PI * 0.97) {
          const corner = Math.min(6, 2 + maxHalf * 0.25);
          A.trim = Math.max(A.trim, hit.s + JUNCTION_MARGIN + corner * 0.5);
          B.trim = Math.max(B.trim, hit.t + JUNCTION_MARGIN + corner * 0.5);
        }
      }
    }
    if (junction && arms.length >= 3) {
      // leave room for a pedestrian crossing in the junction mouth of urban roads
      for (const a of arms) if (getClass(world.seg(a.seg).cls).sidewalk > 0) a.trim += 3;
    }
    if (seamless || taper) {
      // trim back far enough that a curve through the corner fits both road edges
      const cosT = -(arms[0].dir.x * arms[1].dir.x + arms[0].dir.y * arms[1].dir.y);
      const defl = Math.acos(Math.max(-1, Math.min(1, cosT)));
      let t = 0;
      if (defl > (2 * Math.PI) / 180) {
        const half = Math.max(arms[0].halfWidth, arms[1].halfWidth);
        t = (half + 3) * Math.tan(Math.min(defl, 2.6) / 2) + 1.5;
      }
      if (taper) {
        // a gentle taper: long enough to drive the lane shift at the speed limit
        const [s1, s2] = segs;
        const shift = laneShift(orient(s1, s1.a === n.id), orient(s2, s2.b === n.id));
        const kmh = Math.min(getClass(s1.cls).speedKmh, getClass(s2.cls).speedKmh);
        t = Math.max(t, 3 + shift * 4, shiftTrim(shift, kmh));
      }
      for (const a of arms) a.trim = t;
    }
    for (const a of arms) {
      const L = world.poly(world.seg(a.seg)).length;
      // very shallow merges/diverges would otherwise produce enormous junction areas
      a.trim = Math.min(a.trim, L * 0.45, 45);
      trims.set(`${a.seg}:${n.id}`, a.trim);
    }
    const ng: NodeGeom = { id: n.id, z: levelZ(n.level), arms, polygon: [], junction };
    if (merge) mergeOf.set(n.id, merge);
    if (taper) ng.taper = { a: { seg: 0, reversed: false }, b: { seg: 0, reversed: false }, center: makePolyline([]), z: ng.z };
    nodes.set(n.id, ng);
  }

  const segs = new Map<number, SegGeom>();
  for (const s of world.segments.values()) {
    const full = world.poly(s);
    const s0 = trims.get(`${s.id}:${s.a}`) ?? 0;
    const s1 = full.length - (trims.get(`${s.id}:${s.b}`) ?? 0);
    const center = subPolyline(full, s0, Math.max(s0 + 0.5, s1));
    const z = center.cum.map((c) => world.zAt(s, s0 + c));
    segs.set(s.id, { id: s.id, full, s0, s1, center, z, cs: crossSection(s) });
  }

  // Arm corner points and junction polygons.
  for (const ng of nodes.values()) {
    for (const a of ng.arms) {
      const g = segs.get(a.seg)!;
      const along = a.isStart ? g.s0 : g.s1;
      const p = polyAt(g.full, along);
      // direction away from node at the trim point
      const d = a.isStart ? { x: p.tx, y: p.ty } : { x: -p.tx, y: -p.ty };
      const l = perp(d);
      a.center = { x: p.x, y: p.y };
      a.left = add(a.center, scale(l, a.halfWidth));
      a.right = add(a.center, scale(l, -a.halfWidth));
      a.dir = d;
    }
    if (!ng.junction && ng.arms.length === 2 && ng.arms[0].trim > 0) {
      // bend: curve from arm 0's trimmed end through the node to arm 1's trimmed end
      const [A, B] = ng.arms;
      const sa = world.seg(A.seg);
      // travelling A -> B: A's lanes arriving at the node are the bend's forward lanes
      ng.bend = { seg: sa.id, reversed: sa.a === ng.id, center: cornerCurve(A, B), z: ng.z };
    }
    const m = mergeOf.get(ng.id);
    if (m) {
      const A = ng.arms[m.i],
        B = ng.arms[m.j],
        K = ng.arms[m.k],
        T = ng.arms[m.near];
      const sa = world.seg(A.seg),
        sb = world.seg(B.seg);
      ng.taper = { a: { seg: sa.id, reversed: sa.a === ng.id }, b: { seg: sb.id, reversed: sb.b === ng.id }, center: cornerCurve(A, B), z: ng.z };
      // gore: from the joining road's end to the through road's edge at the node
      const node = world.node(ng.id);
      const tSeg = world.seg(T.seg);
      const tPoly = world.poly(tSeg);
      const side = Math.sign(T.dir.x * K.dir.y - T.dir.y * K.dir.x) || 1;
      const edgeAt = (dist: number) => {
        const along = T.isStart ? Math.min(dist, tPoly.length) : Math.max(0, tPoly.length - dist);
        const q = polyAt(tPoly, along);
        const away = T.isStart ? { x: q.tx, y: q.ty } : { x: -q.tx, y: -q.ty };
        const o = scale(perp(away), T.halfWidth * side);
        return { p: { x: q.x + o.x, y: q.y + o.y }, z: world.zAt(tSeg, along) };
      };
      const toLine = (p: Vec2) => Math.abs((p.x - node.x) * T.dir.y - (p.y - node.y) * T.dir.x);
      const [inner, outer] = toLine(K.left) < toLine(K.right) ? [K.left, K.right] : [K.right, K.left];
      const gk = segs.get(K.seg)!;
      const zk = K.isStart ? gk.z[0] : gk.z[gk.z.length - 1];
      const along = (inner.x - node.x) * T.dir.x + (inner.y - node.y) * T.dir.y;
      const eIn = edgeAt(Math.max(0, along));
      const eNode = { p: add(node, scale(perp(T.dir), T.halfWidth * side)), z: ng.z };
      const kSeg = world.seg(K.seg);
      ng.merge = {
        gore: [outer, inner, eIn.p, eNode.p],
        goreZ: [zk, zk, eIn.z, eNode.z],
        edge: [outer, eNode.p],
        edgeZ: [zk, eNode.z],
        highway: getClass(kSeg.cls).highway === true,
      };
      continue;
    }
    if (ng.taper) {
      const [A, B] = ng.arms;
      const sa = world.seg(A.seg),
        sb = world.seg(B.seg);
      ng.taper = { a: { seg: sa.id, reversed: sa.a === ng.id }, b: { seg: sb.id, reversed: sb.b === ng.id }, center: cornerCurve(A, B), z: ng.z };
      continue;
    }
    if (!ng.junction) continue;
    const poly: Vec2[] = [];
    const n = ng.arms.length;
    for (let i = 0; i < n; i++) {
      const A = ng.arms[i],
        B = ng.arms[(i + 1) % n];
      poly.push(A.right, A.left);
      // fillet from A.left to B.right
      const hit = lineIntersect(A.left, A.dir, B.right, B.dir);
      let gap = B.angle - A.angle;
      if (gap <= 0) gap += Math.PI * 2;
      if (n > 1 && hit && hit.s < 0 && hit.t < 0 && gap < Math.PI * 0.95) {
        const c = add(A.left, scale(A.dir, hit.s));
        if (dist(c, A.left) < 60) {
          const bz = quadToCubic(A.left, c, B.right);
          for (let k = 1; k < 6; k++) poly.push(bezierPoint(bz, k / 6));
        }
      }
    }
    ng.polygon = poly;
  }
  return { segs, nodes };
}

/** Polyline offset helper reused by renderers and the sim compiler. */
export function trimmedRange(g: SegGeom) {
  return { s0: g.s0, s1: g.s1 };
}

export function segmentFullOffset(g: SegGeom, s0: number, s1: number): Polyline {
  return subPolyline(g.full, s0, s1);
}
