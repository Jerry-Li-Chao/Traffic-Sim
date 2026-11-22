import { describe, it, expect } from 'vitest';
import { setup, run, assertNoOverlap, conflictCollisions, level } from './helpers';
import { buildLevelWorld, compileLevel } from '../src/game/loadLevel';
import { computeNetGeometry } from '../src/world/geometry';
import { nodeConnectors } from '../src/world/lanes';
import { toggleConnection, laneMarkers } from '../src/world/laneEdit';
import { Sim } from '../src/sim/Sim';
import type { World } from '../src/world/World';

const PI = Math.PI;

/** flip a port stub so the port is an exit for one-way roads */
function exitPort(w: World, port: number) {
  const n = [...w.nodes.values()].find((x) => x.port === port)!;
  const stub = w.segmentsAt(n.id)[0];
  if (stub.a === n.id) w.reverseSegment(stub.id);
}

describe('multi-lane behaviour', () => {
  it('vehicles overtake slow trucks on a two-lane highway (MOBIL)', () => {
    const def = level({
      width: 2000,
      ports: [
        { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls: 'highway', kind: 'edge' },
        { id: 2, name: 'E', color: '#0f0', x: 2000, y: 500, dir: PI, cls: 'highway', kind: 'edge' },
      ],
      prebuilt: [{ pts: [[40, 500], [1960, 500]], cls: 'highway' }],
      demand: [{ from: 1, to: 2, perMin: 30, trucks: 0.25 }],
    });
    const { sim } = setup(def, (w) => exitPort(w, 2));
    run(sim, 600, assertNoOverlap);
    expect(sim.lcDiscretionary).toBeGreaterThan(20);
    expect(sim.stats().arrivals[2]).toBeGreaterThan(200);
    expect(sim.stats().removed).toBe(0);
  });

  it('weaving between an on-ramp and an off-ramp', () => {
    const def = level({
      width: 2000,
      ports: [
        { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls: 'highway', kind: 'edge' },
        { id: 2, name: 'E', color: '#0f0', x: 2000, y: 500, dir: PI, cls: 'highway', kind: 'edge' },
        { id: 3, name: 'OnRamp', color: '#00f', x: 400, y: 0, dir: PI / 2, cls: 'ramp', kind: 'edge' },
        { id: 4, name: 'OffRamp', color: '#ff0', x: 1600, y: 0, dir: PI / 2, cls: 'ramp', kind: 'edge' },
      ],
      prebuilt: [
        { pts: [[40, 500], [700, 500]], cls: 'highway' },
        { pts: [[700, 500], [1300, 500]], cls: 'highway3' },
        { pts: [[1300, 500], [1960, 500]], cls: 'highway' },
        { pts: [[400, 40], [700, 500]], cls: 'ramp', control: [480, 470] },
        { pts: [[1300, 500], [1600, 40]], cls: 'ramp', control: [1520, 470] },
      ],
      demand: [
        { from: 1, to: 2, perMin: 25 },
        { from: 1, to: 4, perMin: 8 },
        { from: 3, to: 2, perMin: 8 },
        { from: 3, to: 4, perMin: 3 },
      ],
    });
    const { sim } = setup(def, (w) => {
      exitPort(w, 2);
      exitPort(w, 4);
    });
    let collisions = 0;
    run(sim, 900, (s) => {
      assertNoOverlap(s);
      collisions += conflictCollisions(s);
    });
    const st = sim.stats();
    expect({ collisions, removed: st.removed }).toEqual({ collisions: 0, removed: 0 });
    expect(st.arrivals[2]).toBeGreaterThan(350);
    expect(st.arrivals[4]).toBeGreaterThan(120);
    expect(sim.lcMandatory).toBeGreaterThan(50);
  });

  it('lane connection overrides change routing', () => {
    const def = level({
      ports: [
        { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls: 'avenue', kind: 'edge' },
        { id: 2, name: 'E', color: '#0f0', x: 1000, y: 500, dir: PI, cls: 'avenue', kind: 'edge' },
        { id: 3, name: 'N', color: '#00f', x: 500, y: 1000, dir: -PI / 2, cls: 'avenue', kind: 'edge' },
      ],
      prebuilt: [
        { pts: [[40, 500], [500, 500], [960, 500]], cls: 'avenue' },
        { pts: [[500, 960], [500, 500]], cls: 'avenue' },
      ],
      demand: [{ from: 1, to: 2, perMin: 10 }, { from: 1, to: 3, perMin: 10 }],
    });
    const { world, ports } = buildLevelWorld(def);
    const center = [...world.nodes.values()].find((n) => n.x === 500 && n.y === 500)!;
    const west = world.segmentsAt(center.id).find((s) => world.otherEnd(s, center.id) !== undefined && world.node(world.otherEnd(s, center.id)).x < 500)!;
    const north = world.segmentsAt(center.id).find((s) => world.node(world.otherEnd(s, center.id)).y > 500)!;
    let geom = computeNetGeometry(world);
    const markers = laneMarkers(world, geom, center.id);
    expect(markers.filter((m) => m.incoming).length).toBe(6);
    // lane 1 (inner) of the west approach: remove its left turn to N
    const before = nodeConnectors(world, geom, center.id).filter((c) => c.from.seg === west.id && c.to.seg === north.id);
    expect(before.length).toBe(1);
    expect(toggleConnection(world, geom, center.id, `${west.id}:${before[0].from.idx}`, `${north.id}:${before[0].to.idx}`)).toBe(true);
    // ... and give lane 0 a left turn instead
    geom = computeNetGeometry(world);
    toggleConnection(world, geom, center.id, `${west.id}:0`, `${north.id}:0`);
    geom = computeNetGeometry(world);
    const after = nodeConnectors(world, geom, center.id).filter((c) => c.from.seg === west.id && c.to.seg === north.id);
    expect(after.map((c) => c.from.idx)).toEqual([0]);
    // vehicles still reach N (now from the outer lane)
    const sim = new Sim();
    sim.load(compileLevel(world, def, ports));
    run(sim, 400, assertNoOverlap);
    expect(sim.stats().arrivals[3]).toBeGreaterThan(15);
    expect(sim.stats().removed).toBe(0);
  });

  it('lane changes need forward motion: stopped cars never slide sideways', () => {
    const def = level({
      ports: [
        { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls: 'avenue', kind: 'edge' },
        { id: 2, name: 'E', color: '#0f0', x: 1000, y: 500, dir: PI, cls: 'avenue', kind: 'edge' },
        { id: 3, name: 'N', color: '#00f', x: 600, y: 0, dir: PI / 2, cls: 'street', kind: 'edge' },
        { id: 4, name: 'S', color: '#ff0', x: 600, y: 1000, dir: -PI / 2, cls: 'street', kind: 'edge' },
      ],
      prebuilt: [
        { pts: [[40, 500], [600, 500], [960, 500]], cls: 'avenue' },
        { pts: [[600, 40], [600, 500], [600, 960]], cls: 'street' },
      ],
      demand: [
        { from: 1, to: 2, perMin: 16 },
        { from: 1, to: 3, perMin: 8 },
        { from: 1, to: 4, perMin: 8 },
        { from: 2, to: 1, perMin: 16 },
        { from: 3, to: 4, perMin: 8 },
        { from: 4, to: 3, perMin: 8 },
      ],
    });
    const { sim } = setup(def, (w) => {
      for (const n of w.nodes.values()) if (w.degree(n.id) === 4) n.control = 'signal';
    });
    const prev = new Map<number, { edge: number; s: number; off: number; timed: boolean }>();
    let slides = 0,
      changes = 0;
    run(sim, 900, (s) => {
      assertNoOverlap(s);
      for (const v of s.vehicles) {
        const p = prev.get(v.id);
        if (p && p.edge === v.edge && !p.timed && Math.abs(v.s - p.s) < 1e-6 && Math.abs(v.lcOffset - p.off) > 1e-6) slides++;
        if (p && p.edge !== v.edge && v.lcOffset !== 0 && p.off === 0) changes++;
        prev.set(v.id, { edge: v.edge, s: v.s, off: v.lcOffset, timed: v.lcTimed });
      }
    });
    expect(changes).toBeGreaterThan(20);
    expect(slides).toBe(0);
    expect(sim.stats().removed).toBe(0);
  });
});
