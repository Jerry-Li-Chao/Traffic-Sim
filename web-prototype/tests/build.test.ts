import { describe, it, expect } from 'vitest';
import { World } from '../src/world/World';
import { planRoad, applyRoad, snapAnchor, type Anchor } from '../src/world/build';
import { computeNetGeometry } from '../src/world/geometry';

const MAP = { width: 1000, height: 1000 };
const free = (x: number, y: number): Anchor => ({ kind: 'free', pos: { x, y } });

function build(w: World, a: Anchor, b: Anchor, cls = 'street', level = 0, control?: { x: number; y: number }) {
  const plan = planRoad(w, { start: a, end: b, cls, level, control }, MAP);
  if (plan.valid) applyRoad(w, plan);
  return plan;
}

describe('road building', () => {
  it('builds a straight road with two nodes', () => {
    const w = new World();
    const p = build(w, free(100, 100), free(300, 100));
    expect(p.valid).toBe(true);
    expect(w.segments.size).toBe(1);
    expect(w.nodes.size).toBe(2);
    expect(p.length).toBeCloseTo(200, 0);
    expect(p.cost).toBeGreaterThan(0);
  });

  it('rejects too short and out of bounds', () => {
    const w = new World();
    expect(build(w, free(100, 100), free(105, 100)).valid).toBe(false);
    expect(build(w, free(100, 100), free(1200, 100)).reason).toBe('Outside the site');
  });

  it('crossing at the same level creates a junction', () => {
    const w = new World();
    build(w, free(100, 300), free(500, 300));
    const p = build(w, free(300, 100), free(300, 500));
    expect(p.valid).toBe(true);
    expect(p.hits.length).toBe(1);
    // 2 original halves + 2 new halves
    expect(w.segments.size).toBe(4);
    const center = [...w.nodes.values()].find((n) => Math.abs(n.x - 300) < 1 && Math.abs(n.y - 300) < 1)!;
    expect(center).toBeTruthy();
    expect(w.degree(center.id)).toBe(4);
    const geom = computeNetGeometry(w);
    expect(geom.nodes.get(center.id)!.junction).toBe(true);
    expect(geom.nodes.get(center.id)!.polygon.length).toBeGreaterThan(4);
  });

  it('bridge over a road does not connect', () => {
    const w = new World();
    build(w, free(100, 300), free(700, 300));
    // ramp up from ground to level 1 needs length; build a level 1 road across
    const p = build(w, free(400, 100), free(400, 500), 'street', 1);
    expect(p.valid).toBe(true);
    expect(p.hits.length).toBe(0);
    expect(w.segments.size).toBe(2);
  });

  it('rejects ramps that are too steep', () => {
    const w = new World();
    build(w, free(100, 100), free(200, 100));
    const n = [...w.nodes.values()].find((x) => x.x === 200)!;
    const p = build(w, { kind: 'node', node: n.id, pos: { x: 200, y: 100 } }, free(240, 100), 'street', 2);
    expect(p.valid).toBe(false);
    expect(p.reason).toMatch(/steep/);
  });

  it('rejects insufficient clearance', () => {
    const w = new World();
    build(w, free(100, 300), free(700, 300));
    // ramp from ground to +1 crossing the road mid-ramp
    const p = build(w, free(400, 250), free(400, 500), 'street', 1);
    // start free at level 1 too (free anchors use picked level) -> both ends level 1 -> clears
    expect(p.valid).toBe(true);
    const w2 = new World();
    build(w2, free(100, 300), free(700, 300));
    build(w2, free(380, 100), free(380, 200));
    const n = [...w2.nodes.values()].find((x) => x.x === 380 && x.y === 200)!;
    const p2 = build(w2, { kind: 'node', node: n.id, pos: { x: 380, y: 200 } }, free(380, 420), 'street', 1);
    expect(p2.valid).toBe(false);
    expect(p2.reason).toMatch(/clearance/);
  });

  it('snaps to segments and splits them', () => {
    const w = new World();
    build(w, free(100, 300), free(500, 300));
    const a = snapAnchor(w, { x: 300, y: 303 }, 5);
    expect(a.kind).toBe('seg');
    const p = build(w, a, free(300, 600));
    expect(p.valid).toBe(true);
    expect(w.segments.size).toBe(3);
  });

  it('builds curved roads', () => {
    const w = new World();
    const p = build(w, free(100, 100), free(300, 100), 'street', 0, { x: 200, y: 250 });
    expect(p.valid).toBe(true);
    expect(p.length).toBeGreaterThan(220);
  });

  it('round-trips through JSON', () => {
    const w = new World();
    build(w, free(100, 300), free(500, 300));
    build(w, free(300, 100), free(300, 500));
    const w2 = new World();
    w2.load(JSON.parse(JSON.stringify(w.toJSON())));
    expect(w2.segments.size).toBe(w.segments.size);
    expect(w2.nextId).toBe(w.nextId);
  });
});
