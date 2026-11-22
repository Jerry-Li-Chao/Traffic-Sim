import { describe, it, expect } from 'vitest';
import { CAMPAIGN } from '../src/levels/campaign';
import { buildLevelWorld, compileLevel } from '../src/game/loadLevel';
import { Sim } from '../src/sim/Sim';
import { GoalTracker } from '../src/game/goals';
import { SOLUTIONS, applyActions } from './solutions';

function play(id: string, maxSeconds = 1500) {
  const def = CAMPAIGN.find((l) => l.id === id)!;
  const { world, ports } = buildLevelWorld(def);
  const spent = applyActions(world, def, SOLUTIONS[id]);
  const sim = new Sim();
  sim.load(compileLevel(world, def, ports));
  const tracker = new GoalTracker(def);
  let worst: Record<number, number> = {};
  for (let t = 0; t < maxSeconds * 10; t++) {
    sim.step();
    if (t % 10 === 0) {
      const st = sim.stats();
      if (tracker.update(st)) return { won: true, time: st.time, spent, budget: def.budget, removed: st.removed, flow: st.flow };
      worst = st.flow;
    }
  }
  return { won: false, time: sim.time, spent, budget: def.budget, removed: sim.removed, flow: worst, goals: def.goals };
}

describe('campaign', () => {
  it('has 11 sites with unique ids and valid goals', () => {
    expect(CAMPAIGN.length).toBe(11);
    expect(new Set(CAMPAIGN.map((l) => l.id)).size).toBe(11);
    for (const l of CAMPAIGN) {
      for (const g of l.goals) expect(l.ports.some((p) => p.id === g.port)).toBe(true);
      for (const d of l.demand) expect(l.ports.some((p) => p.id === d.from) && l.ports.some((p) => p.id === d.to)).toBe(true);
      expect(SOLUTIONS[l.id]).toBeTruthy();
    }
  });

  for (const def of CAMPAIGN) {
    it(`${def.id}: the reference solution fits the budget and completes the site`, () => {
      const r = play(def.id);
      if (!r.won) throw new Error(`not won: ${JSON.stringify(r)}`);
      expect(r.spent).toBeLessThanOrEqual(def.budget);
      expect(r.removed).toBeLessThan(5);
    }, 120_000);
  }
});
