import { describe, it, expect } from 'vitest';
import { setup, run, assertNoOverlap, conflictCollisions, fourWay, level } from './helpers';
import { majorArms, signalPhases, stopStyleFor } from '../src/world/control';
import { EDGE_CONNECTOR } from '../src/sim/types';

const center = (w: import('../src/world/World').World) => [...w.nodes.values()].find((n) => n.x === 500 && n.y === 500)!;
/** pick "Give way" at the centre crossing, as a player would in the Junction tool */
const giveWay = (w: import('../src/world/World').World) => {
  const c = center(w);
  c.control = 'auto';
  c.controlSource = 'user';
};

describe('junction control compile', () => {
  it('picks the straight pair of the highest class as major', () => {
    const def = fourWay('street', {
      prebuilt: [
        { pts: [[40, 500], [500, 500], [960, 500]], cls: 'avenue' },
        { pts: [[500, 960], [500, 500]], cls: 'street' },
        { pts: [[500, 500], [500, 40]], cls: 'street' },
      ],
    });
    const { world } = setup(def, giveWay);
    const c = center(world);
    const major = majorArms(world, c.id);
    expect([...major].every((id) => world.seg(id).cls === 'avenue')).toBe(true);
    const minor = world.segmentsAt(c.id).find((s) => s.cls === 'street')!;
    expect(stopStyleFor(world, c.id, minor.id)).toBe('yield');
  });

  it('builds two signal phases for a 4-way crossing', () => {
    const { world } = setup(fourWay());
    expect(signalPhases(world, center(world).id).length).toBe(2);
  });

  it('marks minor movements as give-way with conflicts', () => {
    const { input } = setup(fourWay(), giveWay);
    const conns = input.edges.filter((e) => e.kind === EDGE_CONNECTOR);
    expect(conns.some((e) => e.giveWay)).toBe(true);
    expect(conns.some((e) => !e.giveWay)).toBe(true);
    expect(conns.every((e) => e.conflicts.every((k) => !(k.yield && e.conflicts.find((x) => x.edge === k.edge)?.yield === false && false)))).toBe(true);
    // conflicts are symmetric with exactly one side yielding (priority junction)
    for (const e of conns) for (const k of e.conflicts) {
      const back = input.edges[k.edge].conflicts.find((x) => x.edge === e.id)!;
      expect(back).toBeTruthy();
      expect(k.yield && back.yield).toBe(false);
    }
  });
});

describe('junction behaviour', () => {
  // priority junctions get realistic minor-road demand; signals / all-way stops get the heavy load
  const light = { demand: [
    { from: 1, to: 2, perMin: 6 }, { from: 2, to: 1, perMin: 6 },
    { from: 3, to: 4, perMin: 2.5 }, { from: 4, to: 3, perMin: 2.5 },
    { from: 1, to: 3, perMin: 1.5 }, { from: 3, to: 2, perMin: 1 },
    { from: 2, to: 4, perMin: 1.5 }, { from: 4, to: 1, perMin: 1 },
  ] };
  for (const control of ['auto', 'signal', 'stop', 'allstop'] as const) {
    it(`${control} junction: flows on all approaches without collisions`, () => {
      const def = control === 'auto' || control === 'stop' ? fourWay('street', light) : fourWay();
      const { sim } = setup(def, (w) => {
        center(w).control = control;
      });
      let collisions = 0;
      run(sim, 900, (s) => {
        assertNoOverlap(s);
        collisions += conflictCollisions(s);
      });
      const st = sim.stats();
      expect(collisions).toBe(0);
      for (const p of [1, 2, 3, 4]) expect(st.arrivals[p]).toBeGreaterThan(20);
      expect(st.removed).toBe(0);
    });
  }

  it('signal cycles through phases', () => {
    const { sim, world } = setup(fourWay(), (w) => {
      center(w).control = 'signal';
    });
    void world;
    const seen = new Set<string>();
    run(sim, 120, (s) => {
      const snap = (s as unknown as { signalSnapshot(): Int32Array }).signalSnapshot();
      const st: number[] = [];
      for (let i = 0; i < snap.length; i += 3) st.push(snap[i + 2]);
      seen.add(st.join(''));
    });
    // red/green alternate between the two directions + amber stages
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('minor road waits for major traffic (give way)', () => {
    // heavy major flow, light minor flow
    const def = fourWay('street', {
      demand: [
        { from: 1, to: 2, perMin: 12 }, { from: 2, to: 1, perMin: 12 },
        { from: 3, to: 4, perMin: 4 },
      ],
    });
    const { sim } = setup(def, giveWay);
    let minorWaitMax = 0, majorStopped = 0;
    run(sim, 600, (s) => {
      for (const v of s.vehicles) {
        if (v.hold && v.origin === 3) minorWaitMax = Math.max(minorWaitMax, v.stopped);
        // major straight-through traffic never gives way to the minor road
        if (v.hold && v.holdWhy === 3 && (v.origin === 1 || v.origin === 2) && v.dest !== 3 && v.dest !== 4) majorStopped++;
      }
    });
    expect(minorWaitMax).toBeGreaterThan(0.5);
    expect(sim.stats().arrivals[4]).toBeGreaterThan(8);
    expect(majorStopped).toBe(0);
  });

  it('heavy demand does not gridlock permanently', () => {
    const def = fourWay('street', {
      demand: [1, 2, 3, 4].flatMap((a) => [1, 2, 3, 4].filter((b) => b !== a).map((b) => ({ from: a, to: b, perMin: 8 }))),
    });
    const { sim } = setup(def);
    run(sim, 1200, assertNoOverlap);
    const a1 = sim.stats().completed;
    run(sim, 300);
    expect(sim.stats().completed - a1).toBeGreaterThan(50);
  });

  it('highway merge: ramp traffic merges', () => {
    const def = level({
      width: 1400,
      ports: [
        { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls: 'highway', kind: 'edge' },
        { id: 2, name: 'E', color: '#0f0', x: 1400, y: 500, dir: Math.PI, cls: 'highway', kind: 'edge' },
        { id: 3, name: 'S', color: '#00f', x: 300, y: 0, dir: Math.PI / 2, cls: 'ramp', kind: 'edge' },
      ],
      prebuilt: [
        { pts: [[40, 500], [700, 500]], cls: 'highway' },
        { pts: [[700, 500], [1360, 500]], cls: 'highway' },
        { pts: [[300, 40], [700, 500]], cls: 'ramp', control: [380, 470] },
      ],
      demand: [{ from: 1, to: 2, perMin: 30 }, { from: 3, to: 2, perMin: 10 }],
    });
    // the E port is an exit only for highway one-way: flip its stub so traffic leaves the map
    const { sim, world } = setup(def, (w) => {
      const e = [...w.nodes.values()].find((n) => n.port === 2)!;
      const stub = w.segmentsAt(e.id)[0];
      if (stub.a === e.id) w.reverseSegment(stub.id);
    });
    void world;
    let collisions = 0;
    run(sim, 600, (s) => {
      assertNoOverlap(s);
      collisions += conflictCollisions(s);
    });
    const st = sim.stats();
    expect(st.arrivals[2]).toBeGreaterThan(200);
    expect(st.removed).toBe(0);
    expect(collisions).toBe(0);
  });

});

describe('default junction controls', () => {
  it('crossings get stop signs or signals by the roads that meet; T-junctions and your choices are left alone', async () => {
    const { World } = await import('../src/world/World');
    const { planRoad, applyRoad, snapAnchor } = await import('../src/world/build');
    const { refreshDefaultControls } = await import('../src/world/control');
    const map = { width: 2000, height: 2000 };
    const road = (w: InstanceType<typeof World>, a: [number, number], b: [number, number], cls: string) =>
      applyRoad(w, planRoad(w, { start: snapAnchor(w, { x: a[0], y: a[1] }, 3), end: snapAnchor(w, { x: b[0], y: b[1] }, 3), cls, level: 0 }, map));
    const at = (w: InstanceType<typeof World>, x: number, y: number) => [...w.nodes.values()].find((n) => Math.hypot(n.x - x, n.y - y) < 1)!;

    // two streets crossing: all-way stop
    const w = new World();
    road(w, [100, 300], [500, 300], 'street');
    road(w, [300, 100], [300, 500], 'street');
    expect(at(w, 300, 300).control).toBe('allstop');
    // a street crossing an avenue: signals
    road(w, [100, 800], [500, 800], 'avenue');
    road(w, [300, 600], [300, 1000], 'street');
    expect(at(w, 300, 800).control).toBe('signal');
    // a T-junction keeps give-way priority
    road(w, [700, 300], [1100, 300], 'street');
    road(w, [900, 300], [900, 500], 'street');
    expect(at(w, 900, 300).control).toBe('auto');
    // upgrading a road at a crossing re-picks the default
    const s = w.segmentsAt(at(w, 300, 300).id)[0];
    s.cls = 'avenue';
    s.lanesF = 2;
    s.lanesB = 2;
    refreshDefaultControls(w);
    expect(at(w, 300, 300).control).toBe('signal');
    // the player's own choice is kept
    const c = at(w, 300, 800);
    c.control = 'stop';
    c.controlSource = 'user';
    road(w, [100, 820], [140, 1000], 'street');
    refreshDefaultControls(w);
    expect(c.control).toBe('stop');
  });
});

describe('vehicle path finder', () => {
  it('traces a car all the way to its destination, and says when it cannot get there', async () => {
    const { compileLevel } = await import('../src/game/loadLevel');
    const def = fourWay('avenue', { demand: [{ from: 1, to: 3, perMin: 20 }] });
    const { sim, world, ports } = setup(def);
    run(sim, 30);
    const v = sim.vehicles.find((x) => x.dest === 3)!;
    const path = sim.pathOf(v);
    expect(path.reachable).toBe(true);
    expect(sim.input.edges[path.edges[path.edges.length - 1]].sinkPort).toBe(3);
    expect(path.edges[0]).toBe(v.edge);
    expect(path.eta).toBeGreaterThan(0);
    // cut the road to the destination beyond the crossing: cars on the way have no route
    const c = center(world);
    const toN = world.segmentsAt(c.id).find((s) => world.node(world.otherEnd(s, c.id)).y > 500 && !s.locked)!;
    world.removeSegment(toN.id);
    sim.update(compileLevel(world, def, ports));
    const stuck = sim.vehicles.find((x) => x.dest === 3)!;
    expect(sim.pathOf(stuck).reachable).toBe(false);
    // and the player can take it off the road
    sim.removeVehicle(stuck.id);
    expect(sim.vehicles.includes(stuck)).toBe(false);
  });
});
