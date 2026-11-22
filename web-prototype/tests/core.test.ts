import { describe, it, expect } from 'vitest';
import { Rng } from '../src/core/rng';
import { CameraModel } from '../src/render/camera';
import {
  sampleBezier, straightBezier, polyAt, offsetPolyline, subPolyline, polyIntersections, makePolyline,
  closestOnPolyline, splitBezier, bezierPoint, quadToCubic, minRadius,
} from '../src/core/math';

describe('Rng', () => {
  it('is deterministic for a seed', () => {
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });
  it('produces values in [0,1)', () => {
    const r = new Rng(7);
    for (let i = 0; i < 10000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('differs across seeds', () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });
});

describe('CameraModel', () => {
  it('round-trips screen/world', () => {
    const c = new CameraModel();
    c.setViewport(800, 600);
    c.cx = 100; c.cy = 50; c.mpp = 0.5;
    const w = c.screenToWorld(123, 456);
    const s = c.worldToScreen(w.x, w.y);
    expect(s.x).toBeCloseTo(123);
    expect(s.y).toBeCloseTo(456);
  });
  it('zooms around the cursor', () => {
    const c = new CameraModel();
    c.setViewport(800, 600);
    c.mpp = 1;
    const before = c.screenToWorld(200, 100);
    c.zoomAt(200, 100, 0.5);
    const after = c.screenToWorld(200, 100);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(c.mpp).toBeCloseTo(0.5);
  });
  it('pans with screen y flipped', () => {
    const c = new CameraModel();
    c.setViewport(800, 600);
    c.mpp = 2;
    c.panPixels(10, 10);
    expect(c.cx).toBeCloseTo(-20);
    expect(c.cy).toBeCloseTo(20);
  });
});

describe('curves', () => {
  it('straight bezier length matches distance', () => {
    const p = sampleBezier(straightBezier({ x: 0, y: 0 }, { x: 100, y: 0 }));
    expect(p.length).toBeCloseTo(100, 3);
    const m = polyAt(p, 50);
    expect(m.x).toBeCloseTo(50);
    expect(m.tx).toBeCloseTo(1);
  });
  it('offset of a straight line is parallel', () => {
    const p = sampleBezier(straightBezier({ x: 0, y: 0 }, { x: 100, y: 0 }));
    const o = offsetPolyline(p, 3);
    expect(polyAt(o, 10).y).toBeCloseTo(3);
    expect(o.length).toBeCloseTo(100, 3);
  });
  it('sub polyline has the right length', () => {
    const p = sampleBezier(quadToCubic({ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }));
    const s = subPolyline(p, 10, 40);
    expect(s.length).toBeCloseTo(30, 0);
  });
  it('finds crossing intersections', () => {
    const a = makePolyline([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    const b = makePolyline([{ x: 0, y: 10 }, { x: 10, y: 0 }]);
    const hits = polyIntersections(a, b);
    expect(hits.length).toBe(1);
    expect(hits[0].x).toBeCloseTo(5);
    expect(hits[0].sa).toBeCloseTo(Math.SQRT2 * 5);
  });
  it('closest point', () => {
    const a = makePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    const c = closestOnPolyline(a, { x: 4, y: 3 });
    expect(c.s).toBeCloseTo(4);
    expect(c.d).toBeCloseTo(3);
  });
  it('split bezier joins at midpoint', () => {
    const b = quadToCubic({ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 });
    const [l, r] = splitBezier(b, 0.3);
    const m = bezierPoint(b, 0.3);
    expect(l.p3.x).toBeCloseTo(m.x);
    expect(r.p0.y).toBeCloseTo(m.y);
  });
  it('min radius of a circle-ish arc', () => {
    const pts = [];
    for (let i = 0; i <= 32; i++) pts.push({ x: 20 * Math.cos(i / 32 * Math.PI), y: 20 * Math.sin(i / 32 * Math.PI) });
    expect(minRadius(makePolyline(pts))).toBeCloseTo(20, 0);
  });
});
