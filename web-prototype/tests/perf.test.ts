import { describe, it, expect } from 'vitest';
import { setup, level } from './helpers';

const PI = Math.PI;

/** A dense avenue grid with heavy demand: thousands of vehicles. */
function bigGrid() {
  const ports = [];
  const prebuilt: { pts: [number, number][]; cls: string }[] = [];
  let id = 1;
  const xs = [300, 700, 1100, 1500, 1900];
  const ys = [300, 700, 1100, 1500];
  for (const x of xs) {
    ports.push({ id: id++, name: `S${x}`, color: '#888', x, y: 0, dir: PI / 2, cls: 'avenue', kind: 'edge' as const });
    ports.push({ id: id++, name: `N${x}`, color: '#888', x, y: 1800, dir: -PI / 2, cls: 'avenue', kind: 'edge' as const });
    prebuilt.push({ pts: [[x, 40], [x, 1760]], cls: 'avenue' });
  }
  for (const y of ys) {
    ports.push({ id: id++, name: `W${y}`, color: '#888', x: 0, y, dir: 0, cls: 'avenue', kind: 'edge' as const });
    ports.push({ id: id++, name: `E${y}`, color: '#888', x: 2200, y, dir: PI, cls: 'avenue', kind: 'edge' as const });
    prebuilt.push({ pts: [[40, y], [2160, y]], cls: 'avenue' });
  }
  const demand = [];
  for (let i = 0; i < ports.length; i += 2) {
    demand.push({ from: ports[i].id, to: ports[i + 1].id, perMin: 30 });
    demand.push({ from: ports[i + 1].id, to: ports[i].id, perMin: 30 });
  }
  return level({ width: 2200, height: 1800, ports, prebuilt, demand, rampUp: 0 });
}

describe('performance', () => {
  it('steps a city-sized network fast enough for real time at 4x', () => {
    const def = bigGrid();
    const { sim, world } = setup(def, (w) => {
      // signalise every crossing so the grid keeps moving
      for (const n of w.nodes.values()) if (w.degree(n.id) === 4) n.control = 'signal';
    });
    void world;
    for (let i = 0; i < 3000; i++) sim.step(); // fill the network (5 min)
    const n = sim.vehicles.length;
    const t0 = performance.now();
    const steps = 200;
    for (let i = 0; i < steps; i++) sim.step();
    const ms = (performance.now() - t0) / steps;
    const snap0 = performance.now();
    sim.snapshot();
    const snapMs = performance.now() - snap0;
    (globalThis as unknown as { process: { stderr: { write(s: string): void } } }).process.stderr.write(`PERF vehicles=${n} step=${ms.toFixed(2)}ms snapshot=${snapMs.toFixed(2)}ms\n`);
    expect(n).toBeGreaterThan(800);
    // 4x speed = 40 steps per real second must fit in well under a second of CPU
    expect(ms * 40).toBeLessThan(600);
  }, 300_000);
});
