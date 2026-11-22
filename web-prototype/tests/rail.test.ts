import { describe, it, expect } from 'vitest';
import { setup, run, assertNoOverlap, level } from './helpers';
import { buildLevelWorld } from '../src/game/loadLevel';
import { planRoad } from '../src/world/build';

const PI = Math.PI;
const railSite = (over = {}) =>
  level({
    ports: [
      { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls: 'street', kind: 'edge' },
      { id: 2, name: 'E', color: '#0f0', x: 1000, y: 500, dir: PI, cls: 'street', kind: 'edge' },
    ],
    rails: [{ pts: [[500, 0], [500, 1000]], perHour: 20, speedKmh: 80, cars: 5 }],
    demand: [{ from: 1, to: 2, perMin: 12 }, { from: 2, to: 1, perMin: 12 }],
    ...over,
  });

describe('railways', () => {
  it('a road at track level makes a level crossing (extra cost)', () => {
    const { world } = buildLevelWorld(railSite());
    const p = planRoad(world, { start: { kind: 'free', pos: { x: 40, y: 500 } }, end: { kind: 'free', pos: { x: 960, y: 500 } }, cls: 'street', level: 0 }, { width: 1000, height: 1000 });
    expect(p.valid).toBe(true);
    expect(p.railCrossings).toBe(1);
    const noRail = planRoad(world, { start: { kind: 'free', pos: { x: 40, y: 600 } }, end: { kind: 'free', pos: { x: 400, y: 600 } }, cls: 'street', level: 0 }, { width: 1000, height: 1000 });
    expect(noRail.railCrossings).toBe(0);
  });

  it('bridges clear the railway; half-height ramps do not', () => {
    const { world } = buildLevelWorld(railSite());
    const bridge = planRoad(world, { start: { kind: 'free', pos: { x: 300, y: 500 } }, end: { kind: 'free', pos: { x: 700, y: 500 } }, cls: 'street', level: 1 }, { width: 1000, height: 1000 });
    expect(bridge.valid).toBe(true);
    expect(bridge.railCrossings).toBe(0);
    const ramp = planRoad(world, { start: { kind: 'free', pos: { x: 380, y: 500 } }, end: { kind: 'free', pos: { x: 620, y: 500 } }, cls: 'street', level: 0, control: undefined }, { width: 1000, height: 1000 });
    expect(ramp.valid).toBe(true);
    // ground start, +1 end: crosses the tracks part-way up the ramp
    const w2 = buildLevelWorld(railSite()).world;
    const n = w2.addNode(380, 500, 0);
    const half = planRoad(w2, { start: { kind: 'node', node: n.id, pos: { x: 380, y: 500 } }, end: { kind: 'free', pos: { x: 600, y: 500 } }, cls: 'street', level: 1 }, { width: 1000, height: 1000 });
    expect(half.valid).toBe(false);
  });

  it('rejects shallow crossings', () => {
    const { world } = buildLevelWorld(railSite());
    const p = planRoad(world, { start: { kind: 'free', pos: { x: 480, y: 100 } }, end: { kind: 'free', pos: { x: 530, y: 600 } }, cls: 'street', level: 0 }, { width: 1000, height: 1000 });
    expect(p.valid).toBe(false);
  });

  it('trains run, barriers close and traffic waits for them', () => {
    const def = railSite({ prebuilt: [{ pts: [[40, 500], [960, 500]], cls: 'street' }] });
    const { sim, input } = setup(def);
    expect(input.rail.edges.length).toBe(2);
    expect(input.rail.crossings.length).toBeGreaterThanOrEqual(2);
    expect(input.edges.some((e) => e.crossings.length > 0)).toBe(true);
    let closedTicks = 0, maxTrains = 0, onTracksWhileTrain = 0, heldAtCrossing = 0, stoppedOnTracks = 0;
    run(sim, 900, (s) => {
      assertNoOverlap(s);
      // nobody ever stands still on the track bed (past the stop line, not yet clear)
      for (const v of s.vehicles) {
        for (const c of s.input.edges[v.edge].crossings) {
          if (v.v < 0.5 && v.s > c.s + 0.5 && v.s - v.len < c.s + (c.clear ?? 8)) stoppedOnTracks++;
        }
      }
      maxTrains = Math.max(maxTrains, s.trains.length);
      if (s.crossingClosed.some((c) => c === 1)) closedTicks++;
      // is a train physically on the crossing while a car is on the tracks?
      const trainOn = s.trains.some((t) => s.input.rail.crossings.some((c) => c.edge === t.edge && t.s >= c.s - 3 && t.s - t.len <= c.s + 3));
      if (trainOn) {
        for (const v of s.vehicles) {
          const e = s.input.edges[v.edge];
          for (const c of e.crossings) {
            if (v.s > c.s + 0.5 && v.s - v.len < c.s + (c.clear ?? 8)) onTracksWhileTrain++;
          }
        }
      }
      if (s.vehicles.some((v) => v.holdWhy === 7)) heldAtCrossing++;
    });
    expect(maxTrains).toBeGreaterThan(0);
    expect(closedTicks).toBeGreaterThan(300);
    expect(heldAtCrossing).toBeGreaterThan(50);
    expect(onTracksWhileTrain).toBe(0);
    expect(stoppedOnTracks).toBe(0);
    const st = sim.stats();
    expect(st.arrivals[2]).toBeGreaterThan(100);
    expect(st.removed).toBe(0);
  });

  it('queues from a junction just past the tracks never leave a vehicle standing on them', () => {
    const def = railSite({
      ports: [
        { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls: 'street', kind: 'edge' },
        { id: 2, name: 'E', color: '#0f0', x: 1000, y: 500, dir: PI, cls: 'street', kind: 'edge' },
        { id: 3, name: 'N', color: '#00f', x: 545, y: 0, dir: PI / 2, cls: 'street', kind: 'edge' },
        { id: 4, name: 'S', color: '#ff0', x: 545, y: 1000, dir: -PI / 2, cls: 'street', kind: 'edge' },
      ],
      rails: [{ pts: [[500, 0], [500, 1000]], perHour: 12, speedKmh: 80, cars: 5 }],
      prebuilt: [
        { pts: [[40, 500], [545, 500], [960, 500]], cls: 'street' },
        { pts: [[545, 40], [545, 500], [545, 960]], cls: 'street' },
      ],
      demand: [
        { from: 1, to: 2, perMin: 14 },
        { from: 2, to: 1, perMin: 14 },
        { from: 3, to: 4, perMin: 14 },
        { from: 4, to: 3, perMin: 14 },
      ],
    });
    const { sim } = setup(def, (w) => {
      for (const n of w.nodes.values()) if (w.degree(n.id) === 4) n.control = 'signal';
    });
    let stoppedOnTracks = 0, queuedAtCrossing = 0;
    run(sim, 1200, (s) => {
      assertNoOverlap(s);
      for (const v of s.vehicles) {
        for (const c of s.input.edges[v.edge].crossings) {
          if (v.v < 0.5 && v.s > c.s + 0.5 && v.s - v.len < c.s + (c.clear ?? 8)) stoppedOnTracks++;
          if (v.v < 0.5 && v.s > c.s - 4 && v.s <= c.s + 0.5) queuedAtCrossing++;
        }
      }
    });
    expect(queuedAtCrossing).toBeGreaterThan(0);
    expect(stoppedOnTracks).toBe(0);
    expect(sim.stats().removed).toBe(0);
  });
});
