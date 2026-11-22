import { describe, it, expect } from 'vitest';
import { riverOutline } from '../src/levels/river';
import { CAMPAIGN } from '../src/levels/campaign';
import { buildLevelWorld } from '../src/game/loadLevel';
import { planRoad, snapAnchor } from '../src/world/build';
import { pointInPolygon } from '../src/core/math';

describe('rivers', () => {
  it('outline runs off both map edges and contains its centre line', () => {
    const pts = riverOutline([[0, 500], [500, 560], [1000, 480]], 120, 1000, 1000);
    expect(pts.length).toBeLessThanOrEqual(128);
    const xs = pts.map((p) => p[0]);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(1000);
    const poly = pts.map(([x, y]) => ({ x, y }));
    expect(pointInPolygon({ x: 500, y: 560 }, poly)).toBe(true);
    expect(pointInPolygon({ x: 500, y: 680 }, poly)).toBe(false);
  });
});

describe('grade-separated sites', () => {
  const def = CAMPAIGN.find((l) => l.id === 'c11-four-shores')!;
  it('refuses a highway crossing another at the same level', () => {
    const { world } = buildLevelWorld(def);
    const a = snapAnchor(world, { x: 1000, y: 1150 }, 3, { level: 0 });
    const b = snapAnchor(world, { x: 1000, y: 1400 }, 3, { level: 0 });
    const plan = planRoad(world, { start: a, end: b, cls: 'ramp', level: 0 }, def);
    expect(plan.valid).toBe(false);
    expect(plan.reason).toMatch(/bridge or in a tunnel/);
  });
  it('allows the same road on a bridge', () => {
    const { world } = buildLevelWorld(def);
    const a = snapAnchor(world, { x: 1000, y: 1150 }, 3, { level: 1 });
    const b = snapAnchor(world, { x: 1000, y: 1400 }, 3, { level: 1 });
    expect(planRoad(world, { start: a, end: b, cls: 'ramp', level: 1 }, def).valid).toBe(true);
  });
  it('other sites still allow at-grade crossings', () => {
    const { world } = buildLevelWorld(def);
    const a = snapAnchor(world, { x: 1000, y: 1150 }, 3, { level: 0 });
    const b = snapAnchor(world, { x: 1000, y: 1400 }, 3, { level: 0 });
    expect(planRoad(world, { start: a, end: b, cls: 'ramp', level: 0 }, { width: def.width, height: def.height }).valid).toBe(true);
  });
});
