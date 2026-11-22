// Data compiled from the editable world and handed to the simulation.
// Plain JSON-friendly objects so they can be posted to the worker.

export const EDGE_LANE = 0;
export const EDGE_CONNECTOR = 1;

export type ConflictKind = 'cross' | 'merge';

export interface SimConflict {
  /** the other connector edge id */
  edge: number;
  /** arc length on this edge where paths meet */
  s: number;
  /** arc length on the other edge */
  os: number;
  kind: ConflictKind;
  /** true when THIS edge must yield to the other one */
  yield: boolean;
}

export interface SimEdge {
  id: number;
  /** stable key used to preserve vehicles across network rebuilds */
  key: string;
  kind: 0 | 1;
  /** x,y pairs */
  pts: number[];
  /** z per vertex */
  z: number[];
  cum: number[];
  length: number;
  /** speed limit, m/s */
  speed: number;
  /** following edges (lanes -> connectors, connectors -> [lane]) */
  next: number[];
  /** adjacent lane edges in the same direction (-1 if none). left = towards centre */
  left: number;
  right: number;
  /** lane: segment id; connector: -1 */
  seg: number;
  /** node at the end of this edge (lane) / node the connector belongs to */
  node: number;
  /** port id if vehicles despawn at the end of this edge */
  sinkPort: number;
  // ---- connector-only control data
  /** signal arm index (connector), -1 = unsignalised */
  arm: number;
  /** stop sign: must come to a halt before entering */
  stop: boolean;
  /** give way to conflicting priority traffic before entering */
  giveWay: boolean;
  /** check that the exit lane has space before entering (don't block the box) */
  boxCheck: boolean;
  conflicts: SimConflict[];
  /** level crossings along this edge */
  crossings: { id: number; s: number; clear?: number }[];
}

export interface SimSignal {
  /** arms (indices) that are green in each phase */
  phases: number[][];
  green: number[];
  amber: number;
  allRed: number;
  offset: number;
}

export interface SimNode {
  id: number;
  signal: SimSignal | null;
  armCount: number;
}

export interface SimPort {
  id: number;
  name: string;
  /** lane edges where vehicles leaving this port spawn */
  spawnEdges: number[];
  /** lane edges whose end is this port (despawn) */
  sinkEdges: number[];
  /** a player-built house: makes and takes a trickle of trips, at most two cars each way */
  house?: boolean;
}

export interface SimDemand {
  from: number;
  to: number;
  /** vehicles per minute at full demand */
  perMin: number;
  /** share of trucks 0..1 */
  trucks?: number;
}

export interface RailService {
  /** ordered list of rail edge ids the train runs along */
  path: number[];
  /** seconds between trains */
  headway: number;
  /** first departure time */
  offset: number;
  cars: number;
  speed: number;
}

export interface SimRail {
  edges: SimEdge[];
  services: RailService[];
  /** level crossing ids with their rail edge + arc length */
  crossings: { id: number; edge: number; s: number; x: number; y: number }[];
}

export interface SimInput {
  seed: number;
  edges: SimEdge[];
  nodes: SimNode[];
  ports: SimPort[];
  demand: SimDemand[];
  rail: SimRail;
  /** ramp demand up over this many seconds */
  rampUp: number;
}

export interface SimStats {
  time: number;
  vehicles: number;
  /** arrivals per port id over the whole run */
  arrivals: Record<number, number>;
  /** rolling arrivals per minute per port id */
  flow: Record<number, number>;
  /** vehicles waiting to spawn per port id */
  backlog: Record<number, number>;
  /** vehicles currently stuck > 30 s */
  stuck: number;
  /** vehicles removed because they were gridlocked */
  removed: number;
  /** average speed / limit per edge id (NaN when empty) */
  edgeFlow: Float32Array;
  /** total trips completed */
  completed: number;
  /** mean trip time of completed trips (s) */
  meanTrip: number;
}

export function emptyRail(): SimRail {
  return { edges: [], services: [], crossings: [] };
}

export function emptyInput(seed = 1): SimInput {
  return { seed, edges: [], nodes: [], ports: [], demand: [], rail: emptyRail(), rampUp: 60 };
}
