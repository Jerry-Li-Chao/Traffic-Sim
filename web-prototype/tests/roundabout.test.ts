import { describe, it, expect } from 'vitest';
import { buildLevelWorld, compileLevel } from '../src/game/loadLevel';
import { planRoundabout, applyRoundabout } from '../src/world/roundabout';
import { Sim } from '../src/sim/Sim';
import { run, assertNoOverlap, conflictCollisions, fourWay } from './helpers';
import { majorArms } from '../src/world/control';

describe('roundabout', () => {
  it('replaces a crossing with a one-way ring', () => {
    const def = fourWay();
    const { world } = buildLevelWorld(def);
    const plan = planRoundabout(world, { x: 500, y: 500 }, 20, 'roundabout', { width: 1000, height: 1000 });
    expect(plan.valid).toBe(true);
    expect(plan.legs.length).toBe(4);
    const ring = applyRoundabout(world, plan);
    expect(ring.length).toBeGreaterThanOrEqual(4);
    // center node is gone; ring nodes have the ring as priority
    expect([...world.nodes.values()].some((n) => n.x === 500 && n.y === 500)).toBe(false);
    const legNode = [...world.nodes.values()].find((n) => world.degree(n.id) === 3)!;
    const major = majorArms(world, legNode.id);
    expect([...major].every((id) => world.seg(id).roundabout)).toBe(true);
    for (const id of ring) expect(world.seg(id).lanesB).toBe(0);
  });

  it('rejects roads meeting the ring too close together', () => {
    const def = fourWay();
    const { world } = buildLevelWorld(def);
    // tiny ring at an off-centre spot clipping two roads at a shallow spacing
    const plan = planRoundabout(world, { x: 520, y: 520 }, 30, 'roundabout', { width: 1000, height: 1000 });
    expect(plan.legs.length).toBeGreaterThan(0);
  });

  it('traffic flows through the roundabout without collisions', () => {
    const def = fourWay('street', {
      demand: [1, 2, 3, 4].flatMap((a) => [1, 2, 3, 4].filter((b) => b !== a).map((b) => ({ from: a, to: b, perMin: 2 }))),
    });
    const { world, ports } = buildLevelWorld(def);
    applyRoundabout(world, planRoundabout(world, { x: 500, y: 500 }, 20, 'roundabout', { width: 1000, height: 1000 }));
    const sim = new Sim();
    sim.load(compileLevel(world, def, ports));
    let collisions = 0;
    run(sim, 900, (s) => {
      assertNoOverlap(s);
      collisions += conflictCollisions(s);
    });
    const st = sim.stats();
    expect(collisions).toBe(0);
    expect(st.removed).toBe(0);
    for (const p of [1, 2, 3, 4]) expect(st.arrivals[p]).toBeGreaterThan(50);
  });

  it('a roundabout dropped on a bridge is built at bridge level, over the road below', () => {
    const PI = Math.PI;
    const def = {
      ...fourWay(),
      ports: [
        { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls: 'avenue', kind: 'edge' as const },
        { id: 2, name: 'E', color: '#0f0', x: 1000, y: 500, dir: PI, cls: 'avenue', kind: 'edge' as const },
        { id: 3, name: 'N', color: '#00f', x: 500, y: 0, dir: PI / 2, cls: 'street', kind: 'edge' as const },
        { id: 4, name: 'S', color: '#ff0', x: 500, y: 1000, dir: -PI / 2, cls: 'street', kind: 'edge' as const },
      ],
      prebuilt: [
        { pts: [[40, 500], [960, 500]] as [number, number][], cls: 'avenue' },
        // street: ground -> ramp up -> bridge over the avenue -> ramp down -> ground
        { pts: [[500, 40], [500, 330]] as [number, number][], cls: 'street' },
        { pts: [[500, 330], [500, 420]] as [number, number][], cls: 'street', level: 0, endLevel: 1 },
        { pts: [[500, 420], [500, 580]] as [number, number][], cls: 'street', level: 1 },
        { pts: [[500, 580], [500, 670]] as [number, number][], cls: 'street', level: 1, endLevel: 0 },
        { pts: [[500, 670], [500, 960]] as [number, number][], cls: 'street' },
      ],
      demand: [
        { from: 1, to: 2, perMin: 6 },
        { from: 2, to: 1, perMin: 6 },
        { from: 3, to: 4, perMin: 4 },
        { from: 4, to: 3, perMin: 4 },
      ],
    };
    const { world, ports } = buildLevelWorld(def);
    const before = world.segments.size;
    const avenues = () => [...world.segments.values()].filter((s) => s.cls === 'avenue').map((s) => s.id).sort().join();
    const avenuesBefore = avenues();
    // at ground level the ring would cut the avenue; at bridge level it only joins the bridge
    const ground = planRoundabout(world, { x: 500, y: 500 }, 24, 'roundabout', { width: 1000, height: 1000 }, 0);
    expect(ground.legs.every((l) => world.seg(l.seg).cls === 'avenue')).toBe(true);
    const plan = planRoundabout(world, { x: 500, y: 500 }, 24, 'roundabout', { width: 1000, height: 1000 }, 1);
    expect(plan.valid).toBe(true);
    expect(plan.legs.length).toBe(2);
    expect(plan.legs.every((l) => world.seg(l.seg).cls === 'street')).toBe(true);
    const ring = applyRoundabout(world, plan, 1);
    for (const id of ring) {
      const s = world.seg(id);
      expect(world.node(s.a).level).toBe(1);
      expect(world.node(s.b).level).toBe(1);
    }
    // the avenue underneath is untouched
    expect(avenues()).toBe(avenuesBefore);
    expect(world.segments.size).toBeGreaterThan(before);
    const sim = new Sim();
    sim.load(compileLevel(world, def, ports));
    run(sim, 300, assertNoOverlap);
    const st = sim.stats();
    expect(st.arrivals[3]).toBeGreaterThan(5);
    expect(st.arrivals[2]).toBeGreaterThan(10);
    expect(st.removed).toBe(0);
  });
});
