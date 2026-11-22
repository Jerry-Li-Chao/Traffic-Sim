import { describe, it, expect } from 'vitest';
import { setup, run, assertNoOverlap, level } from './helpers';
import type { Sim } from '../src/sim/Sim';
import type { World } from '../src/world/World';

const PI = Math.PI;

function exitPort(w: World, port: number) {
  const n = [...w.nodes.values()].find((x) => x.port === port)!;
  const stub = w.segmentsAt(n.id)[0];
  if (stub.a === n.id) w.reverseSegment(stub.id);
}

/** Lane shares on the given segment (time-averaged) and the worst burst of lane changes. */
function measure(sim: Sim, seg: number, seconds: number) {
  const lanes = sim.input.edges.filter((e) => e.seg === seg && e.kind === 0);
  const occ = new Map<number, number>(lanes.map((e) => [e.id, 0]));
  const changeTimes: number[] = [];
  const lastEdge = new Map<number, number>();
  run(sim, seconds, (s) => {
    assertNoOverlap(s);
    if (s.time < 120) return;
    for (const e of lanes) occ.set(e.id, occ.get(e.id)! + s.onEdge[e.id].length);
    for (const v of s.vehicles) {
      const p = lastEdge.get(v.id);
      const pe = p === undefined ? null : s.input.edges[p];
      if (pe && (pe.left === v.edge || pe.right === v.edge) && pe.seg === seg) changeTimes.push(s.time);
      lastEdge.set(v.id, v.edge);
    }
  });
  const total = [...occ.values()].reduce((a, b) => a + b, 0) || 1;
  const shares = [...occ.values()].map((o) => o / total);
  let burst = 0;
  for (let i = 0, j = 0; i < changeTimes.length; i++) {
    while (changeTimes[i] - changeTimes[j] > 2) j++;
    burst = Math.max(burst, i - j + 1);
  }
  return { shares, burst, changes: changeTimes.length };
}

describe('lane use', () => {
  it('a busy three-lane highway uses all its lanes', () => {
    const def = level({
      width: 2400,
      ports: [
        { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls: 'highway3', kind: 'edge' },
        { id: 2, name: 'E', color: '#0f0', x: 2400, y: 500, dir: PI, cls: 'highway3', kind: 'edge' },
        { id: 4, name: 'Off', color: '#ff0', x: 2000, y: 0, dir: PI / 2, cls: 'ramp', kind: 'edge' },
      ],
      prebuilt: [
        { pts: [[40, 500], [1700, 500]], cls: 'highway3' },
        { pts: [[1700, 500], [2360, 500]], cls: 'highway3' },
        { pts: [[1700, 500], [2000, 40]], cls: 'ramp', control: [1950, 470] },
      ],
      demand: [
        { from: 1, to: 2, perMin: 60, trucks: 0.15 },
        { from: 1, to: 4, perMin: 15 },
      ],
    });
    const { sim, world } = setup(def, (w) => {
      exitPort(w, 2);
      exitPort(w, 4);
    });
    const main = [...world.segments.values()].find((s) => s.cls === 'highway3' && world.node(s.a).x < 100 && world.node(s.b).x > 1000)!;
    const m = measure(sim, main.id, 900);
    (globalThis as unknown as { process: { stderr: { write(s: string): void } } }).process.stderr.write(`HIGHWAY shares=${m.shares.map((x) => x.toFixed(2))} burst=${m.burst} changes=${m.changes} arrivals=${JSON.stringify(sim.stats().arrivals)}\n`);
    expect(Math.min(...m.shares)).toBeGreaterThan(0.25);
    expect(m.burst).toBeLessThan(8);
  });

  it('an avenue approaching a signal shares its lanes', () => {
    const def = level({
      ports: [
        { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls: 'avenue', kind: 'edge' },
        { id: 2, name: 'E', color: '#0f0', x: 1000, y: 500, dir: PI, cls: 'avenue', kind: 'edge' },
        { id: 3, name: 'N', color: '#00f', x: 700, y: 0, dir: PI / 2, cls: 'street', kind: 'edge' },
        { id: 4, name: 'S', color: '#ff0', x: 700, y: 1000, dir: -PI / 2, cls: 'street', kind: 'edge' },
      ],
      prebuilt: [
        { pts: [[40, 500], [700, 500], [960, 500]], cls: 'avenue' },
        { pts: [[700, 40], [700, 500], [700, 960]], cls: 'street' },
      ],
      demand: [
        { from: 1, to: 2, perMin: 22 },
        { from: 1, to: 3, perMin: 5 },
        { from: 1, to: 4, perMin: 5 },
        { from: 2, to: 1, perMin: 15 },
        { from: 3, to: 4, perMin: 6 },
        { from: 4, to: 3, perMin: 6 },
      ],
    });
    const { sim, world } = setup(def, (w) => {
      for (const n of w.nodes.values()) if (w.degree(n.id) === 4) n.control = 'signal';
    });
    const main = [...world.segments.values()].find((s) => s.cls === 'avenue' && Math.min(world.node(s.a).x, world.node(s.b).x) < 100)!;
    const m = measure(sim, main.id, 900);
    (globalThis as unknown as { process: { stderr: { write(s: string): void } } }).process.stderr.write(`AVENUE shares=${m.shares.map((x) => x.toFixed(2))} burst=${m.burst} changes=${m.changes} arrivals=${JSON.stringify(sim.stats().arrivals)}\n`);
    expect(m.burst).toBeLessThan(8);
    // the two eastbound lanes carry similar traffic
    const [a, b] = [...m.shares].sort((x, y) => y - x);
    expect(b / a).toBeGreaterThan(0.7);
  });
});
