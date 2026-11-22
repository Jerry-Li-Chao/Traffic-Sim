import { describe, it, expect } from 'vitest';
import { setup, run, assertNoOverlap, conflictCollisions, level } from './helpers';
import type { LevelDef } from '../src/game/level';
import type { World } from '../src/world/World';
import { planRoad, snapAnchor } from '../src/world/build';
import { buildLevelWorld } from '../src/game/loadLevel';
import { computeNetGeometry } from '../src/world/geometry';

const PI = Math.PI;

function exitPort(w: World, port: number) {
  const n = [...w.nodes.values()].find((x) => x.port === port)!;
  const stub = w.segmentsAt(n.id)[0];
  if (stub.a === n.id) w.reverseSegment(stub.id);
}

/** Split carriageway highway with a street bridge and a diamond interchange. */
export const diamond: LevelDef = level({
  width: 2000,
  ports: [
    { id: 1, name: 'W in', color: '#f00', x: 0, y: 480, dir: 0, cls: 'highway', kind: 'edge' },
    { id: 2, name: 'E out', color: '#0f0', x: 2000, y: 480, dir: PI, cls: 'highway', kind: 'edge' },
    { id: 3, name: 'E in', color: '#00f', x: 2000, y: 520, dir: PI, cls: 'highway', kind: 'edge' },
    { id: 4, name: 'W out', color: '#ff0', x: 0, y: 520, dir: 0, cls: 'highway', kind: 'edge' },
    { id: 5, name: 'N', color: '#0ff', x: 1000, y: 1000, dir: -PI / 2, cls: 'street', kind: 'edge' },
    { id: 6, name: 'S', color: '#f0f', x: 1000, y: 0, dir: PI / 2, cls: 'street', kind: 'edge' },
  ],
  prebuilt: [
    // carriageways
    { pts: [[40, 480], [750, 480], [1250, 480], [1960, 480]], cls: 'highway' },
    { pts: [[1960, 520], [1250, 520], [750, 520], [40, 520]], cls: 'highway' },
    // street: ground -> bridge (+1) over both carriageways -> ground
    { pts: [[1000, 960], [1000, 740]], cls: 'street' },
    { pts: [[1000, 740], [1000, 620]], cls: 'street', level: 0, endLevel: 1 },
    { pts: [[1000, 620], [1000, 380]], cls: 'street', level: 1 },
    { pts: [[1000, 380], [1000, 260]], cls: 'street', level: 1, endLevel: 0 },
    { pts: [[1000, 260], [1000, 40]], cls: 'street' },
    // diamond ramps
    { pts: [[750, 480], [1000, 260]], cls: 'ramp', control: [900, 455] },
    { pts: [[1000, 260], [1250, 480]], cls: 'ramp', control: [1100, 455] },
    { pts: [[1250, 520], [1000, 740]], cls: 'ramp', control: [1100, 545] },
    { pts: [[1000, 740], [750, 520]], cls: 'ramp', control: [900, 545] },
  ],
  demand: [
    { from: 1, to: 2, perMin: 20 },
    { from: 3, to: 4, perMin: 20 },
    { from: 1, to: 6, perMin: 4 },
    { from: 3, to: 5, perMin: 4 },
    { from: 5, to: 2, perMin: 3 },
    { from: 6, to: 4, perMin: 3 },
    { from: 5, to: 6, perMin: 3 },
    { from: 6, to: 5, perMin: 3 },
  ],
});

describe('grade separation', () => {
  it('a bridge crosses the carriageways without junctions', () => {
    const { world } = buildLevelWorld(diamond);
    for (const n of world.nodes.values()) {
      if (Math.abs(n.x - 1000) < 1) expect(Math.abs(n.y - 480) > 5 && Math.abs(n.y - 520) > 5).toBe(true);
    }
    const geom = computeNetGeometry(world);
    const bridge = [...world.segments.values()].find((s) => world.node(s.a).level === 1 && world.node(s.b).level === 1)!;
    expect(bridge).toBeTruthy();
    expect(Math.max(...geom.segs.get(bridge.id)!.z)).toBeCloseTo(6, 1);
  });

  it('cannot cross a ramp where it is neither level nor clear', () => {
    const { world } = buildLevelWorld(diamond);
    // y=680 is halfway up the street ramp (z ~ 3 m): no junction possible, no clearance
    const a = snapAnchor(world, { x: 940, y: 680 }, 1);
    expect(a.kind).toBe('free');
    const plan = planRoad(world, { start: a, end: { kind: 'free', pos: { x: 1060, y: 680 } }, cls: 'lane', level: 0 }, { width: 2000, height: 1000 });
    expect(plan.valid).toBe(false);
    // ... but passing under the bridge deck is fine
    const under = planRoad(world, { start: { kind: 'free', pos: { x: 940, y: 560 } }, end: { kind: 'free', pos: { x: 1060, y: 560 } }, cls: 'lane', level: 0 }, { width: 2000, height: 1000 });
    expect(under.valid).toBe(true);
    expect(under.hits.length).toBe(0);
  });

  it('diamond interchange carries highway and local traffic', () => {
    const { sim } = setup(diamond, (w) => {
      exitPort(w, 2);
      exitPort(w, 4);
    });
    let collisions = 0;
    run(sim, 900, (s) => {
      assertNoOverlap(s);
      collisions += conflictCollisions(s);
    });
    const st = sim.stats();
    expect(collisions).toBe(0);
    expect(st.removed).toBe(0);
    expect(st.arrivals[2]).toBeGreaterThan(250);
    expect(st.arrivals[4]).toBeGreaterThan(250);
    expect(st.arrivals[5]).toBeGreaterThan(70);
    expect(st.arrivals[6]).toBeGreaterThan(70);
  });

  it('tunnels go under everything', () => {
    const def = level({
      ports: [
        { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls: 'street', kind: 'edge' },
        { id: 2, name: 'E', color: '#0f0', x: 1000, y: 500, dir: PI, cls: 'street', kind: 'edge' },
        { id: 3, name: 'N', color: '#00f', x: 500, y: 1000, dir: -PI / 2, cls: 'street', kind: 'edge' },
        { id: 4, name: 'S', color: '#ff0', x: 500, y: 0, dir: PI / 2, cls: 'street', kind: 'edge' },
      ],
      prebuilt: [
        { pts: [[40, 500], [960, 500]], cls: 'street' },
        { pts: [[500, 960], [500, 820]], cls: 'street' },
        { pts: [[500, 820], [500, 600]], cls: 'street', level: 0, endLevel: -2 },
        { pts: [[500, 600], [500, 400]], cls: 'street', level: -2 },
        { pts: [[500, 400], [500, 180]], cls: 'street', level: -2, endLevel: 0 },
        { pts: [[500, 180], [500, 40]], cls: 'street' },
      ],
      demand: [{ from: 1, to: 2, perMin: 10 }, { from: 3, to: 4, perMin: 10 }, { from: 4, to: 3, perMin: 10 }],
    });
    const { sim, world } = setup(def);
    expect([...world.nodes.values()].some((n) => n.x === 500 && n.y === 500)).toBe(false);
    let hidden = 0;
    run(sim, 300, (s) => {
      const snap = s.snapshot();
      for (let i = 0; i < snap.vehicleCount; i++) if (snap.vehicles[i * 8 + 7] & 8) hidden++;
    });
    expect(hidden).toBeGreaterThan(0);
    expect(sim.stats().arrivals[4]).toBeGreaterThan(20);
  });
});
