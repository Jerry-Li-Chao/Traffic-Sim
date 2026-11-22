// Messages exchanged between the main thread and the simulation worker.
import type { SimInput } from './types';
import type { SimStats } from './types';

export const SIM_DT = 0.1; // seconds of sim time per tick (fixed)

export type ToWorker =
  | { type: 'load'; input: SimInput }
  | { type: 'update'; input: SimInput }
  | { type: 'run'; running: boolean }
  | { type: 'speed'; speed: number }
  | { type: 'reset' }
  | { type: 'inspect'; vehicleId: number | null }
  /** take a (stuck) vehicle off the road */
  | { type: 'removeVehicle'; vehicleId: number }
  /** run N seconds of sim time immediately (tests / fast-forward) */
  | { type: 'advance'; seconds: number };

export interface Snapshot {
  time: number;
  tick: number;
  /** per vehicle: x, y, z, heading, length, width, color, flags */
  vehicles: Float32Array;
  vehicleCount: number;
  /** vehicle ids aligned with `vehicles` rows */
  ids: Int32Array;
  /** per train car: x, y, z, heading, length */
  trains: Float32Array;
  trainCount: number;
  /** stable id per train car (for smoothing between snapshots) */
  trainIds: Int32Array;
  /** signal heads: nodeId, armIndex, state(0 red,1 amber,2 green) triples */
  signals: Int32Array;
  /** crossing barrier state per crossing id (1 closed) */
  crossings: Int8Array;
  stats: SimStats;
  inspected: {
    id: number;
    /** the full planned path from where the vehicle is now (lane edges, connectors, lane changes) */
    edges: number[];
    dest: number;
    wait: number;
    /** false: no route from here to the destination */
    reachable: boolean;
    /** estimated seconds to the destination along the planned path */
    eta: number;
    /** why it is holding (see Vehicle.holdWhy) */
    holdWhy: number;
  } | null;
}

export type FromWorker = { type: 'snapshot'; snap: Snapshot } | { type: 'ready' } | { type: 'error'; message: string; /** traffic was restarted and keeps running */ recovered?: boolean };

export const VEH_STRIDE = 8;
export const TRAIN_STRIDE = 5;

/** Simulated seconds per real second at the "1×" speed setting (2× and 4× scale from this). */
export const TIME_SCALE = 2;
