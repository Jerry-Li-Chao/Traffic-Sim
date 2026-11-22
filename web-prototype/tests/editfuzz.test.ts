import { describe, it, expect } from 'vitest';
import { setup, level } from './helpers';
import { compileLevel } from '../src/game/loadLevel';
import { removePiece } from '../src/tools/BulldozeTool';
import { planRoad, applyRoad, snapAnchor } from '../src/world/build';
import { Rng } from '../src/core/rng';

const PI = Math.PI;

/** Edit the network again and again while traffic runs: the simulation must never throw. */
describe('editing a live network', () => {
  it('survives random edits while traffic is running', () => {
    const def = level({
      width: 1600,
      ports: [
        { id: 1, name: 'W', color: '#f00', x: 0, y: 500, dir: 0, cls: 'avenue', kind: 'edge' },
        { id: 2, name: 'E', color: '#0f0', x: 1600, y: 500, dir: PI, cls: 'avenue', kind: 'edge' },
        { id: 3, name: 'N', color: '#00f', x: 800, y: 0, dir: PI / 2, cls: 'avenue', kind: 'edge' },
        { id: 4, name: 'S', color: '#ff0', x: 800, y: 1000, dir: -PI / 2, cls: 'avenue', kind: 'edge' },
      ],
      prebuilt: [
        { pts: [[40, 500], [800, 500], [1560, 500]], cls: 'avenue' },
        { pts: [[800, 40], [800, 500], [800, 960]], cls: 'avenue' },
      ],
      demand: [1, 2, 3, 4].flatMap((a) => [1, 2, 3, 4].filter((b) => b !== a).map((b) => ({ from: a, to: b, perMin: 8 }))),
    });
    const { sim, world, ports } = setup(def);
    const r = new Rng(7);
    const rng = () => r.next();
    const map = { width: 1600, height: 1000 };
    let edits = 0;
    let stale = 0;
    for (let round = 0; round < 120; round++) {
      for (let i = 0; i < 40; i++) sim.step();
      // pick an edit: cut a section out of a road, or build a road across the network
      const segs = [...world.segments.values()].filter((s) => !s.locked);
      if (rng() < 0.6 && segs.length > 4) {
        const s = segs[Math.floor(rng() * segs.length)];
        removePiece(world, s.id, rng() * world.poly(s).length);
        edits++;
      } else {
        const a = { x: 100 + rng() * 1400, y: 100 + rng() * 800 };
        const b = { x: 100 + rng() * 1400, y: 100 + rng() * 800 };
        const p = planRoad(world, { start: snapAnchor(world, a, 6), end: snapAnchor(world, b, 6), cls: rng() < 0.5 ? 'avenue' : 'street', level: 0 }, map);
        if (p.valid) {
          applyRoad(world, p);
          edits++;
        }
      }
      sim.update(compileLevel(world, def, ports));
      for (const v of sim.vehicles) {
        if (v.lcFrom >= 0) {
          const from = sim.input.edges[v.lcFrom];
          if (!from || (from.left !== v.edge && from.right !== v.edge)) stale++;
        }
        if (v.courtesyFor && !v.courtesyFor.dead && !sim.vehicles.includes(v.courtesyFor)) stale++;
      }
    }

    expect(stale).toBe(0);
    expect(edits).toBeGreaterThan(50);
    expect(sim.time).toBeGreaterThan(400);
  }, 120_000);
});
