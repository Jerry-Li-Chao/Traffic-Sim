// Goal evaluation: every goal port must sustain its minimum arrival rate.
import type { LevelDef } from './level';
import type { SimStats } from '../sim/types';

/** Flow can only be judged after the demand ramp-up and one measurement window. */
export const GOAL_WARMUP = 90;

export function goalsMet(level: Pick<LevelDef, 'goals' | 'rampUp'>, stats: SimStats): boolean {
  if (!level.goals.length) return false;
  if (stats.time < Math.max(GOAL_WARMUP, level.rampUp ?? 60)) return false;
  return level.goals.every((g) => (stats.flow[g.port] ?? 0) >= g.minPerMin);
}

/** Tracks how long goals have been met continuously. */
export class GoalTracker {
  hold = 0;
  won = false;
  private lastTime = 0;
  constructor(private level: Pick<LevelDef, 'goals' | 'rampUp' | 'hold'>) {}

  update(stats: SimStats): boolean {
    const dt = Math.max(0, stats.time - this.lastTime);
    this.lastTime = stats.time;
    // brief dips (random arrival noise) drain the timer instead of resetting it
    if (goalsMet(this.level, stats)) this.hold += dt;
    else this.hold = Math.max(0, this.hold - dt * 2);
    if (!this.won && this.hold >= this.level.hold) this.won = true;
    return this.won;
  }

  reset() {
    this.hold = 0;
    this.won = false;
    this.lastTime = 0;
  }
}

/** 1-3 stars from the share of the budget left over. */
export function starsFor(budget: number, moneyLeft: number): number {
  if (!Number.isFinite(budget) || budget <= 0) return 3;
  const left = moneyLeft / budget;
  return left >= 0.4 ? 3 : left >= 0.15 ? 2 : 1;
}
