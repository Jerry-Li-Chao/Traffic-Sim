// Road class catalogue. Widths in metres, speeds in km/h, cost in $ per metre at ground level.

export type RoadGroup = 'Street' | 'Avenue' | 'Highway';
export type MedianKind = 'none' | 'paint' | 'grass' | 'barrier';

export interface RoadClass {
  id: string;
  name: string;
  group: RoadGroup;
  lanesF: number;
  lanesB: number;
  laneWidth: number;
  speedKmh: number;
  median: number;
  medianKind: MedianKind;
  shoulder: number;
  sidewalk: number;
  costPerM: number;
  /** rank used to auto-pick major roads at priority junctions */
  rank: number;
  /** hidden from the build palette (used by tools) */
  hidden?: boolean;
  /** highways get no crosswalks and dashed lines are longer */
  highway?: boolean;
}

export const ROAD_CLASSES: RoadClass[] = [
  { id: 'lane', name: 'Country lane', group: 'Street', lanesF: 1, lanesB: 1, laneWidth: 3.0, speedKmh: 50, median: 0, medianKind: 'none', shoulder: 0.3, sidewalk: 0, costPerM: 60, rank: 1 },
  { id: 'street', name: 'Street', group: 'Street', lanesF: 1, lanesB: 1, laneWidth: 3.5, speedKmh: 50, median: 0, medianKind: 'paint', shoulder: 0.3, sidewalk: 2, costPerM: 100, rank: 2 },
  { id: 'oneway1', name: 'One-way lane', group: 'Street', lanesF: 1, lanesB: 0, laneWidth: 3.5, speedKmh: 50, median: 0, medianKind: 'none', shoulder: 0.3, sidewalk: 2, costPerM: 75, rank: 2 },
  { id: 'oneway', name: 'One-way street', group: 'Street', lanesF: 2, lanesB: 0, laneWidth: 3.5, speedKmh: 50, median: 0, medianKind: 'none', shoulder: 0.3, sidewalk: 2, costPerM: 110, rank: 2 },
  { id: 'avenue', name: 'Avenue', group: 'Avenue', lanesF: 2, lanesB: 2, laneWidth: 3.5, speedKmh: 60, median: 0.4, medianKind: 'paint', shoulder: 0.3, sidewalk: 2.5, costPerM: 220, rank: 3 },
  { id: 'boulevard', name: 'Boulevard', group: 'Avenue', lanesF: 2, lanesB: 2, laneWidth: 3.5, speedKmh: 60, median: 4, medianKind: 'grass', shoulder: 0.3, sidewalk: 2.5, costPerM: 300, rank: 4 },
  { id: 'ramp', name: 'Ramp', group: 'Highway', lanesF: 1, lanesB: 0, laneWidth: 3.75, speedKmh: 60, median: 0, medianKind: 'none', shoulder: 1, sidewalk: 0, costPerM: 170, rank: 4, highway: true },
  { id: 'ramp2', name: 'Two-lane ramp', group: 'Highway', lanesF: 2, lanesB: 0, laneWidth: 3.75, speedKmh: 70, median: 0, medianKind: 'none', shoulder: 1, sidewalk: 0, costPerM: 260, rank: 4, highway: true },
  { id: 'highway', name: 'Highway', group: 'Highway', lanesF: 2, lanesB: 0, laneWidth: 3.75, speedKmh: 100, median: 0, medianKind: 'none', shoulder: 1.5, sidewalk: 0, costPerM: 340, rank: 6, highway: true },
  { id: 'highway3', name: 'Wide highway', group: 'Highway', lanesF: 3, lanesB: 0, laneWidth: 3.75, speedKmh: 110, median: 0, medianKind: 'none', shoulder: 1.5, sidewalk: 0, costPerM: 450, rank: 6, highway: true },
  { id: 'motorway', name: 'Motorway', group: 'Highway', lanesF: 2, lanesB: 2, laneWidth: 3.75, speedKmh: 110, median: 3, medianKind: 'barrier', shoulder: 1.5, sidewalk: 0, costPerM: 640, rank: 7, highway: true },
  // tool-only classes
  { id: 'roundabout', name: 'Roundabout', group: 'Street', lanesF: 1, lanesB: 0, laneWidth: 4.5, speedKmh: 35, median: 0, medianKind: 'none', shoulder: 0.5, sidewalk: 0, costPerM: 160, rank: 5, hidden: true },
  { id: 'roundabout2', name: 'Two-lane roundabout', group: 'Street', lanesF: 2, lanesB: 0, laneWidth: 4.0, speedKmh: 40, median: 0, medianKind: 'none', shoulder: 0.5, sidewalk: 0, costPerM: 240, rank: 5, hidden: true },
];

export const CLASS_BY_ID: Record<string, RoadClass> = Object.fromEntries(ROAD_CLASSES.map((c) => [c.id, c]));

export const getClass = (id: string): RoadClass => CLASS_BY_ID[id] ?? CLASS_BY_ID.street;

export const PALETTE_CLASSES = ROAD_CLASSES.filter((c) => !c.hidden);

export const kmh = (v: number) => v / 3.6;

// ---------------------------------------------------------------------------
// Height levels

export const MIN_LEVEL = -2;
export const MAX_LEVEL = 4;
export const LEVEL_STEP = 6; // metres per level
export const levelZ = (level: number) => level * LEVEL_STEP;
export const LEVEL_NAMES: Record<number, string> = {
  [-2]: 'Tunnel',
  [-1]: 'Cutting',
  0: 'Ground',
  1: 'Bridge',
  2: 'Viaduct',
  3: 'Viaduct +',
  4: 'Viaduct ++',
};
/** vertical clearance needed for two roads to cross without connecting */
export const CLEARANCE = 5;
/** maximum grade along a road */
export const MAX_GRADE = 0.13;
/** z below which a road is underground (tunnel) */
export const TUNNEL_Z = -9;
