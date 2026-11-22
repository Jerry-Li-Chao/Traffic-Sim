// Level ("site") definition format shared by the campaign, sandbox and save files.

export interface PortDef {
  id: number;
  name: string;
  color: string;
  /** position of the port node */
  x: number;
  y: number;
  /** direction (radians) of the stub road pointing INTO the site */
  dir: number;
  cls: string;
  /** 'edge' = road leaving the map, 'town' = destination signboard inside the site */
  kind: 'edge' | 'town';
  stub?: number;
  level?: number;
  /** one-way ports: 'in' (traffic enters the site) or 'out' (traffic leaves). Default: both. */
  flow?: 'in' | 'out';
}

export interface PrebuiltRoad {
  pts: [number, number][];
  cls: string;
  control?: [number, number];
  level?: number;
  /** level of the end point when different from `level` */
  endLevel?: number;
  locked?: boolean;
}

export interface RailDef {
  /** polyline of the track (straight pieces between points) */
  pts: [number, number][];
  level?: number;
  /** trains per hour each way */
  perHour: number;
  speedKmh?: number;
  cars?: number;
}

export interface LevelDef {
  id: string;
  name: string;
  brief: string;
  width: number;
  height: number;
  seed: number;
  /** Infinity for sandbox */
  budget: number;
  treeDensity: number;
  allowed: string[];
  ports: PortDef[];
  demand: { from: number; to: number; perMin: number; trucks?: number }[];
  goals: { port: number; minPerMin: number }[];
  prebuilt?: PrebuiltRoad[];
  rails?: RailDef[];
  obstacles?: { kind: 'water' | 'town'; pts: [number, number][]; name?: string }[];
  /** highways (and ramps) may not cross anything at the same level: interchanges only */
  gradeSeparated?: boolean;
  /** seconds all goals must hold to complete the site */
  hold: number;
  rampUp?: number;
  tutorial?: TipStep[];
}

export const PORT_COLORS = ['#d9822b', '#2f7fd6', '#8e44ad', '#c0392b', '#16a085', '#b7950b', '#d35400', '#2c3e50'];

/** A tutorial tip: plain text, or text with an illustrated figure (see ui/TipFigures). */
export type TipStep = string | { text: string; figure: string };
