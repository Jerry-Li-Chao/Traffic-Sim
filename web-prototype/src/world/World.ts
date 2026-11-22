// Editable road network: nodes + Bézier segments. Pure data + topology operations.
import {
  type Bezier,
  type Vec2,
  type Polyline,
  sampleBezier,
  splitBezier,
  bezierPoint,
  bezierTangent,
  polyAt,
  smoothstep,
  dist,
} from '../core/math';
import { getClass, levelZ, type RoadClass } from './roads';

export type NodeControl = 'auto' | 'signal' | 'stop' | 'allstop';

export interface SignalPlan {
  /** green seconds per phase */
  green: number[];
}

export interface WNode {
  id: number;
  x: number;
  y: number;
  level: number;
  control: NodeControl;
  /** segment ids treated as the major road (priority). Empty = automatic. */
  major: number[];
  signal?: SignalPlan;
  /** lane connection overrides: "segId:lane" -> ["segId:lane", ...] */
  lanes?: Record<string, string[]>;
  /** port id when this node is a map entry/destination */
  port?: number;
  locked?: boolean;
  /**
   * Who set `control`: 'user' (the Junction tool; never overridden) or 'default' (picked
   * automatically from the roads that meet here, and re-picked when they change).
   */
  controlSource?: 'user' | 'default';
  /** a player-built house at the end of its driveway (`angle`: the way the house faces away from the road) */
  house?: { angle: number };
}

/** Port ids for houses: offset from the node id so they never clash with a site's own ports. */
export const HOUSE_PORT_BASE = 100_000;

/** Every port in the world: the site's own plus one per house. */
export function housePorts(world: World): { id: number; name: string; node: number; house: true }[] {
  return [...world.nodes.values()].filter((n) => n.house && n.port !== undefined).map((n) => ({ id: n.port!, name: 'House', node: n.id, house: true as const }));
}

export interface WSegment {
  id: number;
  a: number;
  b: number;
  /** interior control points; p0/p3 are the node positions */
  c1: Vec2;
  c2: Vec2;
  cls: string;
  /** lanes travelling a->b */
  lanesF: number;
  /** lanes travelling b->a */
  lanesB: number;
  locked?: boolean;
  roundabout?: boolean;
  /** money spent building it (refund base) */
  cost?: number;
}

/** A fixed railway line (double track) defined by the site. */
export interface RailLine {
  id: number;
  pts: [number, number][];
  level: number;
  perHour: number;
  speedKmh: number;
  cars: number;
}

/** Area roads may only cross on a bridge or in a tunnel (rivers, built-up land). */
export interface Obstacle {
  kind: 'water' | 'town';
  pts: [number, number][];
  name?: string;
}

export interface WorldData {
  nextId: number;
  nodes: WNode[];
  segments: WSegment[];
  rails?: RailLine[];
  obstacles?: Obstacle[];
}

export class World {
  nodes = new Map<number, WNode>();
  segments = new Map<number, WSegment>();
  rails: RailLine[] = [];
  obstacles: Obstacle[] = [];
  nextId = 1;
  /** bumped on every change */
  rev = 0;
  private polyCache = new Map<number, { key: string; poly: Polyline }>();

  // ------------------------------------------------------------------ io
  toJSON(): WorldData {
    return {
      nextId: this.nextId,
      nodes: [...this.nodes.values()].map((n) => structuredClone(n)),
      segments: [...this.segments.values()].map((s) => structuredClone(s)),
      rails: structuredClone(this.rails),
      obstacles: structuredClone(this.obstacles),
    };
  }

  load(d: WorldData) {
    this.nodes.clear();
    this.segments.clear();
    this.polyCache.clear();
    for (const n of d.nodes) this.nodes.set(n.id, structuredClone(n));
    for (const s of d.segments) this.segments.set(s.id, structuredClone(s));
    this.rails = structuredClone(d.rails ?? []);
    this.obstacles = structuredClone(d.obstacles ?? []);
    this.nextId = d.nextId;
    this.rev++;
  }

  clone(): World {
    const w = new World();
    w.load(this.toJSON());
    return w;
  }

  // ------------------------------------------------------------------ queries
  node(id: number): WNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  }
  seg(id: number): WSegment {
    const s = this.segments.get(id);
    if (!s) throw new Error(`no segment ${id}`);
    return s;
  }

  segmentsAt(nodeId: number): WSegment[] {
    const res: WSegment[] = [];
    for (const s of this.segments.values()) if (s.a === nodeId || s.b === nodeId) res.push(s);
    return res;
  }

  degree(nodeId: number) {
    let d = 0;
    for (const s of this.segments.values()) if (s.a === nodeId || s.b === nodeId) d++;
    return d;
  }

  bezier(s: WSegment): Bezier {
    const a = this.node(s.a),
      b = this.node(s.b);
    return { p0: { x: a.x, y: a.y }, p1: s.c1, p2: s.c2, p3: { x: b.x, y: b.y } };
  }

  /** Centre-line polyline (a -> b), cached. */
  poly(s: WSegment): Polyline {
    const a = this.node(s.a),
      b = this.node(s.b);
    const key = `${a.x},${a.y},${b.x},${b.y},${s.c1.x},${s.c1.y},${s.c2.x},${s.c2.y}`;
    const c = this.polyCache.get(s.id);
    if (c && c.key === key) return c.poly;
    const poly = sampleBezier(this.bezier(s), 2);
    this.polyCache.set(s.id, { key, poly });
    return poly;
  }

  cls(s: WSegment): RoadClass {
    return getClass(s.cls);
  }

  /** Elevation at arc length `t` (0..length) along the segment. */
  zAt(s: WSegment, along: number): number {
    const L = this.poly(s).length || 1;
    const za = levelZ(this.node(s.a).level),
      zb = levelZ(this.node(s.b).level);
    return za + (zb - za) * smoothstep(Math.min(1, Math.max(0, along / L)));
  }

  /** Steepest grade along the segment. */
  maxGrade(s: WSegment): number {
    const L = this.poly(s).length || 1;
    const dz = Math.abs(levelZ(this.node(s.a).level) - levelZ(this.node(s.b).level));
    return (1.5 * dz) / L;
  }

  /** Unit tangent pointing away from node `nodeId` along segment s. */
  tangentFrom(s: WSegment, nodeId: number): Vec2 {
    const b = this.bezier(s);
    if (s.a === nodeId) return bezierTangent(b, 0);
    const t = bezierTangent(b, 1);
    return { x: -t.x, y: -t.y };
  }

  otherEnd(s: WSegment, nodeId: number) {
    return s.a === nodeId ? s.b : s.a;
  }

  // ------------------------------------------------------------------ mutations
  addNode(x: number, y: number, level = 0, extra: Partial<WNode> = {}): WNode {
    const n: WNode = { id: this.nextId++, x, y, level, control: 'auto', major: [], ...extra };
    this.nodes.set(n.id, n);
    this.rev++;
    return n;
  }

  addSegment(a: number, b: number, curve: { c1: Vec2; c2: Vec2 }, cls: string, extra: Partial<WSegment> = {}): WSegment {
    const c = getClass(cls);
    const s: WSegment = {
      id: this.nextId++,
      a,
      b,
      c1: { ...curve.c1 },
      c2: { ...curve.c2 },
      cls,
      lanesF: c.lanesF,
      lanesB: c.lanesB,
      ...extra,
    };
    this.segments.set(s.id, s);
    this.clearNodeOverrides(a);
    this.clearNodeOverrides(b);
    this.rev++;
    return s;
  }

  /** Lane overrides and major-road picks refer to segment ids; reset when topology changes. */
  clearNodeOverrides(nodeId: number) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    delete n.lanes;
    n.major = n.major.filter((id) => this.segments.has(id) && (this.seg(id).a === nodeId || this.seg(id).b === nodeId));
    if (n.signal) delete n.signal;
  }

  removeSegment(id: number, removeOrphans = true) {
    const s = this.segments.get(id);
    if (!s) return;
    this.segments.delete(id);
    this.polyCache.delete(id);
    for (const nid of [s.a, s.b]) {
      this.clearNodeOverrides(nid);
      const n = this.nodes.get(nid);
      if (removeOrphans && n && (n.port === undefined || n.house) && this.degree(nid) === 0) this.nodes.delete(nid);
    }
    this.rev++;
  }

  removeNode(id: number) {
    for (const s of this.segmentsAt(id)) this.removeSegment(s.id, true);
    const n = this.nodes.get(id);
    if (n && n.port === undefined) this.nodes.delete(id);
    this.rev++;
  }

  /**
   * Split segment at Bézier parameter t. Returns the new node.
   * The two halves keep class, lanes and flags. Cost is split proportionally.
   */
  splitSegment(id: number, t: number, level?: number): WNode {
    return this.splitSegmentEx(id, t, level).node;
  }

  splitSegmentEx(id: number, t: number, level?: number): { node: WNode; left: WSegment; right: WSegment } {
    const s = this.seg(id);
    const bz = this.bezier(s);
    const [l, r] = splitBezier(bz, t);
    const p = bezierPoint(bz, t);
    // the new node keeps the road's height there (a fraction of a level part-way up a slope)
    const zf = this.zAt(s, this.poly(s).length * t) / 6;
    const lv = level ?? (Math.abs(zf - Math.round(zf)) < 0.01 ? Math.round(zf) : Math.round(zf * 1000) / 1000);
    const n = this.addNode(p.x, p.y, lv);
    const base = { cls: s.cls, lanesF: s.lanesF, lanesB: s.lanesB, locked: s.locked, roundabout: s.roundabout };
    const cost = s.cost ?? 0;
    this.segments.delete(id);
    this.polyCache.delete(id);
    const left = this.addSegment(s.a, n.id, { c1: l.p1, c2: l.p2 }, s.cls, { ...base, cost: cost * t });
    const right = this.addSegment(n.id, s.b, { c1: r.p1, c2: r.p2 }, s.cls, { ...base, cost: cost * (1 - t) });
    this.rev++;
    return { node: n, left, right };
  }

  /** Reverse the travel direction of a segment's lanes (geometry unchanged). */
  reverseSegment(id: number) {
    const s = this.seg(id);
    const f = s.lanesF;
    s.lanesF = s.lanesB;
    s.lanesB = f;
    this.clearNodeOverrides(s.a);
    this.clearNodeOverrides(s.b);
    this.rev++;
  }

  touch() {
    this.rev++;
  }
}

// ---------------------------------------------------------------------------
// Cross-section layout (shared by geometry, sim compiler and renderer)

export interface CrossSection {
  /** total width including sidewalks */
  width: number;
  /** carriageway (lanes + median) width */
  carriage: number;
  laneWidth: number;
  /** left-positive offset of forward lane i (0 = outer/right-most lane) */
  fwdOffset: (i: number) => number;
  /** left-positive offset of backward lane j (0 = outer) relative to a->b frame */
  bwdOffset: (j: number) => number;
  medianOffset: number;
  median: number;
}

export function crossSection(s: WSegment): CrossSection {
  const c = getClass(s.cls);
  const w = c.laneWidth;
  const m = s.lanesF > 0 && s.lanesB > 0 ? c.median : 0;
  const carriage = (s.lanesF + s.lanesB) * w + m;
  const width = carriage + 2 * c.shoulder + 2 * c.sidewalk;
  return {
    width,
    carriage,
    laneWidth: w,
    fwdOffset: (i) => -carriage / 2 + (i + 0.5) * w,
    bwdOffset: (j) => carriage / 2 - (j + 0.5) * w,
    medianOffset: carriage / 2 - s.lanesB * w - m / 2,
    median: m,
  };
}

/** Construction cost of a segment, accounting for elevation (bridges, cuttings, tunnels). */
export function segmentCost(world: World, s: WSegment): number {
  const c = getClass(s.cls);
  const poly = world.poly(s);
  const L = poly.length;
  const lanesFactor = (s.lanesF + s.lanesB) / Math.max(1, c.lanesF + c.lanesB);
  const n = Math.max(2, Math.ceil(L / 5));
  let mult = 0;
  for (let i = 0; i < n; i++) {
    const z = world.zAt(s, ((i + 0.5) / n) * L);
    mult += elevationMultiplier(z);
  }
  mult /= n;
  return Math.round(c.costPerM * L * mult * (0.4 + 0.6 * lanesFactor));
}

export function elevationMultiplier(z: number) {
  if (z > 1) return 2.4 + z / 10; // bridge / viaduct
  if (z <= -9) return 4.5; // tunnel
  if (z < -1) return 1.8; // cutting
  return 1;
}

/** Point at fraction along the segment centre line, with z. */
export function segPointAt(world: World, s: WSegment, along: number) {
  const p = polyAt(world.poly(s), along);
  return { ...p, z: world.zAt(s, along) };
}

export function nodeDistance(a: WNode, b: WNode) {
  return dist(a, b);
}
