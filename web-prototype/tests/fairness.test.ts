import { describe, it, expect } from 'vitest';
import { setup, run, assertNoOverlap, level } from './helpers';
import { computeNetGeometry } from '../src/world/geometry';
import { nodeConnectors } from '../src/world/lanes';

const PI = Math.PI;
const kinked = level({
  ports: [
    { id: 1, name: 'W', color: '#f00', x: 0, y: 300, dir: 0, cls: 'street', kind: 'edge' },
    { id: 2, name: 'E', color: '#0f0', x: 1000, y: 700, dir: PI, cls: 'street', kind: 'edge' },
  ],
  // three straight pieces meeting at 35° and 45° kinks, with a class change at one joint
  prebuilt: [
    { pts: [[40, 300], [400, 300]], cls: 'street' },
    { pts: [[400, 300], [650, 480]], cls: 'lane' },
    { pts: [[650, 480], [960, 700]], cls: 'street' },
  ],
  demand: [{ from: 1, to: 2, perMin: 8 }, { from: 2, to: 1, perMin: 8 }],
});

describe('angled joints', () => {
  it('become smooth bends, not junctions', () => {
    const { world } = setup(kinked);
    const geom = computeNetGeometry(world);
    const joint = [...world.nodes.values()].find((n) => Math.hypot(n.x - 400, n.y - 300) < 1)!;
    const ng = geom.nodes.get(joint.id)!;
    expect(ng.junction).toBe(false);
    expect(ng.bend).toBeTruthy();
    expect(ng.bend!.center.length).toBeGreaterThan(5);
    // lanes continue through the bend in both directions
    expect(nodeConnectors(world, geom, joint.id).length).toBe(2);
  });

  it('carry traffic smoothly', () => {
    const { sim } = setup(kinked);
    run(sim, 600, assertNoOverlap);
    const st = sim.stats();
    expect(st.arrivals[2]).toBeGreaterThan(65);
    expect(st.removed).toBe(0);
    expect(sim.vehicles.filter((v) => v.hold).length).toBe(0);
  });
});

describe('steady demand', () => {
  it('generates trips at the stated rate with no droughts', () => {
    const def = level({
      ports: [
        { id: 1, name: 'W', color: '#f00', x: 0, y: 300, dir: 0, cls: 'avenue', kind: 'edge' },
        { id: 2, name: 'E', color: '#0f0', x: 1000, y: 300, dir: PI, cls: 'avenue', kind: 'edge' },
      ],
      prebuilt: [{ pts: [[40, 300], [960, 300]], cls: 'avenue' }],
      demand: [{ from: 1, to: 2, perMin: 6 }],
    });
    const { sim } = setup(def);
    let minFlow = Infinity;
    run(sim, 1200, (s) => {
      if (s.time > 300 && s.tick % 50 === 0) minFlow = Math.min(minFlow, s.stats().flow[2]);
    });
    // with a 2-minute window the measured flow never dips far below the demand
    expect(minFlow).toBeGreaterThanOrEqual(5);
    expect(sim.stats().arrivals[2]).toBeGreaterThan(105);
  });
});
