// Compile the editable world into the simulation lane graph (SimInput).
import type { World } from './World';
import type { NetGeometry } from './geometry';
import { type Connector, laneGeometry, laneKey, type LaneRef } from './lanes';
import { getClass, kmh } from './roads';
import { minRadius, type Polyline } from '../core/math';
import { type SimInput, type SimEdge, type SimNode, type SimPort, type SimDemand, EDGE_LANE, EDGE_CONNECTOR, emptyRail, type SimRail } from '../sim/types';
import { buildJunctionControl } from './control';
import { railTracks, railCenter, RAIL_CORRIDOR } from './rail';
import { levelZ } from './roads';
import { polyIntersections, polyAt, makePolyline as mkPoly } from '../core/math';

export interface CompileExtras {
  seed: number;
  demand: SimDemand[];
  ports: { id: number; name: string; node: number; house?: boolean }[];
  rail?: SimRail;
  rampUp?: number;
  /** level crossings: rail edge + where it crosses road lanes */
  roadCrossings?: (edges: SimEdge[]) => void;
}

const LAT_ACC = 2.2; // comfortable lateral acceleration for curve speed (m/s²)

function polyToEdge(poly: Polyline) {
  return { pts: poly.pts.slice(), cum: poly.cum.slice(), length: poly.length };
}

export function compileWorld(world: World, geom: NetGeometry, connectors: Map<number, Connector[]>, extras: CompileExtras): SimInput {
  const edges: SimEdge[] = [];
  const laneEdge = new Map<string, number>();
  const portByNode = new Map<number, number>();
  for (const p of extras.ports) portByNode.set(p.node, p.id);

  const blank = (): Omit<SimEdge, 'id' | 'key' | 'kind' | 'pts' | 'z' | 'cum' | 'length' | 'speed' | 'seg' | 'node'> => ({
    next: [],
    left: -1,
    right: -1,
    sinkPort: -1,
    arm: -1,
    stop: false,
    giveWay: false,
    boxCheck: false,
    conflicts: [],
    crossings: [],
  });

  // 1) lane edges
  for (const s of world.segments.values()) {
    const cls = getClass(s.cls);
    const curveSpeed = (poly: Polyline) => {
      const r = minRadius(poly);
      return Number.isFinite(r) ? Math.sqrt(LAT_ACC * r) : Infinity;
    };
    for (const [dir, n] of [
      ['f', s.lanesF],
      ['b', s.lanesB],
    ] as const) {
      for (let i = 0; i < n; i++) {
        const ref: LaneRef = { seg: s.id, dir, idx: i };
        const lg = laneGeometry(world, geom, ref);
        const id = edges.length;
        const e: SimEdge = {
          id,
          key: `L:${laneKey(ref)}`,
          kind: EDGE_LANE,
          ...polyToEdge(lg.poly),
          z: lg.z,
          speed: Math.max(5, Math.min(kmh(cls.speedKmh), curveSpeed(lg.poly) * 1.15)),
          seg: s.id,
          node: lg.endNode,
          ...blank(),
        };
        if (portByNode.has(lg.endNode)) e.sinkPort = portByNode.get(lg.endNode)!;
        edges.push(e);
        laneEdge.set(laneKey(ref), id);
      }
    }
  }
  // lane adjacency (left = towards centre = higher index)
  for (const s of world.segments.values()) {
    for (const [dir, n] of [
      ['f', s.lanesF],
      ['b', s.lanesB],
    ] as const) {
      for (let i = 0; i < n; i++) {
        const e = edges[laneEdge.get(`${s.id}:${dir}:${i}`)!];
        e.left = i + 1 < n ? laneEdge.get(`${s.id}:${dir}:${i + 1}`)! : -1;
        e.right = i > 0 ? laneEdge.get(`${s.id}:${dir}:${i - 1}`)! : -1;
      }
    }
  }

  // 2) connectors
  const connEdges = new Map<number, { edge: number; c: Connector }[]>();
  for (const [nodeId, list] of connectors) {
    for (const c of list) {
      const from = laneEdge.get(laneKey(c.from));
      const to = laneEdge.get(laneKey(c.to));
      if (from === undefined || to === undefined) continue;
      if (c.direct) {
        edges[from].next.push(to);
        continue;
      }
      const id = edges.length;
      const r = minRadius(c.poly);
      const limit = Math.min(edges[from].speed, edges[to].speed);
      const speed = Math.max(4, Math.min(limit, Number.isFinite(r) ? Math.sqrt(LAT_ACC * r) : limit));
      const e: SimEdge = {
        id,
        key: `C:${nodeId}:${laneKey(c.from)}>${laneKey(c.to)}`,
        kind: EDGE_CONNECTOR,
        ...polyToEdge(c.poly),
        z: c.poly.cum.map(() => c.z),
        speed,
        seg: -1,
        node: nodeId,
        ...blank(),
      };
      e.next = [to];
      edges.push(e);
      edges[from].next.push(id);
      if (!connEdges.has(nodeId)) connEdges.set(nodeId, []);
      connEdges.get(nodeId)!.push({ edge: id, c });
    }
  }

  // 3) junction control (priority, signals, conflicts)
  const nodes: SimNode[] = [];
  for (const n of world.nodes.values()) {
    const list = connEdges.get(n.id) ?? [];
    const sn = buildJunctionControl(world, geom, n.id, list, edges);
    if (sn) nodes.push(sn);
  }

  // 4) ports
  const ports: SimPort[] = extras.ports.map((p) => {
    const spawnEdges: number[] = [];
    const sinkEdges: number[] = [];
    for (const e of edges) {
      if (e.kind !== EDGE_LANE) continue;
      const s = world.seg(e.seg);
      const dir = e.key.split(':')[2];
      const start = dir === 'f' ? s.a : s.b;
      if (start === p.node) spawnEdges.push(e.id);
      if (e.node === p.node) sinkEdges.push(e.id);
    }
    return { id: p.id, name: p.name, spawnEdges, sinkEdges, ...(p.house ? { house: true } : {}) };
  });

  extras.roadCrossings?.(edges);
  const rail = extras.rail ?? compileRail(world, edges);

  return {
    seed: extras.seed,
    edges,
    nodes,
    ports,
    demand: extras.demand,
    rail,
    rampUp: extras.rampUp ?? 60,
  };
}

/** Rail tracks + services, and level crossings registered on both the road lanes and the tracks. */
export function compileRail(world: World, edges: SimEdge[]): SimRail {
  const rail = emptyRail();
  if (!world.rails.length) return rail;
  const crossingIds = new Map<string, number>();
  for (const line of world.rails) {
    const z = levelZ(line.level);
    const tracks = railTracks(line);
    const center = railCenter(line);
    const speed = kmh(line.speedKmh);
    const headway = 3600 / Math.max(0.1, line.perHour);
    tracks.forEach((t, k) => {
      const id = rail.edges.length;
      rail.edges.push({
        id,
        key: `R:${line.id}:${k}`,
        kind: EDGE_LANE,
        ...polyToEdge(t),
        z: t.cum.map(() => z),
        speed,
        seg: -1,
        node: -1,
        sinkPort: -1,
        next: [],
        left: -1,
        right: -1,
        arm: -1,
        stop: false,
        giveWay: false,
        boxCheck: false,
        conflicts: [],
        crossings: [],
      });
      rail.services.push({ path: [id], headway, offset: headway * (k === 0 ? 0.2 : 0.7), cars: line.cars, speed });
    });
    // level crossings: road lanes at the same height that intersect the tracks
    for (const e of edges) {
      if (e.kind !== EDGE_LANE) continue;
      const lane = mkPoly(Array.from({ length: e.pts.length / 2 }, (_, i) => ({ x: e.pts[i * 2], y: e.pts[i * 2 + 1] })));
      tracks.forEach((t, k) => {
        for (const h of polyIntersections(lane, t)) {
          const zi = e.z[Math.min(e.z.length - 1, Math.max(0, lane.cum.findIndex((c) => c >= h.sa)))];
          if (Math.abs(zi - z) > 0.5) continue;
          const key = `${line.id}:${e.seg}`;
          if (!crossingIds.has(key)) crossingIds.set(key, crossingIds.size);
          const cid = crossingIds.get(key)!;
          if (!e.crossings.some((c) => c.id === cid)) {
            // stop just before the barrier, which stands beside the whole track bed (both tracks)
            let stop = Math.max(0, h.sa - 2.5);
            let clear = 8;
            for (const hc of polyIntersections(lane, center)) {
              const a = polyAt(lane, hc.sa),
                b = polyAt(center, hc.sb);
              const sin = Math.max(0.5, Math.abs(a.tx * b.ty - a.ty * b.tx));
              const st = Math.max(0, hc.sa - (RAIL_CORRIDOR + 1.5) / sin - 1);
              if (st < stop) {
                stop = st;
                clear = hc.sa + (RAIL_CORRIDOR + 1.5) / sin + 1 - st;
              }
            }
            // `clear`: distance from the stop line to the far side of the track bed
            e.crossings.push({ id: cid, s: stop, clear });
          }
          const railEdge = rail.edges[rail.edges.length - tracks.length + k];
          if (!rail.crossings.some((c) => c.id === cid && c.edge === railEdge.id)) rail.crossings.push({ id: cid, edge: railEdge.id, s: h.sb, x: h.x, y: h.y });
        }
      });
    }
  }
  for (const e of edges) e.crossings.sort((a, b) => a.s - b.s);
  return rail;
}
