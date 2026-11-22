import { describe, it, expect } from 'vitest';
import { GoalTracker, goalsMet, starsFor, GOAL_WARMUP } from '../src/game/goals';
import type { SimStats } from '../src/sim/types';

const stats = (time: number, flow: Record<number, number>): SimStats => ({
  time, vehicles: 0, arrivals: {}, flow, backlog: {}, stuck: 0, removed: 0, edgeFlow: new Float32Array(0), completed: 0, meanTrip: 0,
});
const level = { goals: [{ port: 1, minPerMin: 5 }, { port: 2, minPerMin: 3 }], rampUp: 30, hold: 60 };

describe('goals', () => {
  it('need every target and the warm-up', () => {
    expect(goalsMet(level, stats(GOAL_WARMUP - 1, { 1: 9, 2: 9 }))).toBe(false);
    expect(goalsMet(level, stats(GOAL_WARMUP + 1, { 1: 9, 2: 9 }))).toBe(true);
    expect(goalsMet(level, stats(GOAL_WARMUP + 1, { 1: 9, 2: 2 }))).toBe(false);
    expect(goalsMet({ ...level, goals: [] }, stats(500, {}))).toBe(false);
  });

  it('wins after holding, with dips draining rather than resetting', () => {
    const g = new GoalTracker(level);
    let t = 100;
    for (; t < 140; t++) g.update(stats(t, { 1: 6, 2: 4 }));
    expect(g.hold).toBeGreaterThan(35);
    g.update(stats(t++, { 1: 1, 2: 4 })); // a one-second dip
    expect(g.hold).toBeGreaterThan(30);
    for (; t < 200 && !g.won; t++) g.update(stats(t, { 1: 6, 2: 4 }));
    expect(g.won).toBe(true);
  });

  it('awards stars by money left', () => {
    expect(starsFor(100_000, 50_000)).toBe(3);
    expect(starsFor(100_000, 20_000)).toBe(2);
    expect(starsFor(100_000, 1_000)).toBe(1);
    expect(starsFor(Infinity, 0)).toBe(3);
  });
});
