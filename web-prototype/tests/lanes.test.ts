import { describe, it, expect } from 'vitest';
import { World } from '../src/world/World';
import { planRoad, applyRoad, snapAnchor } from '../src/world/build';
import { computeNetGeometry } from '../src/world/geometry';
import { nodeConnectors, defaultLaneMap, laneGeometry } from '../src/world/lanes';

const MAP = { width: 2000, height: 2000 };
function road(w: World, a: [number, number], b: [number, number], cls = 'street', control?: [number, number]) {
  const A = snapAnchor(w, { x: a[0], y: a[1] }, 3);
  const B = snapAnchor(w, { x: b[0], y: b[1] }, 3);
  const p = planRoad(w, { start: A, end: B, cls, level: 0, control: control ? { x: control[0], y: control[1] } : undefined }, MAP);
  if (!p.valid) throw new Error(p.reason);
  return applyRoad(w, p);
}
const nodeAt = (w: World, x: number, y: number) => [...w.nodes.values()].find((n) => Math.hypot(n.x - x, n.y - y) < 0.5)!;

describe('default lane map', () => {
  it('single lane serves every exit', () => {
    const m = defaultLaneMap(1, [
      { idx: 0, theta: -1.5, outLanes: 1, turn: 'R' },
      { idx: 1, theta: 0, outLanes: 1, turn: 'S' },
      { idx: 2, theta: 1.5, outLanes: 1, turn: 'L' },
    ]);
    expect(m.map((x) => x.exit).sort()).toEqual([0, 1, 2]);
  });
  it('two lanes: right lane straight+right, left lane straight+left', () => {
    const m = defaultLaneMap(2, [
      { idx: 0, theta: -1.5, outLanes: 2, turn: 'R' },
      { idx: 1, theta: 0, outLanes: 2, turn: 'S' },
      { idx: 2, theta: 1.5, outLanes: 2, turn: 'L' },
    ]);
    const lane0 = m.filter((x) => x.lane === 0).map((x) => x.exit).sort();
    const lane1 = m.filter((x) => x.lane === 1).map((x) => x.exit).sort();
    expect(lane0).toEqual([0, 1]);
    expect(lane1).toEqual([1, 2]);
    // right turn goes to the right-most lane, left turn to the inner lane
    expect(m.find((x) => x.exit === 0)!.outLane).toBe(0);
    expect(m.find((x) => x.exit === 2)!.outLane).toBe(1);
  });
  it('diverge keeps all lanes on the through road', () => {
    const m = defaultLaneMap(2, [
      { idx: 0, theta: 0, outLanes: 2, turn: 'S' },
      { idx: 1, theta: -0.3, outLanes: 1, turn: 'S' },
    ]);
    expect(m.filter((x) => x.exit === 0).length).toBe(2);
    expect(m.filter((x) => x.exit === 1).map((x) => x.lane)).toEqual([0]);
  });
});

describe('junction connectors', () => {
  it('4-way street crossing has 12 connectors', () => {
    const w = new World();
    road(w, [100, 300], [500, 300]);
    road(w, [300, 100], [300, 500]);
    const geom = computeNetGeometry(w);
    const c = nodeConnectors(w, geom, nodeAt(w, 300, 300).id);
    expect(c.length).toBe(12);
    expect(c.filter((x) => x.turn === 'S').length).toBe(4);
    expect(c.filter((x) => x.turn === 'L').length).toBe(4);
    // connectors start where the incoming lane ends
    for (const k of c) {
      const lg = laneGeometry(w, geom, k.from);
      const end = { x: lg.poly.pts[lg.poly.pts.length - 2], y: lg.poly.pts[lg.poly.pts.length - 1] };
      expect(Math.hypot(end.x - k.bezier.p0.x, end.y - k.bezier.p0.y)).toBeLessThan(0.01);
      expect(k.poly.length).toBeGreaterThan(3);
    }
  });

  it('right turns are tighter than left turns (right-hand traffic)', () => {
    const w = new World();
    road(w, [100, 300], [500, 300], 'avenue');
    road(w, [300, 100], [300, 500], 'avenue');
    const geom = computeNetGeometry(w);
    const c = nodeConnectors(w, geom, nodeAt(w, 300, 300).id);
    const r = c.filter((x) => x.turn === 'R').map((x) => x.poly.length);
    const l = c.filter((x) => x.turn === 'L').map((x) => x.poly.length);
    expect(Math.max(...r)).toBeLessThan(Math.min(...l));
  });

  it('seamless joint connects lanes directly', () => {
    const w = new World();
    road(w, [100, 300], [300, 300]);
    road(w, [300, 300], [500, 300]);
    const geom = computeNetGeometry(w);
    const n = nodeAt(w, 300, 300);
    expect(geom.nodes.get(n.id)!.junction).toBe(false);
    const c = nodeConnectors(w, geom, n.id);
    expect(c.length).toBe(2);
    expect(c.every((x) => x.direct)).toBe(true);
  });

  it('highway on-ramp merges side by side into a wider road', () => {
    const w = new World();
    // highway (one-way, 2 lanes) west->east to a node, continues as 3-lane
    road(w, [100, 500], [600, 500], 'highway');
    road(w, [600, 500], [1100, 500], 'highway3');
    // ramp from the south-west joining at the node
    road(w, [300, 380], [600, 500], 'ramp', [450, 465]);
    const geom = computeNetGeometry(w);
    const n = nodeAt(w, 600, 500);
    const c = nodeConnectors(w, geom, n.id);
    const ramp = c.filter((x) => w.seg(x.from.seg).cls === 'ramp');
    const hw = c.filter((x) => w.seg(x.from.seg).cls === 'highway');
    expect(ramp.length).toBe(1);
    expect(hw.length).toBe(2);
    const used = [...ramp, ...hw].map((x) => x.to.idx).sort();
    expect(used).toEqual([0, 1, 2]);
    // ramp (right side when heading east? it's from y=380 i.e. south) takes the outer lane
    expect(ramp[0].to.idx).toBe(0);
  });

  it('respects lane overrides', () => {
    const w = new World();
    road(w, [100, 300], [500, 300]);
    road(w, [300, 100], [300, 500]);
    const n = nodeAt(w, 300, 300);
    const geom0 = computeNetGeometry(w);
    const all = nodeConnectors(w, geom0, n.id);
    const first = all[0];
    // only allow straight for that approach
    const straight = all.find((x) => x.from.seg === first.from.seg && x.turn === 'S')!;
    n.lanes = { [`${first.from.seg}:0`]: [`${straight.to.seg}:0`] };
    const c = nodeConnectors(w, computeNetGeometry(w), n.id);
    expect(c.filter((x) => x.from.seg === first.from.seg).length).toBe(1);
    expect(c.length).toBe(10);
  });
});
