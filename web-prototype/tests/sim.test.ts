import { describe, it, expect } from 'vitest';
import { Sim } from '../src/sim/Sim';
import { buildLevelWorld, compileLevel } from '../src/game/loadLevel';
import type { LevelDef } from '../src/game/level';

export function level(over: Partial<LevelDef>): LevelDef {
  return {
    id: 't', name: 't', brief: '', width: 1000, height: 600, seed: 7, budget: Infinity, treeDensity: 0,
    allowed: [], ports: [], demand: [], goals: [], hold: 60, rampUp: 0, ...over,
  };
}

export function runSim(def: LevelDef, seconds: number, check?: (sim: Sim) => void) {
  const { world, ports } = buildLevelWorld(def);
  const input = compileLevel(world, def, ports);
  const sim = new Sim();
  sim.load(input);
  const steps = Math.round(seconds / 0.1);
  for (let i = 0; i < steps; i++) {
    sim.step();
    if (check && i % 10 === 0) check(sim);
  }
  return { sim, world, ports, input };
}

/** No two vehicles on the same edge overlap. */
export function assertNoOverlap(sim: Sim) {
  for (const list of sim.onEdge) {
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const gap = a.s - a.len - b.s;
      if (gap < -0.05) throw new Error(`overlap on edge ${a.edge}: ${gap.toFixed(2)} (veh ${a.id}, ${b.id})`);
    }
  }
}

const straight = level({
  ports: [
    { id: 1, name: 'West', color: '#f00', x: 0, y: 300, dir: 0, cls: 'street', kind: 'edge' },
    { id: 2, name: 'East', color: '#00f', x: 1000, y: 300, dir: Math.PI, cls: 'street', kind: 'edge' },
  ],
  prebuilt: [{ pts: [[40, 300], [960, 300]], cls: 'street' }],
  demand: [
    { from: 1, to: 2, perMin: 12 },
    { from: 2, to: 1, perMin: 6 },
  ],
});

describe('traffic core', () => {
  it('compiles lanes and ports', () => {
    const { world, ports } = buildLevelWorld(straight);
    const input = compileLevel(world, straight, ports);
    expect(input.ports.length).toBe(2);
    expect(input.ports[0].spawnEdges.length).toBe(1);
    expect(input.ports[0].sinkEdges.length).toBe(1);
    expect(input.edges.some((e) => e.sinkPort === 2)).toBe(true);
  });

  it('vehicles travel from entry to destination', () => {
    const { sim } = runSim(straight, 400, assertNoOverlap);
    const st = sim.stats();
    expect(st.arrivals[2]).toBeGreaterThan(40);
    expect(st.arrivals[1]).toBeGreaterThan(15);
    expect(st.removed).toBe(0);
    // ~1000 m at ~50 km/h -> ~75 s
    expect(st.meanTrip).toBeGreaterThan(60);
    expect(st.meanTrip).toBeLessThan(110);
  });

  it('is deterministic', () => {
    const a = runSim(straight, 120).sim.hash();
    const b = runSim(straight, 120).sim.hash();
    expect(a).toBe(b);
    const c = runSim({ ...straight, seed: 99 }, 120).sim.hash();
    expect(c).not.toBe(a);
  });

  it('queues behind a slow bottleneck without overlapping', () => {
    const def = level({
      ports: straight.ports,
      prebuilt: [
        { pts: [[40, 300], [500, 300]], cls: 'avenue' },
        // tight S-bend bottleneck forces low speed
        { pts: [[500, 300], [600, 300]], cls: 'lane', control: [550, 360] },
        { pts: [[600, 300], [960, 300]], cls: 'avenue' },
      ],
      demand: [{ from: 1, to: 2, perMin: 45 }],
    });
    const { sim } = runSim(def, 300, assertNoOverlap);
    // a queue forms upstream: some vehicles are slow/stopped on the approach
    const slow = sim.vehicles.filter((v) => v.v < 3).length;
    expect(slow).toBeGreaterThan(3);
    expect(sim.stats().arrivals[2]).toBeGreaterThan(30);
  });

  it('vehicles change lanes to reach their exit', () => {
    // one-way 2-lane road that splits: left branch to North, right branch to South
    const def = level({
      width: 1200, height: 800,
      ports: [
        { id: 1, name: 'W', color: '#f00', x: 0, y: 400, dir: 0, cls: 'oneway', kind: 'edge' },
        { id: 2, name: 'N', color: '#0f0', x: 1200, y: 600, dir: Math.PI, cls: 'street', kind: 'edge' },
        { id: 3, name: 'S', color: '#00f', x: 1200, y: 200, dir: Math.PI, cls: 'street', kind: 'edge' },
      ],
      prebuilt: [
        { pts: [[40, 400], [700, 400]], cls: 'oneway' },
        { pts: [[700, 400], [1160, 600]], cls: 'street' },
        { pts: [[700, 400], [1160, 200]], cls: 'street' },
      ],
      demand: [
        { from: 1, to: 2, perMin: 10 },
        { from: 1, to: 3, perMin: 10 },
      ],
    });
    const { sim } = runSim(def, 400, assertNoOverlap);
    const st = sim.stats();
    expect(st.arrivals[2]).toBeGreaterThan(30);
    expect(st.arrivals[3]).toBeGreaterThan(30);
    expect(st.removed).toBe(0);
  });

  it('preserves vehicles across a network update', () => {
    const { world, ports } = buildLevelWorld(straight);
    const input = compileLevel(world, straight, ports);
    const sim = new Sim();
    sim.load(input);
    for (let i = 0; i < 600; i++) sim.step();
    const n = sim.vehicles.length;
    expect(n).toBeGreaterThan(5);
    sim.update(compileLevel(world, straight, ports));
    expect(sim.vehicles.length).toBe(n);
  });
});
