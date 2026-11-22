import { describe, it, expect } from 'vitest';
import { buildLevelWorld, compileLevel } from '../src/game/loadLevel';
import { CAMPAIGN } from '../src/levels/campaign';
import { World } from '../src/world/World';
import { TEMPLATES, highwayFrame, planTemplate, applyTemplate } from '../src/world/templates';
import { Sim } from '../src/sim/Sim';
import { planRoad, applyRoad, snapAnchor } from '../src/world/build';
import { run, assertNoOverlap } from './helpers';

describe('road templates', () => {
  const site = CAMPAIGN.find((l) => l.id === 'c6-highway-exit')!;
  const map = { width: site.width, height: site.height };

  for (const t of TEMPLATES.filter((x) => x.fit === 'highway')) {
    it(`${t.name} fits a dual carriageway and carries the site's traffic`, () => {
      const { world, ports } = buildLevelWorld(site);
      const f = highwayFrame(world, { x: 800, y: 490 })!;
      expect(f).not.toBeNull();
      expect(f.h).toBeCloseTo(20, 0);
      const plan = planTemplate(world, t, f, map);
      expect(plan.reason).toBeUndefined();
      expect(plan.valid).toBe(true);
      expect(plan.cost).toBeGreaterThan(0);
      applyTemplate(world, t, f, map);
      // join the street ends to the two towns, as a player would
      for (const [from, to] of [
        [{ x: 800, y: 500 - 20 - 175 - 110 }, ports.find((p) => p.id === 6)!],
        [{ x: 800, y: 500 + 20 + 175 + 110 }, ports.find((p) => p.id === 5)!],
      ] as const) {
        // connect to the inner end of the town's stub road
        const stub = world.segmentsAt(to.node)[0];
        const n = world.node(world.otherEnd(stub, to.node));
        const pl = planRoad(world, { start: snapAnchor(world, from, 4), end: { kind: 'node', node: n.id, pos: { x: n.x, y: n.y } }, cls: 'street', level: 0 }, map);
        expect(pl.reason).toBeUndefined();
        applyRoad(world, pl);
      }
      const sim = new Sim();
      sim.load(compileLevel(world, site, ports));
      run(sim, 600, assertNoOverlap);
      const st = sim.stats();
      expect(st.removed).toBe(0);
      // every destination is reachable through the interchange
      for (const g of site.goals) expect(st.arrivals[g.port] ?? 0).toBeGreaterThan(5);
    });
  }

  for (const t of TEMPLATES.filter((x) => x.fit === 'free')) {
    it(`${t.name} can be placed on open ground, at any angle`, () => {
      for (const ang of [0, 0.4]) {
        const w = new World();
        const f = { origin: { x: 600, y: 600 }, ex: { x: Math.cos(ang), y: Math.sin(ang) }, h: 0 };
        const plan = planTemplate(w, t, f, { width: 1200, height: 1200 });
        expect(plan.reason).toBeUndefined();
        applyTemplate(w, t, f, { width: 1200, height: 1200 });
        expect(w.segments.size).toBeGreaterThan(3);
      }
    });
  }

  for (const t of TEMPLATES.filter((x) => x.fit === 'highway')) {
    it(`${t.name} can also be placed on open ground, bringing its own highway`, () => {
      const w = new World();
      const f = { origin: { x: 800, y: 800 }, ex: { x: Math.cos(0.3), y: Math.sin(0.3) }, h: 20, standalone: true };
      const plan = planTemplate(w, t, f, { width: 1600, height: 1600 });
      expect(plan.reason).toBeUndefined();
      applyTemplate(w, t, f, { width: 1600, height: 1600 });
      expect([...w.segments.values()].filter((s) => s.cls === 'highway').length).toBeGreaterThanOrEqual(4);
      expect([...w.segments.values()].filter((s) => s.cls === 'ramp').length).toBe(4);
    });
  }
});
