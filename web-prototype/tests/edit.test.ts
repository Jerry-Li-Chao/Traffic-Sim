import { describe, it, expect } from 'vitest';
import { World, crossSection } from '../src/world/World';
import { planRoad, applyRoad, snapAnchor } from '../src/world/build';
import { computeNetGeometry } from '../src/world/geometry';
import { nodeConnectors } from '../src/world/lanes';
import { upgradePlan } from '../src/tools/UpgradeTool';
import { pieceAt, pieceCost, removePiece, PIECE_LENGTH } from '../src/tools/BulldozeTool';

const MAP = { width: 2000, height: 2000 };
function road(w: World, a: [number, number], b: [number, number], cls = 'street') {
  const p = planRoad(w, { start: snapAnchor(w, { x: a[0], y: a[1] }, 3), end: snapAnchor(w, { x: b[0], y: b[1] }, 3), cls, level: 0 }, MAP);
  if (!p.valid) throw new Error(p.reason);
  return applyRoad(w, p);
}
const nodeAt = (w: World, x: number, y: number) => [...w.nodes.values()].find((n) => Math.hypot(n.x - x, n.y - y) < 0.5)!;

describe('in-place editing', () => {
  it('upgrading keeps connectivity and changes lanes', () => {
    const w = new World();
    road(w, [100, 300], [500, 300]);
    road(w, [300, 100], [300, 500]);
    const center = nodeAt(w, 300, 300);
    const segBefore = w.segmentsAt(center.id).map((s) => s.id).sort();
    const s = w.segmentsAt(center.id)[0];
    const plan = upgradePlan(w, s, 'avenue');
    expect(plan.lanesF).toBe(2);
    expect(plan.cost).toBeGreaterThan(0);
    s.cls = 'avenue';
    s.lanesF = plan.lanesF;
    s.lanesB = plan.lanesB;
    expect(w.segmentsAt(center.id).map((x) => x.id).sort()).toEqual(segBefore);
    const c = nodeConnectors(w, computeNetGeometry(w), center.id);
    // avenue approach has two lanes now
    expect(c.filter((x) => x.from.seg === s.id).length).toBeGreaterThanOrEqual(3);
  });

  it('asymmetric lanes produce an off-centre layout', () => {
    const w = new World();
    const [id] = road(w, [100, 300], [500, 300]);
    const s = w.seg(id);
    s.lanesF = 3;
    s.lanesB = 2;
    const cs = crossSection(s);
    expect(cs.fwdOffset(0)).toBeLessThan(0);
    expect(cs.bwdOffset(0)).toBeGreaterThan(0);
    expect(Math.abs(cs.fwdOffset(0)) - Math.abs(cs.bwdOffset(0))).toBeCloseTo(0, 5);
    expect(cs.medianOffset).toBeGreaterThan(0); // centre line shifts away from the wider forward side
  });

  it('reversing a one-way road flips its travel direction', () => {
    const w = new World();
    const [id] = road(w, [100, 300], [500, 300], 'oneway');
    const s = w.seg(id);
    const a = s.a;
    w.reverseSegment(id);
    expect(s.a).toBe(a);
    expect(s.lanesF).toBe(0);
    expect(s.lanesB).toBe(2);
    // upgrade of a reversed one-way keeps the orientation
    const plan = upgradePlan(w, s, 'highway');
    expect(plan.lanesF).toBe(0);
    expect(plan.lanesB).toBe(2);
  });

  it('one-way roads only connect in their direction', () => {
    const w = new World();
    road(w, [100, 300], [300, 300], 'oneway');
    road(w, [300, 300], [300, 500]);
    road(w, [300, 300], [500, 300]);
    const n = nodeAt(w, 300, 300);
    const c = nodeConnectors(w, computeNetGeometry(w), n.id);
    const ow = w.segmentsAt(n.id).find((s) => s.cls === 'oneway')!;
    expect(c.some((x) => x.to.seg === ow.id)).toBe(false);
    expect(c.some((x) => x.from.seg === ow.id)).toBe(true);
  });

  it('bulldozing a long road removes one section at a time', () => {
    const w = new World();
    const [id] = road(w, [100, 300], [700, 300]); // 600 m
    const total = w.seg(id).cost!;
    const piece = pieceAt(w, id, 310);
    expect(piece.n).toBe(Math.round(600 / PIECE_LENGTH));
    expect(piece.s1 - piece.s0).toBeCloseTo(600 / piece.n, 5);
    const removedCost = pieceCost(w, id, 310);
    removePiece(w, id, 310);
    // two stubs remain, one each side of the gap, adding up to the rest of the road
    const left = [...w.segments.values()];
    expect(left.length).toBe(2);
    const len = left.reduce((a, s) => a + w.poly(s).length, 0);
    expect(len).toBeCloseTo(600 - 600 / piece.n, 0);
    const cost = left.reduce((a, s) => a + (s.cost ?? 0), 0);
    expect(Math.abs(cost + removedCost - total)).toBeLessThan(total * 0.02);
    // an end section leaves a single stub
    const end = left.find((s) => w.node(s.a).x < 200 || w.node(s.b).x < 200)!;
    removePiece(w, end.id, 1);
    expect(w.segments.size).toBe(2);
    // a short road goes in one go
    const w2 = new World();
    const [short] = road(w2, [100, 300], [160, 300]);
    expect(pieceAt(w2, short, 30).n).toBe(1);
    removePiece(w2, short, 30);
    expect(w2.segments.size).toBe(0);
    expect(w2.nodes.size).toBe(0);
  });

  it('roads can join a slope part-way up, unless that leaves it too steep', () => {
    const w = new World();
    // a long ramp from a ground node up to bridge height
    const n0 = w.addNode(100, 300, 0);
    const ramp = planRoad(w, { start: { kind: 'node', node: n0.id, pos: { x: 100, y: 300 } }, end: { kind: 'free', pos: { x: 400, y: 300 } }, cls: 'street', level: 1 }, MAP);
    expect(ramp.valid).toBe(true);
    applyRoad(w, ramp);
    // a side street meeting the middle of the slope
    const side = planRoad(w, { start: { kind: 'free', pos: { x: 250, y: 150 } }, end: snapAnchor(w, { x: 250, y: 300 }, 3), cls: 'street', level: 0 }, MAP);
    expect(side.valid).toBe(true);
    expect(side.endLevel).toBeGreaterThan(0.2);
    expect(side.endLevel).toBeLessThan(0.8);
    applyRoad(w, side);
    const mid = nodeAt(w, 250, 300);
    expect(mid.level).toBeCloseTo(side.endLevel, 3);
    for (const sg of w.segments.values()) expect(w.maxGrade(sg)).toBeLessThanOrEqual(0.13 + 1e-6);
    // joining a short, steep ramp near its foot would make the upper part too steep
    const w2 = new World();
    const f = w2.addNode(100, 600, 0);
    applyRoad(w2, planRoad(w2, { start: { kind: 'node', node: f.id, pos: { x: 100, y: 600 } }, end: { kind: 'free', pos: { x: 175, y: 600 } }, cls: 'street', level: 1 }, MAP));
    const steep = planRoad(w2, { start: { kind: 'free', pos: { x: 160, y: 450 } }, end: snapAnchor(w2, { x: 160, y: 600 }, 3), cls: 'street', level: 0 }, MAP);
    expect(steep.valid).toBe(false);
  });

  it('one height level can be climbed in about 70 m', () => {
    const w = new World();
    const n = w.addNode(100, 900, 0);
    const ok = planRoad(w, { start: { kind: 'node', node: n.id, pos: { x: 100, y: 900 } }, end: { kind: 'free', pos: { x: 172, y: 900 } }, cls: 'street', level: 1 }, MAP);
    expect(ok.valid).toBe(true);
    const tooShort = planRoad(w, { start: { kind: 'node', node: n.id, pos: { x: 100, y: 900 } }, end: { kind: 'free', pos: { x: 150, y: 900 } }, cls: 'street', level: 1 }, MAP);
    expect(tooShort.valid).toBe(false);
  });
});
