import { Sim } from '../src/sim/Sim';
import { buildLevelWorld, compileLevel } from '../src/game/loadLevel';
import type { LevelDef } from '../src/game/level';
import type { World } from '../src/world/World';
import { EDGE_CONNECTOR } from '../src/sim/types';

export function level(over: Partial<LevelDef>): LevelDef {
  return {
    id: 't', name: 't', brief: '', width: 1000, height: 1000, seed: 7, budget: Infinity, treeDensity: 0,
    allowed: [], ports: [], demand: [], goals: [], hold: 60, rampUp: 0, ...over,
  };
}

export function setup(def: LevelDef, mutate?: (w: World) => void) {
  const { world, ports } = buildLevelWorld(def);
  mutate?.(world);
  const input = compileLevel(world, def, ports);
  const sim = new Sim();
  sim.load(input);
  return { sim, world, ports, input };
}

export function run(sim: Sim, seconds: number, each?: (sim: Sim) => void) {
  const steps = Math.round(seconds / 0.1);
  for (let i = 0; i < steps; i++) {
    sim.step();
    each?.(sim);
  }
}

export function assertNoOverlap(sim: Sim) {
  for (const list of sim.onEdge) {
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const gap = a.s - a.len - b.s;
      if (gap < -0.05) throw new Error(`overlap on edge ${a.edge}: ${gap.toFixed(2)} (veh ${a.id}, ${b.id})`);
    }
  }
}

/** Count simultaneous occupation of conflict points by vehicles on crossing connectors. */
export function conflictCollisions(sim: Sim): number {
  let n = 0;
  for (const e of sim.input.edges) {
    if (e.kind !== EDGE_CONNECTOR) continue;
    for (const k of e.conflicts) {
      if (k.edge < e.id || k.kind !== 'cross') continue;
      const occ = (edge: number, s: number) => sim.onEdge[edge].some((u) => u.s >= s - 0.5 && u.s - u.len <= s + 0.5);
      if (occ(e.id, k.s) && occ(k.edge, k.os)) n++;
    }
  }
  return n;
}

const W = Math.PI;
export const fourWay = (cls = 'street', extra: Partial<LevelDef> = {}) =>
  level({
    ports: [
      { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls, kind: 'edge' },
      { id: 2, name: 'E', color: '#0f0', x: 1000, y: 500, dir: W, cls, kind: 'edge' },
      { id: 3, name: 'N', color: '#00f', x: 500, y: 1000, dir: -W / 2, cls, kind: 'edge' },
      { id: 4, name: 'S', color: '#ff0', x: 500, y: 0, dir: W / 2, cls, kind: 'edge' },
    ],
    prebuilt: [
      { pts: [[40, 500], [500, 500], [960, 500]], cls },
      { pts: [[500, 960], [500, 500]], cls },
      { pts: [[500, 500], [500, 40]], cls },
    ],
    demand: [
      { from: 1, to: 2, perMin: 10 }, { from: 2, to: 1, perMin: 10 },
      { from: 3, to: 4, perMin: 6 }, { from: 4, to: 3, perMin: 6 },
      { from: 1, to: 3, perMin: 3 }, { from: 3, to: 2, perMin: 3 },
      { from: 2, to: 4, perMin: 3 }, { from: 4, to: 1, perMin: 3 },
    ],
    ...extra,
  });
