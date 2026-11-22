import { describe, it, expect } from 'vitest';
import { setup, run, assertNoOverlap, level } from './helpers';
import { compileLevel } from '../src/game/loadLevel';
import { planHouse, applyHouse, removeHouse } from '../src/world/houses';
import { HOUSE_PORT_BASE } from '../src/world/World';

const PI = Math.PI;
const site = () =>
  level({
    ports: [
      { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls: 'street', kind: 'edge' },
      { id: 2, name: 'E', color: '#0f0', x: 1000, y: 500, dir: PI, cls: 'street', kind: 'edge' },
    ],
    prebuilt: [{ pts: [[40, 500], [960, 500]], cls: 'street' }],
    demand: [
      { from: 1, to: 2, perMin: 4 },
      { from: 2, to: 1, perMin: 4 },
    ],
  });

describe('houses', () => {
  it('are placed beside a street with a driveway, on the side pointed at', () => {
    const { world } = setup(site());
    const up = planHouse(world, { x: 300, y: 520 }, { width: 1000, height: 1000 });
    expect(up.reason).toBeUndefined();
    expect(up.pos.y).toBeGreaterThan(510);
    const id = applyHouse(world, up);
    const n = world.node(id);
    expect(n.house).toBeDefined();
    expect(n.port).toBe(HOUSE_PORT_BASE + id);
    expect(world.segmentsAt(id).length).toBe(1);
    // too close to the first one
    expect(planHouse(world, { x: 305, y: 520 }, { width: 1000, height: 1000 }).valid).toBe(false);
    // the other side of the road is fine
    expect(planHouse(world, { x: 340, y: 480 }, { width: 1000, height: 1000 }).valid).toBe(true);
    removeHouse(world, id);
    expect(world.nodes.has(id)).toBe(false);
  });

  it('make and take trips, never more than two cars each way, outside the site goals', () => {
    const def = site();
    const { sim, world, ports } = setup(def);
    const houses: number[] = [];
    for (const [x, y] of [[250, 520], [450, 480], [650, 520]] as [number, number][]) {
      houses.push(world.node(applyHouse(world, planHouse(world, { x, y }, { width: 1000, height: 1000 }))).port!);
    }
    sim.load(compileLevel(world, def, ports));
    let maxOut = 0,
      maxIn = 0,
      houseTrips = 0;
    const seen = new Set<number>();
    run(sim, 1200, (s) => {
      assertNoOverlap(s);
      for (const h of houses) {
        maxOut = Math.max(maxOut, s.vehicles.filter((v) => v.origin === h).length);
        maxIn = Math.max(maxIn, s.vehicles.filter((v) => v.dest === h).length);
      }
      for (const v of s.vehicles) if ((houses.includes(v.origin) || houses.includes(v.dest)) && !seen.has(v.id)) {
        seen.add(v.id);
        houseTrips++;
      }
    });
    const st = sim.stats();
    expect(houseTrips).toBeGreaterThan(20);
    expect(maxOut).toBeLessThanOrEqual(2);
    expect(maxIn).toBeLessThanOrEqual(2);
    expect(st.removed).toBe(0);
    // goal flow only counts the site's own trips: about 4/min each way over 20 minutes
    expect(st.arrivals[1]).toBeLessThan(90);
    expect(st.arrivals[2]).toBeLessThan(90);
    for (const h of houses) expect(st.arrivals[h] ?? 0).toBe(0);
  });
});
