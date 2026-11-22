import { Rng } from '../core/rng';
import { SIM_DT, type Snapshot, VEH_STRIDE, TRAIN_STRIDE } from './protocol';
import { emptyInput, EDGE_LANE, EDGE_CONNECTOR, type SimInput, type SimStats, type SimEdge, type SimNode, type SimConflict, type SimPort } from './types';
import { MinHeap } from './heap';

export const LC_PENALTY = 3; // seconds-equivalent cost of a lane change in routing
const CONNECTOR_PENALTY = 0.8;
const LOOKAHEAD = 220;
const STUCK_FLAG = 30;
const STUCK_REMOVE = 300;
const FLOW_WINDOW = 120;
const ROUTE_INTERVAL = 10;
const SINK = -2;
/** hold reasons that do not depend on the vehicle that is checking the gap */
const SHIELD_REASONS = new Set([1, 2, 5, 6, 7]);

export const VEH_COLORS = [
  '#d8d4cc', '#2b2f36', '#b33b2e', '#2d5f9a', '#e8e6df', '#6b6f75', '#c9a227', '#3f7d4e', '#7b3f8c', '#d0743c', '#9aa3ad', '#1f4e79',
];
export const TRUCK_COLORS = [4, 3, 0, 5];

export class Vehicle {
  id = 0;
  edge = 0;
  s = 0;
  v = 0;
  a = 0;
  len = 4.5;
  width = 1.8;
  color = 0;
  /** 0 car, 1 van, 2 truck */
  type = 0;
  dest = 0;
  origin = 0;
  born = 0;
  v0f = 1;
  T = 1.3;
  amax = 1.6;
  b = 2.5;
  s0 = 2;
  next = -1;
  lcCool = 0;
  /** lateral visual offset (m, left positive) that decays after a lane change */
  lcOffset = 0;
  /** lane this vehicle is still partly in while changing lanes (-1 when none) */
  lcFrom = -1;
  /** lateral move not tied to forward motion (deadlock swaps) */
  lcTimed = false;
  stopped = 0;
  /** personal lane-choice habits, so drivers don't all react to the same thing at once */
  /** how far ahead (m) this driver starts moving over for a lane it needs */
  lcPlan = 150;
  /** route benefit (s) this driver needs before moving over for a better lane */
  lcSense = 3;
  /** MOBIL acceleration-gain threshold (m/s²) */
  lcGain = 0.25;
  /** how strongly this driver keeps right when there is no reason not to */
  keepRight = 0.1;
  /** next time this driver looks for a faster lane */
  lcNext = 0;
  /** time this vehicle reached the stop line of its current edge (for first-come rules) */
  arrivedAt = -1;
  /** granted entry into `next` (junction permission) */
  permit = false;
  /** a vehicle in the adjacent lane we are holding back for so it can merge in front of us */
  courtesyFor: Vehicle | null = null;
  courtesyUntil = 0;
  /** must stop at the end of the current edge this tick (red light, give way, blocked exit ...) */
  hold = false;
  /** why the vehicle is holding: 0 none 1 red 2 stop sign 3 give way 4 junction busy 5 exit blocked 6 queue order 7 level crossing */
  holdWhy = 0;
  dead = false;
}

interface Pending {
  dest: number;
  truck: boolean;
}

export interface Train {
  id: number;
  edge: number;
  s: number;
  v: number;
  len: number;
  cars: number;
  speed: number;
}

/** trips a minute each house sends out, and draws in from the site's entries */
const HOUSE_TRIPS = 0.6;
/** a house never has more than this many of its own cars out, nor more heading to it */
const HOUSE_MAX = 2;

/** seconds of warning before a train reaches a level crossing */
const CROSSING_WARN = 16;
const CAR_LEN = 20;

/** Deterministic traffic simulation. Pure: no DOM, no wall clock, no Math.random. */
export class Sim {
  input: SimInput = emptyInput();
  rng = new Rng(1);
  time = 0;
  tick = 0;
  vehicles: Vehicle[] = [];
  /** vehicles on each edge, front (largest s) first */
  onEdge: Vehicle[][] = [];
  private nextId = 1;
  private keyToEdge = new Map<string, number>();
  /** cost-to-go tables per destination port id */
  cost = new Map<number, Float64Array>();
  private preds: { from: number; lc: boolean }[][] = [];
  edgeTime = new Float64Array(0);
  speedEma = new Float64Array(0);
  private lastRoute = -1e9;
  /** accumulated arrival hazard and the exponential threshold for the next arrival, per demand entry */
  private demandAcc: number[] = [];
  /** per house port: progress towards its next outgoing / incoming trip */
  private houseAcc = new Map<number, { out: number; in: number }>();
  private housePorts = new Set<number>();
  private demandThresh: number[] = [];
  queues = new Map<number, Pending[]>();
  private arrivalTimes = new Map<number, number[]>();
  arrivals: Record<number, number> = {};
  removed = 0;
  /** trip requests dropped because no route exists */
  unroutable = 0;
  /** lane changes performed (mandatory, discretionary) */
  lcMandatory = 0;
  lcDiscretionary = 0;
  completed = 0;
  tripSum = 0;
  private portIndex = new Map<number, number>();
  /** connector edge -> lane edge feeding it */
  connFrom = new Int32Array(0);
  /** parallel lanes (and connectors between the same lane groups) share congestion for routing */
  private edgeGroup = new Int32Array(0);
  private groupCount = 0;
  nodeById = new Map<number, SimNode>();
  private cycle = new Map<number, number>();
  trains: Train[] = [];
  private trainNext: number[] = [];
  private nextTrainId = 1;
  crossingClosed = new Uint8Array(0);

  // ------------------------------------------------------------------ setup
  load(input: SimInput) {
    this.input = input;
    this.rng = new Rng(input.seed);
    this.time = 0;
    this.tick = 0;
    this.vehicles = [];
    this.nextId = 1;
    this.queues.clear();
    this.arrivalTimes.clear();
    this.arrivals = {};
    this.removed = 0;
    this.unroutable = 0;
    this.completed = 0;
    this.tripSum = 0;
    this.prepareNetwork();
    this.resetDemand();
    this.trains = [];
    this.trainNext = input.rail.services.map((sv) => sv.offset);
    this.onLoad();
  }

  /** Replace the network while keeping vehicles on edges that still exist. */
  update(input: SimInput) {
    const oldEdges = this.input.edges;
    const oldDemand = this.input.demand;
    this.input = input;
    // vehicles still carry old edge indices: set them aside until they are translated
    const old = this.vehicles;
    this.vehicles = [];
    this.prepareNetwork();
    const keep: Vehicle[] = [];
    // every stored edge index must be translated to the new network (or dropped)
    const remap = (e: number) => {
      const key = oldEdges[e]?.key;
      return key !== undefined ? this.keyToEdge.get(key) : undefined;
    };
    for (const v of old) {
      const ne = remap(v.edge);
      if (ne === undefined) {
        v.dead = true;
        continue;
      }
      v.edge = ne;
      if (v.lcFrom >= 0) v.lcFrom = remap(v.lcFrom) ?? -1;
      v.s = Math.min(v.s, input.edges[ne].length);
      v.next = -1;
      v.permit = false;
      keep.push(v);
    }
    this.vehicles = keep;
    for (const v of keep) if (v.courtesyFor?.dead) v.courtesyFor = null;
    this.rebuildEdgeLists();
    for (const v of this.vehicles) this.plan(v);
    // keep spawn timers for unchanged demand entries
    const sameDemand = oldDemand.length === input.demand.length && oldDemand.every((d, i) => d.from === input.demand[i].from && d.to === input.demand[i].to && d.perMin === input.demand[i].perMin);
    if (!sameDemand) this.resetDemand();
    if (this.trainNext.length !== input.rail.services.length) {
      this.trains = [];
      this.trainNext = input.rail.services.map((sv) => this.time + sv.offset);
    }
    this.onLoad();
  }

  /** extension point for subclasses / later systems */
  protected onLoad() {}

  private prepareNetwork() {
    const E = this.input.edges.length;
    this.keyToEdge.clear();
    this.input.edges.forEach((e) => this.keyToEdge.set(e.key, e.id));
    this.edgeTime = new Float64Array(E);
    this.speedEma = new Float64Array(E);
    for (const e of this.input.edges) {
      this.speedEma[e.id] = e.speed;
      this.edgeTime[e.id] = e.length / e.speed + (e.kind === EDGE_LANE ? 0 : CONNECTOR_PENALTY);
    }
    this.preds = Array.from({ length: E }, () => []);
    for (const e of this.input.edges) {
      for (const n of e.next) this.preds[n].push({ from: e.id, lc: false });
      if (e.left >= 0) this.preds[e.left].push({ from: e.id, lc: true });
      if (e.right >= 0) this.preds[e.right].push({ from: e.id, lc: true });
    }
    this.connFrom = new Int32Array(E).fill(-1);
    for (const e of this.input.edges) if (e.kind === EDGE_LANE) for (const n of e.next) if (this.input.edges[n].kind === EDGE_CONNECTOR) this.connFrom[n] = e.id;
    this.buildGroups();
    this.nodeById.clear();
    this.cycle.clear();
    for (const n of this.input.nodes) {
      this.nodeById.set(n.id, n);
      if (n.signal) this.cycle.set(n.id, n.signal.green.reduce((a, g) => a + g + n.signal!.amber + n.signal!.allRed, 0));
    }
    this.crossingClosed = new Uint8Array(this.input.rail.crossings.reduce((m, c) => Math.max(m, c.id + 1), 0));
    this.portIndex.clear();
    this.input.ports.forEach((p, i) => this.portIndex.set(p.id, i));
    for (const p of this.input.ports) if (!this.queues.has(p.id)) this.queues.set(p.id, []);
    this.housePorts = new Set(this.input.ports.filter((p) => p.house).map((p) => p.id));
    this.rebuildEdgeLists();
    this.computeRoutes();
  }

  private buildGroups() {
    const edges = this.input.edges;
    const g = new Int32Array(edges.length).fill(-1);
    let n = 0;
    for (const e of edges) {
      if (e.kind !== EDGE_LANE || g[e.id] >= 0) continue;
      // walk to the leftmost lane, then label every lane to its right
      let l = e.id,
        guard = 0;
      while (edges[l].left >= 0 && guard++ < 16) l = edges[l].left;
      guard = 0;
      for (let k = l; k >= 0 && g[k] < 0 && guard++ < 16; k = edges[k].right) g[k] = n;
      if (g[e.id] < 0) g[e.id] = n;
      n++;
    }
    const conn = new Map<string, number>();
    for (const e of edges) {
      if (e.kind === EDGE_LANE) continue;
      const from = this.connFrom[e.id];
      const to = e.next[0];
      const key = `${from >= 0 ? g[from] : -1 - e.id}>${to !== undefined && to >= 0 ? g[to] : -1}`;
      if (!conn.has(key)) conn.set(key, n++);
      g[e.id] = conn.get(key)!;
    }
    this.edgeGroup = g;
    this.groupCount = n;
  }

  private rebuildEdgeLists() {
    this.onEdge = Array.from({ length: this.input.edges.length }, () => []);
    for (const v of this.vehicles) this.onEdge[v.edge].push(v);
    for (const l of this.onEdge) l.sort((a, b) => b.s - a.s || a.id - b.id);
  }

  private resetDemand() {
    this.demandAcc = this.input.demand.map(() => 0);
    // first arrival comes a little early so the site comes alive quickly
    // stagger the first arrival of each route so they don't all appear at once
    this.demandThresh = this.input.demand.map(() => 0.1 + this.rng.next() * 0.9);
  }

  private rate(perMin: number) {
    const ramp = this.input.rampUp > 0 ? Math.min(1, 0.3 + (0.7 * this.time) / this.input.rampUp) : 1;
    return (perMin / 60) * ramp;
  }

  // ------------------------------------------------------------------ routing
  computeRoutes() {
    this.lastRoute = this.time;
    const dests = new Set(this.input.demand.map((d) => d.to));
    // with houses about, any port may be a trip's end
    if (this.housePorts.size) for (const p of this.input.ports) if (p.sinkEdges.length) dests.add(p.id);
    const E = this.input.edges.length;
    // congestion per group of side-by-side lanes: which lane a driver picks is their own
    // (local) decision, so routing must not send every car to the same lane at once
    const sum = new Float64Array(this.groupCount),
      cnt = new Float64Array(this.groupCount);
    for (const e of this.input.edges) {
      const ratio = Math.max(1.5, Math.min(e.speed, this.speedEma[e.id])) / e.speed;
      sum[this.edgeGroup[e.id]] += ratio;
      cnt[this.edgeGroup[e.id]]++;
    }
    for (const e of this.input.edges) {
      const gi = this.edgeGroup[e.id];
      const observed = Math.max(1.5, e.speed * (sum[gi] / cnt[gi]));
      this.edgeTime[e.id] = e.length / observed + (e.kind === EDGE_LANE ? 0 : CONNECTOR_PENALTY);
    }
    for (const d of dests) {
      const cost = new Float64Array(E).fill(Infinity);
      const heap = new MinHeap();
      for (const e of this.input.edges) {
        if (e.sinkPort === d) {
          cost[e.id] = this.edgeTime[e.id];
          heap.push(e.id, cost[e.id]);
        }
      }
      while (heap.size) {
        const [e, c] = heap.pop();
        if (c > cost[e]) continue;
        for (const p of this.preds[e]) {
          const nc = p.lc ? c + this.lcCost(p.from) : c + this.edgeTime[p.from];
          if (nc < cost[p.from]) {
            cost[p.from] = nc;
            heap.push(p.from, nc);
          }
        }
      }
      this.cost.set(d, cost);
    }
  }

  /** Cost of changing lanes along edge e: short stretches are harder places to change. */
  lcCost(e: number) {
    return LC_PENALTY + 250 / Math.max(20, this.input.edges[e].length);
  }

  /** Travel cost from the start of edge `e` to `dest` staying in this lane until its end. */
  directCost(e: number, dest: number): number {
    const edge = this.input.edges[e];
    const cost = this.cost.get(dest);
    if (!cost) return Infinity;
    if (edge.sinkPort === dest) return this.edgeTime[e];
    let best = Infinity;
    for (const n of edge.next) if (cost[n] < best) best = cost[n];
    return this.edgeTime[e] + best;
  }

  /** Best next edge from the end of `e` towards `dest`. */
  chooseNext(e: number, dest: number): number {
    const edge = this.input.edges[e];
    if (edge.sinkPort === dest) return SINK;
    const cost = this.cost.get(dest);
    if (!cost) return -1;
    let best = -1,
      bc = Infinity;
    for (const n of edge.next) {
      if (cost[n] < bc) {
        bc = cost[n];
        best = n;
      }
    }
    return best;
  }

  protected plan(v: Vehicle) {
    v.next = this.chooseNext(v.edge, v.dest);
    v.permit = false;
  }

  // ------------------------------------------------------------------ main loop
  step() {
    const dt = SIM_DT;
    this.tick++;
    this.time = this.tick * dt;
    if (this.time - this.lastRoute >= ROUTE_INTERVAL) this.computeRoutes();
    this.updateRail(dt);
    this.beforeStep(dt);
    this.spawn();
    this.laneChanges(dt);
    this.collectGhosts();
    const acc = new Float64Array(this.vehicles.length);
    for (let i = 0; i < this.vehicles.length; i++) acc[i] = this.accel(this.vehicles[i]);
    for (let i = 0; i < this.vehicles.length; i++) this.integrate(this.vehicles[i], acc[i], dt);
    if (this.vehicles.some((v) => v.dead)) {
      this.vehicles = this.vehicles.filter((v) => !v.dead);
      this.rebuildEdgeLists();
    }
    this.afterStep(dt);
    this.updateStats(dt);
  }

  /** hook for rail and other systems */
  protected afterStep(_dt: number) {}

  // ------------------------------------------------------------------ spawning
  private spawn() {
    const demand = this.input.demand;
    for (let i = 0; i < demand.length; i++) {
      const d = demand[i];
      // steady generation: a trip every 1/rate seconds with ±20% spacing jitter, so the
      // demand a player has to serve is exactly the stated rate (no random droughts or bursts)
      this.demandAcc[i] += this.rate(d.perMin) * SIM_DT;
      let guard = 0;
      while (this.demandAcc[i] >= this.demandThresh[i] && guard++ < 20) {
        this.demandAcc[i] -= this.demandThresh[i];
        this.demandThresh[i] = 0.8 + this.rng.next() * 0.4;
        const q = this.queues.get(d.from);
        if (q) {
          q.push({ dest: d.to, truck: this.rng.next() < (d.trucks ?? 0.08) });
          if (q.length > 60) q.shift();
        }
      }
    }
    if (this.housePorts.size) this.houseTrips();
    for (const port of this.input.ports) {
      const q = this.queues.get(port.id);
      if (!q || q.length === 0) continue;
      const used = new Set<number>();
      // try a few queued vehicles per tick (one per lane)
      for (let k = 0; k < Math.min(q.length, port.spawnEdges.length); k++) {
        // drop requests whose destination is not reachable from this entry (no head-of-line blocking)
        while (q.length && !port.spawnEdges.some((e) => Number.isFinite(this.cost.get(q[0].dest)?.[e] ?? Infinity))) {
          q.shift();
          this.unroutable++;
        }
        if (!q.length) break;
        const p = q[0];
        const cost = this.cost.get(p.dest)!;
        let best = -1,
          bc = Infinity;
        for (const e of port.spawnEdges) {
          if (used.has(e) || !Number.isFinite(cost[e])) continue;
          const list = this.onEdge[e];
          const last = list[list.length - 1];
          const room = last ? last.s - last.len : Infinity;
          if (room < (p.truck ? 22 : 14)) continue;
          const c = cost[e] - Math.min(room, 60) * 0.02;
          if (c < bc) {
            bc = c;
            best = e;
          }
        }
        if (best < 0) break;
        used.add(best);
        q.shift();
        this.addVehicle(best, port.id, p.dest, p.truck);
      }
    }
  }

  /**
   * Houses: a gentle trickle of trips out to the site's destinations (and other houses), and in
   * from the site's entries. Never more than HOUSE_MAX of a house's cars out at once, nor more
   * than HOUSE_MAX on their way to it (queued requests count too).
   */
  private houseTrips() {
    const out = new Map<number, number>(),
      inc = new Map<number, number>();
    const bump = (m: Map<number, number>, k: number) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const v of this.vehicles) {
      bump(out, v.origin);
      bump(inc, v.dest);
    }
    for (const [pid, q] of this.queues)
      for (const r of q) {
        bump(out, pid);
        bump(inc, r.dest);
      }
    const reach = (from: SimPort, to: number) => {
      const cost = this.cost.get(to);
      return !!cost && from.spawnEdges.some((e) => Number.isFinite(cost[e]));
    };
    const rate = (HOUSE_TRIPS / 60) * SIM_DT;
    for (const h of this.input.ports) {
      if (!h.house) continue;
      let st = this.houseAcc.get(h.id);
      if (!st) this.houseAcc.set(h.id, (st = { out: this.rng.next(), in: this.rng.next() }));
      st.out += rate;
      st.in += rate;
      if (st.out >= 1) {
        st.out -= 1;
        if ((out.get(h.id) ?? 0) < HOUSE_MAX) {
          const to = this.input.ports.filter((p) => p !== h && p.sinkEdges.length && (!p.house || (inc.get(p.id) ?? 0) < HOUSE_MAX) && reach(h, p.id));
          if (to.length) {
            const d = to[this.rng.int(0, to.length)];
            this.queues.get(h.id)?.push({ dest: d.id, truck: false });
            bump(out, h.id);
            bump(inc, d.id);
          }
        }
      }
      if (st.in >= 1) {
        st.in -= 1;
        if ((inc.get(h.id) ?? 0) < HOUSE_MAX) {
          const from = this.input.ports.filter((p) => !p.house && p.spawnEdges.length && reach(p, h.id));
          if (from.length) {
            const o = from[this.rng.int(0, from.length)];
            this.queues.get(o.id)?.push({ dest: h.id, truck: false });
            bump(inc, h.id);
          }
        }
      }
    }
  }

  addVehicle(edge: number, origin: number, dest: number, truck: boolean): Vehicle {
    const r = this.rng;
    const v = new Vehicle();
    v.id = this.nextId++;
    v.edge = edge;
    v.origin = origin;
    v.dest = dest;
    v.born = this.time;
    const van = !truck && r.next() < 0.12;
    v.type = truck ? 2 : van ? 1 : 0;
    v.len = truck ? r.range(9, 12.5) : van ? r.range(5.2, 5.8) : r.range(4.1, 4.8);
    v.width = truck ? 2.45 : van ? 2.0 : r.range(1.75, 1.9);
    v.amax = truck ? r.range(0.7, 0.95) : r.range(1.3, 2.0);
    v.b = truck ? 2.0 : r.range(2.3, 2.8);
    v.T = truck ? r.range(1.5, 1.9) : r.range(1.0, 1.5);
    v.s0 = truck ? 2.5 : 2.0;
    v.v0f = truck ? r.range(0.85, 0.95) : r.range(0.92, 1.08);
    v.lcPlan = r.range(70, 280);
    v.lcSense = r.range(1.5, 8);
    v.lcGain = truck ? r.range(0.3, 0.6) : r.range(0.12, 0.45);
    v.keepRight = truck ? 0.25 : r.range(-0.02, 0.18);
    v.lcNext = this.time + r.range(0.5, 2);
    v.color = truck ? TRUCK_COLORS[r.int(0, TRUCK_COLORS.length)] : r.int(0, VEH_COLORS.length);
    v.s = Math.min(v.len + 0.5, this.input.edges[edge].length);
    const list = this.onEdge[edge];
    const last = list[list.length - 1];
    // enter at a speed that can comfortably stop behind whoever is ahead
    const room = last ? last.s - last.len - v.s : Infinity;
    v.v = Math.min(this.input.edges[edge].speed * 0.7, last ? last.v + 1 : Infinity, Math.max(0, room - v.s0) / v.T + 1);
    this.insertSorted(list, v);
    this.vehicles.push(v);
    this.plan(v);
    return v;
  }

  protected insertSorted(list: Vehicle[], v: Vehicle) {
    let i = list.length;
    while (i > 0 && list[i - 1].s < v.s) i--;
    list.splice(i, 0, v);
  }

  protected removeFrom(list: Vehicle[], v: Vehicle) {
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
  }

  // ------------------------------------------------------------------ car following
  /** Merging traffic ahead of v on connectors that join v's (next) connector's target lane. */
  private mergeLeader(v: Vehicle): { gap: number; vl: number } {
    let best = { gap: Infinity, vl: 0 };
    const cur = this.input.edges[v.edge];
    let C: SimEdge | null = null;
    let offset = 0; // distance from v to the start of C
    if (cur.kind === EDGE_CONNECTOR) {
      C = cur;
      offset = -v.s;
    } else if (v.next >= 0 && this.input.edges[v.next].kind === EDGE_CONNECTOR) {
      C = this.input.edges[v.next];
      offset = cur.length - v.s;
      if (offset > 120) return best;
    }
    if (!C) return best;
    for (const k of C.conflicts) {
      if (k.kind !== 'merge') continue;
      const myDist = offset + k.s;
      for (const u of this.onEdge[k.edge]) {
        const uDist = k.os - u.s;
        if (uDist >= myDist) continue; // it is behind us
        const gap = myDist - uDist - u.len;
        if (gap < best.gap) best = { gap, vl: u.v };
      }
    }
    return best;
  }

  /** Distance (bumper gap) and speed of whatever is ahead along the planned path. */
  leader(v: Vehicle): { gap: number; vl: number } {
    const own = this.leaderOnPath(v);
    const m = this.mergeLeader(v);
    return m.gap < own.gap ? m : own;
  }

  private leaderOnPath(v: Vehicle): { gap: number; vl: number } {
    const own = this.leaderInLane(v);
    // a car still part-way out of our lane after changing lanes is in our way too
    const ghosts = this.lcGhosts.get(v.edge);
    if (ghosts) {
      const edge = this.input.edges[v.edge];
      for (const g of ghosts) {
        if (g === v) continue;
        const gs = (g.s / this.input.edges[g.edge].length) * edge.length;
        if (gs <= v.s) continue;
        const gap = gs - g.len - v.s;
        if (gap < own.gap) {
          own.gap = gap;
          own.vl = g.v;
        }
      }
    }
    return own;
  }

  /** Vehicles changing lanes, keyed by the lane they are still partly in. */
  private lcGhosts = new Map<number, Vehicle[]>();

  private collectGhosts() {
    this.lcGhosts.clear();
    for (const v of this.vehicles) {
      if (v.dead || v.lcFrom < 0 || Math.abs(v.lcOffset) < 1.2) continue;
      const from = this.input.edges[v.lcFrom];
      if (!from || (from.left !== v.edge && from.right !== v.edge)) continue; // moved on to another edge
      let list = this.lcGhosts.get(v.lcFrom);
      if (!list) this.lcGhosts.set(v.lcFrom, (list = []));
      list.push(v);
    }
  }

  private leaderInLane(v: Vehicle): { gap: number; vl: number } {
    const list = this.onEdge[v.edge];
    const idx = list.indexOf(v);
    if (idx > 0) {
      const l = list[idx - 1];
      return { gap: l.s - l.len - v.s, vl: l.v };
    }
    let dist = this.input.edges[v.edge].length - v.s;
    let e = v.next;
    let guard = 0;
    while (e >= 0 && dist < LOOKAHEAD && guard++ < 8) {
      const l2 = this.onEdge[e];
      if (l2.length) {
        const last = l2[l2.length - 1];
        return { gap: dist + last.s - last.len, vl: last.v };
      }
      dist += this.input.edges[e].length;
      const edge = this.input.edges[e];
      e = edge.kind === EDGE_LANE ? this.chooseNext(e, v.dest) : edge.next[0] ?? -1;
    }
    return { gap: Infinity, vl: 0 };
  }

  idm(v: Vehicle, speedLimit: number, gap: number, vl: number): number {
    const v0 = Math.max(1, speedLimit * v.v0f);
    const free = 1 - Math.pow(v.v / v0, 4);
    if (!Number.isFinite(gap)) return v.amax * free;
    const sStar = v.s0 + Math.max(0, v.v * v.T + (v.v * (v.v - vl)) / (2 * Math.sqrt(v.amax * v.b)));
    const g = Math.max(0.1, gap);
    return v.amax * (free - (sStar / g) * (sStar / g));
  }

  /** Distance from v to the point where it must stop (end of current edge) or Infinity. */
  protected stopDistance(v: Vehicle): number {
    const edge = this.input.edges[v.edge];
    let d = Infinity;
    if (v.next === -1 && edge.sinkPort !== v.dest) d = edge.length - v.s - 0.5;
    else if (v.hold) d = edge.length - v.s - 0.3;
    if (this.crossingClosed.length) d = Math.min(d, this.crossingStop(v));
    return d;
  }

  /** Distance to the stop line of a closed level crossing ahead (this edge or the next). */
  private crossingStop(v: Vehicle): number {
    const edge = this.input.edges[v.edge];
    // keep the tracks clear: never stop on them, either for the barriers or in a queue
    const ahead = this.leaderOnPath(v);
    const mustStop = (ei: number, c: { id: number; s: number; clear?: number }, d: number) => {
      if (this.crossingClosed[c.id]) return true;
      const clear = c.clear ?? 8;
      // open, but the queue ahead would leave us standing on the tracks
      if (ahead.vl < 3 && ahead.gap < d + clear + v.len + 1) return true;
      // don't drive on unless our vehicle fits between the tracks and the end of the road,
      // counting everyone already over the stop line as if they were queued up there
      const room = this.input.edges[ei].length - (c.s + clear);
      if (room < v.len + 4) return false; // too short to ever fit: rely on the leader check
      let used = 3; // the first in line stops short of the end of the road
      for (const o of this.onEdge[ei]) if (o !== v && o.s > c.s) used += o.len + o.s0 + 0.5;
      return room - used < v.len + 1;
    };
    for (const c of edge.crossings) {
      const d = c.s - v.s;
      if (d < -0.2) continue; // already past the stop line: carry on over the tracks
      if (!mustStop(v.edge, c, d)) continue;
      // too close to stop safely: keep going over the tracks
      if (d < 4 && (v.v * v.v) / (2 * Math.max(0.3, d)) > 6) continue;
      return Math.max(0, d);
    }
    if (v.next >= 0) {
      const ne = this.input.edges[v.next];
      const base = edge.length - v.s;
      for (const c of ne.crossings) {
        if (c.s > 40) break;
        if (mustStop(v.next, c, base + c.s)) return base + c.s;
      }
      if (ne.kind !== EDGE_LANE && ne.next[0] !== undefined) {
        const n2 = this.input.edges[ne.next[0]];
        for (const c of n2.crossings) {
          if (c.s > 30) break;
          if (mustStop(ne.next[0], c, base + ne.length + c.s)) return base + ne.length + c.s;
        }
      }
    }
    return Infinity;
  }

  // ------------------------------------------------------------------ railways
  private updateRail(dt: number) {
    const rail = this.input.rail;
    if (!rail.services.length) return;
    // departures
    rail.services.forEach((sv, i) => {
      if (this.time < this.trainNext[i]) return;
      const edge = sv.path[0];
      const last = this.trains.filter((t) => t.edge === edge).reduce<Train | null>((a, t) => (!a || t.s < a.s ? t : a), null);
      if (last && last.s - last.len < 60) return; // wait for the block to clear
      this.trains.push({ id: this.nextTrainId++, edge, s: 0, v: sv.speed, len: sv.cars * CAR_LEN, cars: sv.cars, speed: sv.speed });
      this.trainNext[i] += sv.headway;
    });
    // movement (simple following on each track)
    for (const t of this.trains) {
      const ahead = this.trains.filter((o) => o.edge === t.edge && o.s > t.s).reduce<Train | null>((a, o) => (!a || o.s < a.s ? o : a), null);
      let target = t.speed;
      if (ahead) {
        const gap = ahead.s - ahead.len - t.s;
        target = Math.min(target, Math.max(0, (gap - 40) * 0.3));
      }
      t.v += Math.max(-1.2, Math.min(0.6, target - t.v)) * dt;
      t.v = Math.max(0, t.v);
      t.s += t.v * dt;
    }
    this.trains = this.trains.filter((t) => t.s - t.len < rail.edges[t.edge].length);
    // crossing barriers
    this.crossingClosed.fill(0);
    for (const c of rail.crossings) {
      for (const t of this.trains) {
        if (t.edge !== c.edge) continue;
        if (t.s >= c.s - t.speed * CROSSING_WARN && t.s - t.len <= c.s + 6) {
          this.crossingClosed[c.id] = 1;
          break;
        }
      }
    }
  }

  // ------------------------------------------------------------------ junction control
  /** 0 red, 1 amber, 2 green for a signal arm. */
  signalState(nodeId: number, arm: number): number {
    const n = this.nodeById.get(nodeId);
    const sig = n?.signal;
    if (!sig) return 2;
    const cyc = this.cycle.get(nodeId) ?? 1;
    let t = (this.time + sig.offset) % cyc;
    for (let k = 0; k < sig.phases.length; k++) {
      const g = sig.green[k];
      const inPhase = sig.phases[k].includes(arm);
      if (t < g) return inPhase ? 2 : 0;
      t -= g;
      if (t < sig.amber) return inPhase ? 1 : 0;
      t -= sig.amber;
      if (t < sig.allRed) return 0;
      t -= sig.allRed;
    }
    return 0;
  }

  /** Time to travel distance d from the current speed (accelerating gently). */
  private timeTo(v: Vehicle, d: number, vmax: number) {
    if (d <= 0) return 0;
    const a = Math.max(0.6, v.amax * 0.9);
    const v0 = v.v;
    const tAcc = Math.max(0, (vmax - v0) / a);
    const dAcc = v0 * tAcc + 0.5 * a * tAcc * tAcc;
    if (d <= dAcc) return (-v0 + Math.sqrt(v0 * v0 + 2 * a * d)) / a;
    return tAcc + (d - dAcc) / Math.max(1, vmax);
  }

  /**
   * Conflict point reserved: a vehicle inside connector D that will not have cleared `os`
   * by the time we get there (tMe), or a vehicle committed to enter D.
   */
  private reserved(D: number, os: number, tMe: number): boolean {
    for (const u of this.onEdge[D]) {
      const rearToClear = os + 1 + u.len - u.s;
      if (rearToClear <= 0) continue;
      const tClearU = rearToClear / Math.max(u.v, 0.4);
      if (tClearU + 0.8 > tMe) return true;
    }
    const L = this.connFrom[D];
    if (L >= 0) for (const u of this.onEdge[L]) if (u.permit && u.next === D) return true;
    return false;
  }

  /** Gap acceptance against priority traffic on connector D (conflict k). */
  private gapOk(v: Vehicle, k: SimConflict, distToLine: number, C: SimEdge): boolean {
    // crossing: we must be fully past the point; merging: we only need headway ahead of the priority vehicle
    const vC = Math.min(C.speed, 12);
    const tClear = k.kind === 'merge' ? this.timeTo(v, distToLine + k.s, vC) : this.timeTo(v, distToLine + k.s + v.len + 1, vC) + 0.3;
    // impatience: long waits make drivers accept tighter gaps; crawling queues let them in (courtesy)
    const wait = v.stopped;
    const crit = (k.kind === 'merge' ? 1.3 : 0.8) * (wait > 25 ? 0.4 : 1);
    const courtesy = wait > 40;
    const D = this.input.edges[k.edge];
    for (const u of this.onEdge[D.id]) {
      if (u.s - u.len > k.os + 1) continue;
      const tU = Math.max(0, k.os - u.s) / Math.max(u.v, 1.5);
      if (tU < tClear + crit) return false;
    }
    const L = this.connFrom[D.id];
    if (L >= 0) {
      const lane = this.input.edges[L];
      for (const u of this.onEdge[L]) {
        const du = lane.length - u.s + k.os;
        if (du > 150) break;
        // held at its line for reasons independent of us (red, stop sign, blocked exit): shields those behind
        if (!u.permit && u.hold && SHIELD_REASONS.has(u.holdWhy)) break;
        if (u.next !== D.id) {
          if (u.v < 1) break; // a stopped vehicle going elsewhere blocks those behind it
          continue;
        }
        if (courtesy && u.v < 4 && !u.permit && du > 10) break;
        const tU = this.timeTo(u, du, D.speed) * 0.95;
        if (tU < tClear + crit) return false;
      }
    }
    return true;
  }

  /** Room for v beyond connector C along its route (don't block the box). Short exit lanes look further ahead. */
  private exitSpace(v: Vehicle, C: SimEdge): boolean {
    const need = v.len + 2.5;
    let room = 0;
    let e = C.next[0];
    let guard = 0;
    while (e !== undefined && e >= 0 && guard++ < 6) {
      const edge = this.input.edges[e];
      const list = this.onEdge[e];
      if (list.length) {
        const last = list[list.length - 1];
        room += last.s - last.len;
        break;
      }
      room += edge.length;
      if (room >= 60) break;
      e = edge.kind === EDGE_LANE ? this.chooseNext(e, v.dest) : edge.next[0];
    }
    if (room >= 60) return true;
    // vehicles already inside the junction heading to the same lane
    const T = C.next[0];
    for (const p of this.preds[T]) {
      if (p.lc || this.input.edges[p.from].kind !== EDGE_CONNECTOR) continue;
      for (const u of this.onEdge[p.from]) if (u !== v) room -= u.len + 2;
    }
    return room >= need;
  }

  /** Decide whether v may proceed into its next connector. Returns 0 = go, else a hold reason. */
  private junctionGo(v: Vehicle, C: SimEdge, dist: number): number {
    if (C.arm >= 0) {
      const st = this.signalState(C.node, C.arm);
      if (st === 0) return 1;
      if (st === 1 && (v.v * v.v) / (2 * Math.max(0.5, dist)) < 3.5) return 1;
    }
    if (C.stop && v.arrivedAt < 0) return 2;
    const node = this.nodeById.get(C.node);
    if (C.stop && node && !node.signal) {
      // stop-controlled: earlier arrivals at other stop lines with conflicting movements go first
      for (const k of C.conflicts) {
        if (!this.input.edges[k.edge].stop) continue;
        const L = this.connFrom[k.edge];
        if (L < 0) continue;
        const u = this.onEdge[L][0];
        if (!u || u === v || u.next !== k.edge || u.arrivedAt < 0 || u.permit) continue;
        if (u.arrivedAt < v.arrivedAt || (u.arrivedAt === v.arrivedAt && u.id < v.id)) return 6;
      }
    }
    const vC = Math.min(C.speed, 12);
    for (const k of C.conflicts) {
      // with priority at a merge we simply follow whoever merged in front (see mergeLeader)
      if (k.kind === 'merge' && !k.yield) continue;
      if (this.reserved(k.edge, k.os, this.timeTo(v, dist + k.s, vC))) return 4;
      if (k.yield && !this.gapOk(v, k, dist, C)) return 3;
    }
    if (C.boxCheck && !this.exitSpace(v, C)) return 5;
    return 0;
  }

  protected beforeStep(_dt: number) {
    for (const v of this.vehicles) {
      v.hold = false;
      v.holdWhy = 0;
      const edge = this.input.edges[v.edge];
      if (edge.kind !== EDGE_LANE || v.next < 0 || v.permit) continue;
      // only the vehicle at the head of the lane negotiates the junction; others just follow
      if (this.onEdge[v.edge][0] !== v) continue;
      const C = this.input.edges[v.next];
      if (C.kind !== EDGE_CONNECTOR) continue;
      const controlled = C.arm >= 0 || C.stop || C.giveWay || C.boxCheck || C.conflicts.length > 0;
      if (!controlled) continue;
      const dist = edge.length - v.s;
      const decision = Math.max(25, (v.v * v.v) / (2 * 2.0) + 12);
      if (dist > decision) continue;
      if (v.arrivedAt < 0 && dist < 4 && v.v < 0.6) v.arrivedAt = this.time;
      const why = this.junctionGo(v, C, dist);
      if (why) {
        v.hold = true;
        v.holdWhy = why;
        continue;
      }
      // commit once we are too close to stop comfortably
      const brake = (v.v * v.v) / (2 * 3) + 2;
      if (dist < brake || dist < 3) v.permit = true;
    }
    if (this.crossingClosed.length) {
      for (const v of this.vehicles) {
        if (!v.hold && Number.isFinite(this.crossingStop(v)) && this.crossingStop(v) < 30) v.holdWhy = 7;
      }
    }
  }

  protected signalSnapshot(): Int32Array {
    const out: number[] = [];
    for (const n of this.input.nodes) {
      if (!n.signal) continue;
      for (let arm = 0; arm < n.armCount; arm++) {
        if (!n.signal.phases.some((p) => p.includes(arm))) continue;
        out.push(n.id, arm, this.signalState(n.id, arm));
      }
    }
    return new Int32Array(out);
  }

  accel(v: Vehicle): number {
    const edge = this.input.edges[v.edge];
    const { gap, vl } = this.leader(v);
    let a = this.idm(v, edge.speed, gap, vl);
    // courtesy: hold back behind a neighbour that needs to merge into our lane
    const c = v.courtesyFor;
    if (c) {
      const ce = this.input.edges[c.edge];
      if (c.dead || !ce || this.time > v.courtesyUntil || (ce.left !== v.edge && ce.right !== v.edge)) v.courtesyFor = null;
      else {
        const proj = (c.s / ce.length) * edge.length;
        const g = proj - c.len - 1.5 - v.s;
        // already alongside: holding still cannot open a gap, so let this vehicle move on
        if (g < 0) v.courtesyFor = null;
        else a = Math.min(a, this.idm(v, edge.speed, Math.max(0.1, g), 0));
      }
    }
    // stop line (no route, red light, give way ...)
    const sd = this.stopDistance(v);
    if (Number.isFinite(sd)) a = Math.min(a, this.idm(v, edge.speed, Math.max(0.05, sd), 0));
    // anticipate slower edges ahead (curves, junctions)
    let dist = edge.length - v.s;
    let e = v.next;
    let guard = 0;
    while (e >= 0 && dist < 120 && guard++ < 4) {
      const ne = this.input.edges[e];
      // drivers ease off approaching a give-way or stop line so the go / wait decision is calm
      const yieldApproach = ne.kind === EDGE_CONNECTOR && (ne.giveWay || ne.stop) && !v.permit;
      const target = Math.min(ne.speed * v.v0f, yieldApproach ? 5.5 : Infinity);
      if (v.v > target + 0.5) {
        const need = (target * target - v.v * v.v) / (2 * Math.max(2, dist));
        if (need < -0.2) a = Math.min(a, need * 1.2);
      }
      dist += ne.length;
      e = ne.kind === EDGE_LANE ? this.chooseNext(e, v.dest) : ne.next[0] ?? -1;
    }
    return Math.max(-9, Math.min(v.amax, a));
  }

  private integrate(v: Vehicle, a: number, dt: number) {
    if (v.dead) return;
    v.a = a;
    let nv = v.v + a * dt;
    if (nv < 0) nv = 0;
    let ds = ((v.v + nv) / 2) * dt;
    // hard collision guard
    const { gap } = this.leader(v);
    if (ds > gap - 0.3) ds = Math.max(0, gap - 0.3);
    const sd = this.stopDistance(v);
    if (ds > sd + 0.4) ds = Math.max(0, sd + 0.4);
    if (ds < nv * dt * 0.5) nv = Math.min(nv, ds / dt);
    v.v = nv;
    v.s += ds;
    if (v.lcOffset !== 0) {
      // drivers steer across: the sideways move needs forward motion (at most ~1 m across per
      // 3 m travelled), so a stopped car never slides sideways
      const decay = v.lcTimed ? 2.2 * dt : Math.min(2.2 * dt, ds * 0.33);
      v.lcOffset = Math.abs(v.lcOffset) <= decay ? 0 : v.lcOffset - Math.sign(v.lcOffset) * decay;
      if (v.lcOffset === 0) {
        v.lcFrom = -1;
        v.lcTimed = false;
      }
    }
    if (v.lcCool > 0) v.lcCool -= dt;
    v.stopped = v.v < 0.3 ? v.stopped + dt : 0;
    if (v.stopped > STUCK_REMOVE) {
      this.despawn(v, false);
      return;
    }
    let guard = 0;
    while (!v.dead && v.s > this.input.edges[v.edge].length && guard++ < 4) {
      const edge = this.input.edges[v.edge];
      if (edge.sinkPort === v.dest) {
        this.despawn(v, true);
        return;
      }
      if (v.next < 0 || !this.mayEnter(v, v.next)) {
        v.s = edge.length;
        v.v = 0;
        break;
      }
      const over = v.s - edge.length;
      this.removeFrom(this.onEdge[v.edge], v);
      this.leaveEdge(v, v.edge);
      v.edge = v.next;
      v.s = over;
      v.arrivedAt = -1;
      v.lcFrom = -1; // past the end of the lane it was leaving
      this.insertSorted(this.onEdge[v.edge], v);
      this.plan(v);
    }
  }

  /** junction permission: vehicles holding at the line may not enter */
  protected mayEnter(v: Vehicle, _next: number): boolean {
    return !v.hold;
  }
  protected leaveEdge(_v: Vehicle, _edge: number) {}

  despawn(v: Vehicle, arrived: boolean) {
    v.dead = true;
    // trips to or from houses are local traffic: they don't count towards a site's goals
    const local = this.housePorts.has(v.dest) || this.housePorts.has(v.origin);
    if (arrived && !local) {
      this.arrivals[v.dest] = (this.arrivals[v.dest] ?? 0) + 1;
      if (!this.arrivalTimes.has(v.dest)) this.arrivalTimes.set(v.dest, []);
      this.arrivalTimes.get(v.dest)!.push(this.time);
    }
    if (arrived) {
      this.completed++;
      this.tripSum += this.time - v.born;
    } else this.removed++;
  }

  // ------------------------------------------------------------------ lane changes
  /** Preferred lateral move for v: -1 right, +1 left, 0 stay, plus whether it is mandatory. */
  laneDesire(v: Vehicle): { dir: number; mandatory: boolean; benefit: number } {
    const edge = this.input.edges[v.edge];
    const cost = this.cost.get(v.dest);
    if (!cost || edge.kind !== EDGE_LANE) return { dir: 0, mandatory: false, benefit: 0 };
    const stay = this.directCost(v.edge, v.dest);
    const lc = this.lcCost(v.edge);
    const left = edge.left >= 0 ? cost[edge.left] + lc : Infinity;
    const right = edge.right >= 0 ? cost[edge.right] + lc : Infinity;
    const best = Math.min(left, right);
    if (!(best + 0.5 < stay)) return { dir: 0, mandatory: false, benefit: 0 };
    const dir = left < right ? 1 : -1;
    const remaining = edge.length - v.s;
    // each driver moves over for the lane they need at their own distance from the junction
    // (much earlier when the change is long overdue or the road is short)
    if (!Number.isFinite(stay)) {
      // more lanes to cross, or slow traffic, and the driver starts earlier
      let lanes = 1;
      for (let k = dir > 0 ? edge.left : edge.right; k >= 0 && !Number.isFinite(this.directCost(k, v.dest)) && lanes < 6; k = dir > 0 ? this.input.edges[k].left : this.input.edges[k].right) lanes++;
      const slow = this.laneFlowAhead(v.edge, v.s, v) < edge.speed * 0.6 ? 1.6 : 1;
      if (remaining > v.lcPlan * lanes * slow) return { dir: 0, mandatory: false, benefit: 0 };
      return { dir, mandatory: true, benefit: Infinity };
    }
    const benefit = stay - best;
    if (benefit > 6 && remaining <= v.lcPlan * 1.5) return { dir, mandatory: true, benefit };
    if (benefit < v.lcSense || remaining > v.lcPlan * 1.5) return { dir: 0, mandatory: false, benefit: 0 };
    return { dir, mandatory: false, benefit };
  }

  protected laneChanges(_dt: number) {
    for (const v of this.vehicles) {
      if (v.dead || v.lcCool > 0) continue;
      const edge = this.input.edges[v.edge];
      if (edge.kind !== EDGE_LANE) continue;
      const remaining = edge.length - v.s;
      if (v.s < 3 || remaining < 2) continue;
      const want = this.laneDesire(v);
      let dir = want.dir;
      let mandatory = want.mandatory;
      if (dir === 0) {
        const d = this.discretionary(v);
        if (d === 0) continue;
        dir = d;
        mandatory = false;
      }
      const target = dir > 0 ? edge.left : edge.right;
      if (target < 0) continue;
      const urgency = mandatory ? Math.min(1, Math.max(0, 1 - remaining / 120) + Math.min(1, v.stopped / 8)) : 0;
      const fromEdge = v.edge;
      if (this.tryChange(v, target, urgency, mandatory)) {
        const lw = Math.abs(this.lateralDistance(fromEdge, target));
        v.lcOffset = dir > 0 ? -lw : lw;
        v.lcFrom = fromEdge;
        v.lcTimed = false;
      } else if (mandatory && urgency >= 0.8 && v.v < 2) {
        if (v.stopped > 4 && this.trySwap(v, target, dir)) continue;
        this.askCourtesy(v, target);
      }
    }
  }

  /**
   * Discretionary lane change (MOBIL): change if our acceleration gain outweighs the
   * disadvantage imposed on the new follower (politeness), with a keep-right bias.
   * Returns +1 (left), -1 (right) or 0.
   */
  protected discretionary(v: Vehicle): number {
    const edge = this.input.edges[v.edge];
    const remaining = edge.length - v.s;
    if (v.s < 8 || remaining < 35 || (edge.left < 0 && edge.right < 0)) return 0;
    // drivers glance at the next lane every second or two, not all in the same instant
    if (this.time < v.lcNext) return 0;
    v.lcNext = this.time + this.rng.range(0.8, 2.5);
    const stay = this.directCost(v.edge, v.dest);
    const cost = this.cost.get(v.dest);
    if (!cost) return 0;
    const { gap, vl } = this.leader(v);
    const aCur = this.idm(v, edge.speed, gap, vl);
    if (aCur > v.amax * 0.6 && v.v > edge.speed * v.v0f * 0.9) return 0; // happy where we are
    let best = 0,
      bestGain = v.lcGain;
    const flowHere = this.laneFlowAhead(v.edge, v.s, v);
    for (const dir of [1, -1]) {
      const target = dir > 0 ? edge.left : edge.right;
      if (target < 0) continue;
      // never move into a lane that takes us off our route (or much further from it)
      if (!(cost[target] <= stay + 2)) continue;
      const to = this.input.edges[target];
      const ns = (v.s / edge.length) * to.length;
      let leader: Vehicle | null = null,
        follower: Vehicle | null = null;
      for (const o of this.onEdge[target]) {
        if (o.s >= ns) leader = o;
        else {
          follower = o;
          break;
        }
      }
      const gapF = leader ? leader.s - leader.len - ns : Infinity;
      if (gapF < 4) continue;
      const aNew = this.idm(v, to.speed, gapF, leader ? leader.v : v.v);
      let followerLoss = 0;
      if (follower) {
        const gapB = ns - v.len - follower.s;
        if (gapB < 3) continue;
        const aF = this.idm(follower, to.speed, gapB, v.v);
        if (aF < -2) continue;
        followerLoss = Math.max(0, follower.a - aF);
      }
      const keepRight = dir < 0 ? v.keepRight : -v.keepRight * 0.6;
      // a lane that is moving better further ahead is worth something too
      const ahead = 0.08 * (this.laneFlowAhead(target, ns, null) - flowHere);
      const gain = aNew - aCur - 0.3 * followerLoss + keepRight + ahead;
      if (gain > bestGain) {
        bestGain = gain;
        best = dir;
      }
    }
    return best;
  }

  /** Average speed of the traffic up to ~80 m ahead in a lane (the speed limit when empty). */
  private laneFlowAhead(edge: number, s: number, except: Vehicle | null): number {
    const e = this.input.edges[edge];
    let sum = 0,
      n = 0;
    for (const o of this.onEdge[edge]) {
      if (o === except || o.s <= s || o.s > s + 80) continue;
      sum += o.v;
      n++;
    }
    return n ? sum / n : e.speed;
  }

  private lateralDistance(from: number, to: number) {
    const a = this.input.edges[from],
      b = this.input.edges[to];
    return Math.hypot(a.pts[0] - b.pts[0], a.pts[1] - b.pts[1]) || 3.5;
  }

  /** Does a vehicle of length `len` with its front at `s` fit into `list` (ignoring `except`)? */
  private fits(list: Vehicle[], s: number, len: number, except: Vehicle): boolean {
    for (const o of list) {
      if (o === except) continue;
      if (o.s - o.len < s + 0.3 && o.s > s - len - 0.3) return false;
    }
    return true;
  }

  /** Ask the vehicle beside/behind us in the target lane to leave a gap. */
  private askCourtesy(v: Vehicle, target: number) {
    const from = this.input.edges[v.edge];
    const to = this.input.edges[target];
    const ns = (v.s / from.length) * to.length;
    for (const u of this.onEdge[target]) {
      if (u.s > ns - v.len - 1.5) continue; // ahead of or alongside the slot we need
      if (u.courtesyFor && u.courtesyFor !== v) return;
      if (ns - u.s > 40) return;
      u.courtesyFor = v;
      u.courtesyUntil = this.time + 12;
      return;
    }
  }

  /**
   * Deadlock breaker: two stopped vehicles side by side that each need the other's lane
   * trade places (one lets the other across).
   */
  private trySwap(v: Vehicle, target: number, dir: number) {
    const from = this.input.edges[v.edge];
    const to = this.input.edges[target];
    const ns = (v.s / from.length) * to.length;
    for (const u of this.onEdge[target]) {
      if (u.v > 0.5 || u.lcCool > 0 || Math.abs(u.s - ns) > Math.max(v.len, u.len)) continue;
      const want = this.laneDesire(u);
      if (!want.mandatory || want.dir !== -dir) continue;
      const us = (u.s / to.length) * from.length;
      // both vehicles must fit in their new lanes without touching anyone else
      if (!this.fits(this.onEdge[target], Math.min(ns, to.length - 0.5), v.len, u) || !this.fits(this.onEdge[v.edge], Math.min(us, from.length - 0.5), u.len, v)) continue;
      this.removeFrom(this.onEdge[v.edge], v);
      this.removeFrom(this.onEdge[target], u);
      const lw = Math.abs(this.lateralDistance(v.edge, target));
      u.edge = v.edge;
      u.s = Math.min(us, from.length - 0.5);
      v.edge = target;
      v.s = Math.min(ns, to.length - 0.5);
      this.insertSorted(this.onEdge[v.edge], v);
      this.insertSorted(this.onEdge[u.edge], u);
      v.lcOffset = dir > 0 ? -lw : lw;
      u.lcOffset = -v.lcOffset;
      v.lcTimed = u.lcTimed = true;
      v.lcFrom = u.lcFrom = -1;
      v.lcCool = u.lcCool = 2;
      v.stopped = u.stopped = 0;
      this.plan(v);
      this.plan(u);
      this.lcMandatory += 2;
      return true;
    }
    return false;
  }

  /** Gap acceptance + execution of a lane change into `target`. */
  protected tryChange(v: Vehicle, target: number, urgency: number, mandatory: boolean): boolean {
    const from = this.input.edges[v.edge];
    const to = this.input.edges[target];
    const ns0 = (v.s / from.length) * to.length;
    const list = this.onEdge[target];
    // candidate positions: alongside, or (stuck at the lane end) dropping back into a gap behind
    const candidates = [ns0];
    if (mandatory && urgency >= 0.9 && v.v < 1) {
      for (const o of list) {
        const p = o.s - o.len - 1;
        if (p < ns0 && p > ns0 - 40) candidates.push(p);
      }
    }
    for (const ns of candidates) {
      if (ns > to.length - 2 || ns < v.len) continue;
      let leader: Vehicle | null = null,
        follower: Vehicle | null = null;
      for (const o of list) {
        if (o.s >= ns) leader = o;
        else {
          follower = o;
          break;
        }
      }
      let minFront = mandatory ? Math.max(0.8, 2 + v.v * 0.6 * (1 - urgency)) : 3 + v.v * 0.8;
      // from (almost) standstill a car can only change lanes by pulling forward into a gap
      if (v.v < 2) minFront = Math.max(minFront, 6);
      const gapFront = leader ? leader.s - leader.len - ns : Infinity;
      if (gapFront < minFront) continue;
      if (follower) {
        const gapBack = ns - v.len - follower.s;
        if (gapBack < (mandatory ? 0.8 + (1 - urgency) * 2 : 3)) continue;
        const fa = this.idm(follower, to.speed, gapBack, v.v);
        // never force the car behind to brake harder than ~2.5 m/s² unless we are stuck at the lane end
        const bsafe = mandatory ? 2.5 + (urgency > 0.9 && v.v < 1 ? 2.5 : urgency) : 2;
        if (fa < -bsafe) continue;
      }
      if (!mandatory) {
        // the change must not leave us braking harder than staying
        const aNew = this.idm(v, to.speed, gapFront, leader ? leader.v : v.v);
        if (aNew < -2) continue;
      }
      this.removeFrom(this.onEdge[v.edge], v);
      v.edge = target;
      v.s = ns;
      v.courtesyFor = null;
      this.insertSorted(list, v);
      v.lcCool = mandatory ? 1.5 : 4;
      if (mandatory) this.lcMandatory++;
      else this.lcDiscretionary++;
      v.arrivedAt = -1;
      this.plan(v);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ stats + snapshots
  private updateStats(dt: number) {
    const alpha = Math.min(1, dt / 20);
    const sum = new Float64Array(this.input.edges.length);
    const cnt = new Uint16Array(this.input.edges.length);
    for (const v of this.vehicles) {
      sum[v.edge] += v.v;
      cnt[v.edge]++;
    }
    for (const e of this.input.edges) {
      const target = cnt[e.id] ? sum[e.id] / cnt[e.id] : e.speed;
      this.speedEma[e.id] += (target - this.speedEma[e.id]) * alpha;
    }
    for (const times of this.arrivalTimes.values()) {
      while (times.length && times[0] < this.time - FLOW_WINDOW) times.shift();
    }
  }

  stats(): SimStats {
    const flow: Record<number, number> = {};
    const backlog: Record<number, number> = {};
    const window = Math.min(FLOW_WINDOW, Math.max(30, this.time));
    for (const p of this.input.ports) {
      const t = this.arrivalTimes.get(p.id) ?? [];
      flow[p.id] = (t.length / window) * 60;
      backlog[p.id] = this.queues.get(p.id)?.length ?? 0;
    }
    const edgeFlow = new Float32Array(this.input.edges.length).fill(NaN);
    const has = new Uint8Array(this.input.edges.length);
    for (const v of this.vehicles) has[v.edge] = 1;
    for (const e of this.input.edges) if (has[e.id] || this.speedEma[e.id] < e.speed * 0.95) edgeFlow[e.id] = Math.min(1, this.speedEma[e.id] / e.speed);
    return {
      time: this.time,
      vehicles: this.vehicles.length,
      arrivals: { ...this.arrivals },
      flow,
      backlog,
      stuck: this.vehicles.filter((v) => v.stopped > STUCK_FLAG).length,
      removed: this.removed,
      edgeFlow,
      completed: this.completed,
      meanTrip: this.completed ? this.tripSum / this.completed : 0,
    };
  }

  /** Position + heading on an edge at arc length s. */
  sample(edge: SimEdge, s: number) {
    const cum = edge.cum;
    let lo = 0,
      hi = cum.length - 2;
    if (s <= 0) s = 0;
    if (s >= edge.length) s = edge.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    const i = Math.max(0, lo),
      j = Math.min(i + 1, cum.length - 1);
    const seg = cum[j] - cum[i] || 1;
    const t = Math.min(1, Math.max(0, (s - cum[i]) / seg));
    const x0 = edge.pts[i * 2],
      y0 = edge.pts[i * 2 + 1],
      x1 = edge.pts[j * 2],
      y1 = edge.pts[j * 2 + 1];
    return {
      x: x0 + (x1 - x0) * t,
      y: y0 + (y1 - y0) * t,
      z: edge.z[i] + ((edge.z[j] ?? edge.z[i]) - edge.z[i]) * t,
      h: Math.atan2(y1 - y0, x1 - x0),
    };
  }

  /** Like sample(), but positions before the start of the edge extend straight back along its first tangent. */
  sampleBack(edge: SimEdge, s: number) {
    if (s >= 0) return this.sample(edge, s);
    const p = this.sample(edge, 0);
    const tx = edge.pts[2] - edge.pts[0],
      ty = edge.pts[3] - edge.pts[1];
    const L = Math.hypot(tx, ty) || 1;
    return { x: p.x + (tx / L) * s, y: p.y + (ty / L) * s, z: p.z, h: p.h };
  }

  /** Planned path of a vehicle (current edge onwards) for the route overlay. */
  /**
   * Path finder: the whole route from the vehicle's position to its destination, following
   * the cost-to-go downhill — including the lane changes it still has to make. `reachable` is
   * false when there is no way to the destination from here (what leaves a car stuck).
   */
  pathOf(v: Vehicle): { edges: number[]; reachable: boolean; eta: number } {
    const cost = this.cost.get(v.dest);
    const edges = [v.edge];
    if (!cost) return { edges, reachable: false, eta: Infinity };
    const first = this.input.edges[v.edge];
    const eta = first.kind === EDGE_LANE ? Math.min(this.directCost(v.edge, v.dest), cost[v.edge]) : cost[v.edge];
    let e = v.edge;
    const seen = new Set<number>([e]);
    for (let guard = 0; guard < 800; guard++) {
      const edge = this.input.edges[e];
      if (edge.sinkPort === v.dest) return { edges, reachable: true, eta };
      let best = -1,
        bc = Infinity;
      for (const n of edge.next) {
        const c = this.edgeTime[e] + cost[n];
        if (c < bc) {
          bc = c;
          best = n;
        }
      }
      if (edge.kind === EDGE_LANE) {
        for (const side of [edge.left, edge.right]) {
          if (side < 0) continue;
          const c = this.lcCost(e) + cost[side];
          if (c + 1e-9 < bc) {
            bc = c;
            best = side;
          }
        }
      }
      if (best < 0 || !Number.isFinite(bc) || seen.has(best)) break;
      seen.add(best);
      edges.push(best);
      e = best;
    }
    return { edges, reachable: false, eta: Infinity };
  }

  /** Take a vehicle off the road (the player clearing a stuck car). */
  removeVehicle(id: number) {
    const v = this.vehicles.find((x) => x.id === id);
    if (!v) return;
    this.despawn(v, false);
    this.vehicles = this.vehicles.filter((x) => !x.dead);
    this.rebuildEdgeLists();
  }

  routeOf(v: Vehicle, max = 60): number[] {
    const path = [v.edge];
    let e = v.next;
    let guard = 0;
    while (e >= 0 && guard++ < max) {
      path.push(e);
      const edge = this.input.edges[e];
      e = edge.kind === EDGE_LANE ? this.chooseNext(e, v.dest) : edge.next[0] ?? -1;
    }
    return path;
  }

  snapshot(inspect: number | null = null): Snapshot {
    const n = this.vehicles.length;
    const vehicles = new Float32Array(n * VEH_STRIDE);
    const ids = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const v = this.vehicles[i];
      const edge = this.input.edges[v.edge];
      // front and rear axle points; the body points from rear to front so long vehicles
      // swing naturally through turns instead of snapping to a single sample
      const front = this.sample(edge, v.s - 0.6);
      const rear = this.sampleBack(edge, v.s - v.len + 0.8);
      const hx = front.x - rear.x,
        hy = front.y - rear.y;
      const mid = v.len / 2 - 0.1;
      const L = Math.hypot(hx, hy) || 1;
      const p = {
        x: front.x - (hx / L) * (mid - 0.6),
        y: front.y - (hy / L) * (mid - 0.6),
        z: (front.z + rear.z) / 2,
        h: L > 0.5 ? Math.atan2(hy, hx) : front.h,
      };
      let x = p.x,
        y = p.y;
      if (v.lcOffset) {
        x += -Math.sin(p.h) * v.lcOffset;
        y += Math.cos(p.h) * v.lcOffset;
      }
      const o = i * VEH_STRIDE;
      vehicles[o] = x;
      vehicles[o + 1] = y;
      vehicles[o + 2] = p.z;
      vehicles[o + 3] = p.h + (v.lcOffset ? -Math.sign(v.lcOffset) * Math.min(0.25, Math.abs(v.lcOffset) * 0.08) : 0);
      vehicles[o + 4] = v.len;
      vehicles[o + 5] = v.width;
      vehicles[o + 6] = v.color;
      vehicles[o + 7] = (v.a < -1 ? 1 : 0) | (v.stopped > STUCK_FLAG ? 2 : 0) | (v.type === 2 ? 4 : 0) | (p.z < -9 ? 8 : 0);
      ids[i] = v.id;
    }
    const trains = this.trainSnapshot();
    let inspected: Snapshot['inspected'] = null;
    if (inspect !== null) {
      const v = this.vehicles.find((x) => x.id === inspect);
      if (v) {
        const path = this.pathOf(v);
        inspected = { id: v.id, edges: path.edges, dest: v.dest, wait: v.stopped, reachable: path.reachable, eta: path.eta, holdWhy: v.holdWhy };
      }
    }
    return {
      time: this.time,
      tick: this.tick,
      vehicles,
      vehicleCount: n,
      ids,
      trains: trains.data,
      trainCount: trains.count,
      trainIds: trains.ids,
      signals: this.signalSnapshot(),
      crossings: this.crossingSnapshot(),
      stats: this.stats(),
      inspected,
    };
  }

  protected trainSnapshot(): { data: Float32Array; count: number; ids: Int32Array } {
    const n = this.trains.reduce((a, t) => a + t.cars, 0);
    const data = new Float32Array(n * TRAIN_STRIDE);
    const ids = new Int32Array(n);
    let i = 0;
    for (const t of this.trains) {
      const edge = this.input.rail.edges[t.edge];
      for (let k = 0; k < t.cars; k++) {
        const sc = t.s - k * CAR_LEN - CAR_LEN / 2;
        const p = this.sample(edge, Math.max(0, Math.min(edge.length, sc)));
        const o = i * TRAIN_STRIDE;
        data[o] = p.x;
        data[o + 1] = p.y;
        data[o + 2] = p.z;
        data[o + 3] = p.h;
        data[o + 4] = sc < 0 || sc > edge.length ? 0 : CAR_LEN - 1;
        ids[i] = t.id * 64 + k;
        i++;
      }
    }
    return { data, count: n, ids };
  }
  protected crossingSnapshot(): Int8Array {
    return Int8Array.from(this.crossingClosed);
  }

  /** Hash of the simulation state, used by determinism tests. */
  hash(): number {
    let h = 2166136261 >>> 0;
    const mix = (x: number) => {
      h ^= x >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(this.tick);
    for (const v of this.vehicles) {
      mix(v.id);
      mix(v.edge);
      mix(Math.round(v.s * 1000));
      mix(Math.round(v.v * 1000));
    }
    return h >>> 0;
  }
}
