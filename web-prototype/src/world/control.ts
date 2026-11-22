// Junction control compilation: major/minor arms, signal phases, conflict points.
import type { World, NodeControl } from './World';
import type { NetGeometry } from './geometry';
import type { Connector, Turn } from './lanes';
import { approaches } from './lanes';
import type { SimEdge, SimNode, SimConflict } from '../sim/types';
import { getClass } from './roads';
import { polyIntersections, angleOf, wrapAngle, makePolyline } from '../core/math';

export const DEFAULT_GREEN = 18;
export const AMBER = 3;
export const ALL_RED = 1.5;

/** Segment ids of the arms that have priority at a node (for priority / stop-controlled junctions). */
export function majorArms(world: World, nodeId: number): Set<number> {
  const n = world.node(nodeId);
  const segs = world.segmentsAt(nodeId);
  if (n.major.length) return new Set(n.major.filter((id) => segs.some((s) => s.id === id)));
  const ring = segs.filter((s) => s.roundabout);
  if (ring.length) return new Set(ring.map((s) => s.id));
  if (segs.length <= 2) return new Set(segs.map((s) => s.id));
  const score = (id: number) => {
    const s = world.seg(id);
    return getClass(s.cls).rank * 10 + s.lanesF + s.lanesB;
  };
  let best: [number, number] | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = world.tangentFrom(segs[i], nodeId),
        b = world.tangentFrom(segs[j], nodeId);
      const straight = Math.abs(wrapAngle(angleOf(a) - angleOf(b))) / Math.PI; // 1 = opposite
      const sc = score(segs[i].id) + score(segs[j].id) + straight * 8;
      if (sc > bestScore) {
        bestScore = sc;
        best = [segs[i].id, segs[j].id];
      }
    }
  }
  return new Set(best ?? []);
}

/**
 * The control a crossing gets unless the player picks one: signals where a road of four or more
 * lanes (an avenue, a boulevard) crosses another road, an all-way stop where two-lane roads cross,
 * and plain give-way priority otherwise (T-junctions, highways and ramps, roundabouts, house
 * driveways and site entries).
 */
export function defaultControl(world: World, nodeId: number): NodeControl {
  const node = world.node(nodeId);
  if (node.port !== undefined) return 'auto';
  // driveways to houses don't make a junction busy enough to need lights or stop signs
  const segs = world.segmentsAt(nodeId).filter((s) => !world.nodes.get(world.otherEnd(s, nodeId))?.house);
  if (segs.length < 4) return 'auto'; // only crossings, not T-junctions
  if (segs.some((s) => s.roundabout || getClass(s.cls).highway)) return 'auto';
  return segs.some((s) => s.lanesF + s.lanesB >= 4) ? 'signal' : 'allstop';
}

/** Re-pick default controls everywhere the player hasn't chosen one. */
export function refreshDefaultControls(world: World) {
  for (const n of world.nodes.values()) {
    if (n.controlSource === 'user') continue;
    // a control set some other way (e.g. by a template or a site) counts as chosen
    if (n.control !== 'auto' && n.controlSource !== 'default') continue;
    const d = defaultControl(world, n.id);
    if (d === n.control) continue;
    n.control = d;
    if (d === 'auto') delete n.controlSource;
    else n.controlSource = 'default';
  }
}

/** Do all roads at this node carry one-way highway-style traffic (merge/diverge, no crossing)? */
function isFreeFlow(world: World, nodeId: number) {
  return world.segmentsAt(nodeId).every((s) => getClass(s.cls).highway || s.lanesF === 0 || s.lanesB === 0);
}

/** Stop-line style for an approach arm (used by the renderer). */
export function stopStyleFor(world: World, nodeId: number, segId: number): 'stop' | 'yield' | 'none' {
  const n = world.nodes.get(nodeId);
  if (!n) return 'none';
  if (world.degree(nodeId) < 3) return 'none';
  if (n.control === 'signal' || n.control === 'allstop') return 'stop';
  if (getClass(world.seg(segId).cls).highway && isFreeFlow(world, nodeId)) return 'none';
  const major = majorArms(world, nodeId);
  if (major.has(segId)) return 'none';
  return n.control === 'stop' ? 'stop' : 'yield';
}

/** Group incoming arms into signal phases: opposite arms share a phase. Returns arm (segment) ids per phase. */
export function signalPhases(world: World, nodeId: number): number[][] {
  const apps = approaches(world, nodeId).filter((a) => a.inLanes > 0);
  // T-junctions: every approach gets its own protected phase (no starved permitted turns)
  if (apps.length <= 3) return apps.map((a) => [a.seg]);
  const used = new Set<number>();
  const pairs: { a: number; b: number; score: number }[] = [];
  for (let i = 0; i < apps.length; i++)
    for (let j = i + 1; j < apps.length; j++) {
      const d = Math.abs(wrapAngle(angleOf(apps[i].away) - angleOf(apps[j].away)));
      if (d > (140 * Math.PI) / 180) pairs.push({ a: apps[i].seg, b: apps[j].seg, score: d });
    }
  pairs.sort((x, y) => y.score - x.score);
  const phases: number[][] = [];
  for (const p of pairs) {
    if (used.has(p.a) || used.has(p.b)) continue;
    used.add(p.a);
    used.add(p.b);
    phases.push([p.a, p.b]);
  }
  for (const a of apps) if (!used.has(a.seg)) phases.push([a.seg]);
  return phases;
}

type Level = number;

function turnRank(t: Turn) {
  return t === 'S' ? 3 : t === 'R' ? 2 : t === 'L' ? 1 : 0;
}

export function buildJunctionControl(world: World, geom: NetGeometry, nodeId: number, conns: { edge: number; c: Connector }[], edges: SimEdge[]): SimNode | null {
  if (conns.length === 0) return null;
  const node = world.node(nodeId);
  const ng = geom.nodes.get(nodeId)!;
  const armIndex = new Map<number, number>();
  ng.arms.forEach((a, i) => armIndex.set(a.seg, i));
  const degree = ng.arms.length;
  const control = degree >= 3 ? node.control : 'auto';
  const major = majorArms(world, nodeId);
  const freeFlow = isFreeFlow(world, nodeId);

  // signal plan
  let phaseOfArm = new Map<number, number>();
  let signal: SimNode['signal'] = null;
  if (control === 'signal') {
    const phases = signalPhases(world, nodeId);
    phaseOfArm = new Map();
    phases.forEach((ph, k) => ph.forEach((seg) => phaseOfArm.set(seg, k)));
    const green = phases.map((_, k) => node.signal?.green[k] ?? DEFAULT_GREEN);
    signal = { phases: phases.map((ph) => ph.map((seg) => armIndex.get(seg)!)), green, amber: AMBER, allRed: ALL_RED, offset: 0 };
  }

  const level = (c: Connector): Level => {
    if (control === 'allstop') return 1;
    return major.has(c.from.seg) ? 2 : 1;
  };

  for (const { edge, c } of conns) {
    const e = edges[edge];
    e.arm = control === 'signal' ? armIndex.get(c.from.seg)! : -1;
    e.stop = control === 'allstop' || (control === 'stop' && !major.has(c.from.seg));
    e.conflicts = [];
  }

  // pairwise conflicts
  for (let i = 0; i < conns.length; i++) {
    for (let j = i + 1; j < conns.length; j++) {
      const A = conns[i],
        B = conns[j];
      const ca = A.c,
        cb = B.c;
      if (ca.from.seg === cb.from.seg && ca.from.dir === cb.from.dir && ca.from.idx === cb.from.idx) continue; // diverge
      const ea = edges[A.edge],
        eb = edges[B.edge];
      let kind: SimConflict['kind'];
      let sa: number, sb: number;
      const sameTarget = ca.to.seg === cb.to.seg && ca.to.dir === cb.to.dir && ca.to.idx === cb.to.idx;
      if (sameTarget) {
        kind = 'merge';
        sa = ea.length;
        sb = eb.length;
      } else {
        const pa = makePolyline(Array.from({ length: ea.pts.length / 2 }, (_, k) => ({ x: ea.pts[k * 2], y: ea.pts[k * 2 + 1] })));
        const pb = makePolyline(Array.from({ length: eb.pts.length / 2 }, (_, k) => ({ x: eb.pts[k * 2], y: eb.pts[k * 2 + 1] })));
        const hits = polyIntersections(pa, pb);
        if (!hits.length) continue;
        kind = 'cross';
        sa = hits[0].sa;
        sb = hits[0].sb;
      }
      // who yields?
      let aYields: boolean, bYields: boolean;
      const samePhase = control !== 'signal' || phaseOfArm.get(ca.from.seg) === phaseOfArm.get(cb.from.seg);
      if (!samePhase) {
        // separated in time by the signal; occupancy is still respected by the sim
        aYields = bYields = false;
      } else {
        const la = level(ca),
          lb = level(cb);
        if (la !== lb && control !== 'signal') {
          aYields = la < lb;
          bYields = !aYields;
        } else if (ca.from.seg === cb.from.seg) {
          // lanes of the same approach merging (lane drop): outer lane yields
          aYields = ca.from.idx < cb.from.idx;
          bYields = !aYields;
        } else if (turnRank(ca.turn) !== turnRank(cb.turn)) {
          aYields = turnRank(ca.turn) < turnRank(cb.turn);
          bYields = !aYields;
        } else {
          // equal: yield to traffic from the right (right-hand rule)
          const da = ng.arms[armIndex.get(ca.from.seg)!]?.angle ?? 0;
          const db = ng.arms[armIndex.get(cb.from.seg)!]?.angle ?? 0;
          const rel = wrapAngle(db - da);
          // B's arm lies counter-clockwise of A's (rel > 0) => B is on the right of traffic coming from A
          aYields = rel > 0;
          bYields = !aYields;
        }
      }
      ea.conflicts.push({ edge: B.edge, s: sa, os: sb, kind, yield: aYields });
      eb.conflicts.push({ edge: A.edge, s: sb, os: sa, kind, yield: bYields });
    }
  }
  for (const { edge, c } of conns) {
    const e = edges[edge];
    e.giveWay = e.conflicts.some((k) => k.yield);
    // circulating roundabout traffic never waits for exit space (it would gridlock the ring)
    const circulating = world.seg(c.from.seg).roundabout === true;
    e.boxCheck = degree >= 3 && !freeFlow && !circulating && e.conflicts.length > 0;
  }
  return { id: nodeId, signal, armCount: degree };
}
