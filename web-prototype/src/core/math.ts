// Small 2D math + curve toolkit shared by world, sim and render.

export interface Vec2 {
  x: number;
  y: number;
}

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
export const len = (a: Vec2) => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerpV = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const norm = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
};
/** Left-hand normal (rotate +90° in a y-up frame). */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const angleOf = (a: Vec2) => Math.atan2(a.y, a.x);
/** Wrap angle to (-PI, PI]. */
export const wrapAngle = (a: number) => {
  while (a <= -Math.PI) a += Math.PI * 2;
  while (a > Math.PI) a -= Math.PI * 2;
  return a;
};
export const smoothstep = (t: number) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------------------
// Cubic Bézier

export interface Bezier {
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
}

export function bezierPoint(b: Bezier, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u,
    c = 3 * u * u * t,
    d = 3 * u * t * t,
    e = t * t * t;
  return {
    x: a * b.p0.x + c * b.p1.x + d * b.p2.x + e * b.p3.x,
    y: a * b.p0.y + c * b.p1.y + d * b.p2.y + e * b.p3.y,
  };
}

export function bezierTangent(b: Bezier, t: number): Vec2 {
  const u = 1 - t;
  const x =
    3 * u * u * (b.p1.x - b.p0.x) + 6 * u * t * (b.p2.x - b.p1.x) + 3 * t * t * (b.p3.x - b.p2.x);
  const y =
    3 * u * u * (b.p1.y - b.p0.y) + 6 * u * t * (b.p2.y - b.p1.y) + 3 * t * t * (b.p3.y - b.p2.y);
  if (x === 0 && y === 0) return norm(sub(b.p3, b.p0));
  return norm({ x, y });
}

/** A straight Bézier between two points (control points at thirds). */
export function straightBezier(a: Vec2, b: Vec2): Bezier {
  return { p0: a, p1: lerpV(a, b, 1 / 3), p2: lerpV(a, b, 2 / 3), p3: b };
}

/** Quadratic -> cubic conversion: a curve from a to b bending toward control c. */
export function quadToCubic(a: Vec2, c: Vec2, b: Vec2): Bezier {
  return {
    p0: a,
    p1: lerpV(a, c, 2 / 3),
    p2: lerpV(b, c, 2 / 3),
    p3: b,
  };
}

export function reverseBezier(b: Bezier): Bezier {
  return { p0: b.p3, p1: b.p2, p2: b.p1, p3: b.p0 };
}

/** Split a Bézier at t (de Casteljau). */
export function splitBezier(b: Bezier, t: number): [Bezier, Bezier] {
  const p01 = lerpV(b.p0, b.p1, t);
  const p12 = lerpV(b.p1, b.p2, t);
  const p23 = lerpV(b.p2, b.p3, t);
  const p012 = lerpV(p01, p12, t);
  const p123 = lerpV(p12, p23, t);
  const m = lerpV(p012, p123, t);
  return [
    { p0: b.p0, p1: p01, p2: p012, p3: m },
    { p0: m, p1: p123, p2: p23, p3: b.p3 },
  ];
}

export function bezierLengthEstimate(b: Bezier, n = 24): number {
  let l = 0;
  let prev = b.p0;
  for (let i = 1; i <= n; i++) {
    const p = bezierPoint(b, i / n);
    l += dist(prev, p);
    prev = p;
  }
  return l;
}

// ---------------------------------------------------------------------------
// Polylines with arc-length parameterisation

export interface Polyline {
  /** x,y interleaved */
  pts: number[];
  /** cumulative length at each vertex */
  cum: number[];
  length: number;
}

export function makePolyline(points: Vec2[]): Polyline {
  const pts: number[] = [];
  const cum: number[] = [];
  let l = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      const q = points[i - 1];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < 1e-6) continue;
      l += d;
    }
    pts.push(p.x, p.y);
    cum.push(l);
  }
  if (pts.length === 2) {
    // degenerate: duplicate point so callers always get >= 2 vertices
    pts.push(pts[0], pts[1]);
    cum.push(0);
  }
  return { pts, cum, length: l };
}

export function sampleBezier(b: Bezier, step = 2): Polyline {
  const est = bezierLengthEstimate(b);
  const n = Math.max(2, Math.ceil(est / step));
  const points: Vec2[] = [];
  for (let i = 0; i <= n; i++) points.push(bezierPoint(b, i / n));
  return makePolyline(points);
}

export function polyCount(p: Polyline) {
  return p.pts.length / 2;
}

export function polyVertex(p: Polyline, i: number): Vec2 {
  return { x: p.pts[i * 2], y: p.pts[i * 2 + 1] };
}

/** Binary search: index i such that cum[i] <= s < cum[i+1]. */
function findIndex(p: Polyline, s: number): number {
  const cum = p.cum;
  let lo = 0,
    hi = cum.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface PolySample {
  x: number;
  y: number;
  /** unit tangent */
  tx: number;
  ty: number;
}

export function polyAt(p: Polyline, s: number, out?: PolySample): PolySample {
  const o = out ?? { x: 0, y: 0, tx: 1, ty: 0 };
  const n = p.cum.length;
  if (n < 2) {
    o.x = p.pts[0];
    o.y = p.pts[1];
    return o;
  }
  if (s <= 0) s = 0;
  if (s >= p.length) s = p.length;
  const i = findIndex(p, s);
  const j = Math.min(i + 1, n - 1);
  const x0 = p.pts[i * 2],
    y0 = p.pts[i * 2 + 1],
    x1 = p.pts[j * 2],
    y1 = p.pts[j * 2 + 1];
  const segLen = p.cum[j] - p.cum[i];
  const t = segLen > 0 ? (s - p.cum[i]) / segLen : 0;
  o.x = x0 + (x1 - x0) * t;
  o.y = y0 + (y1 - y0) * t;
  const dl = Math.hypot(x1 - x0, y1 - y0) || 1;
  o.tx = (x1 - x0) / dl;
  o.ty = (y1 - y0) / dl;
  return o;
}

/** Offset a polyline sideways (positive = left). Uses averaged vertex normals. */
export function offsetPolyline(p: Polyline, d: number): Polyline {
  return offsetPolylineVar(p, () => d);
}

/** Offset with a distance that varies along the line; `f` gets the fraction 0..1 of arc length. */
export function offsetPolylineVar(p: Polyline, f: (u: number) => number): Polyline {
  const n = polyCount(p);
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = polyVertex(p, Math.max(0, i - 1));
    const b = polyVertex(p, i);
    const c = polyVertex(p, Math.min(n - 1, i + 1));
    let t1 = norm(sub(b, a));
    let t2 = norm(sub(c, b));
    if (i === 0) t1 = t2;
    if (i === n - 1) t2 = t1;
    const t = norm(add(t1, t2));
    const nrm = perp(t);
    // miter correction, limited
    const c2 = dot(perp(t1), nrm);
    const m = c2 > 0.5 ? 1 / c2 : 2;
    const d = f(p.length > 0 ? p.cum[i] / p.length : 0);
    out.push({ x: b.x + nrm.x * d * m, y: b.y + nrm.y * d * m });
  }
  return makePolyline(out);
}

/** Sub-polyline between arc lengths s0 and s1 (s0 < s1). */
export function subPolyline(p: Polyline, s0: number, s1: number): Polyline {
  s0 = clamp(s0, 0, p.length);
  s1 = clamp(s1, 0, p.length);
  const pts: Vec2[] = [];
  const a = polyAt(p, s0);
  pts.push({ x: a.x, y: a.y });
  for (let i = 0; i < p.cum.length; i++) {
    if (p.cum[i] > s0 && p.cum[i] < s1) pts.push(polyVertex(p, i));
  }
  const b = polyAt(p, s1);
  pts.push({ x: b.x, y: b.y });
  return makePolyline(pts);
}

export function reversePolyline(p: Polyline): Polyline {
  const pts: Vec2[] = [];
  for (let i = polyCount(p) - 1; i >= 0; i--) pts.push(polyVertex(p, i));
  return makePolyline(pts);
}

/** Closest point on polyline to q: returns arc length and distance. */
export function closestOnPolyline(p: Polyline, q: Vec2): { s: number; d: number; x: number; y: number } {
  let best = { s: 0, d: Infinity, x: 0, y: 0 };
  const n = polyCount(p);
  for (let i = 0; i < n - 1; i++) {
    const ax = p.pts[i * 2],
      ay = p.pts[i * 2 + 1],
      bx = p.pts[i * 2 + 2],
      by = p.pts[i * 2 + 3];
    const dx = bx - ax,
      dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((q.x - ax) * dx + (q.y - ay) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    const x = ax + dx * t,
      y = ay + dy * t;
    const d = Math.hypot(q.x - x, q.y - y);
    if (d < best.d) best = { s: p.cum[i] + Math.sqrt(l2) * t, d, x, y };
  }
  return best;
}

/** Segment-segment intersection. Returns params (t,u) in [0,1] or null. */
export function segIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): { t: number; u: number } | null {
  const rX = bx - ax,
    rY = by - ay,
    sX = dx - cx,
    sY = dy - cy;
  const den = rX * sY - rY * sX;
  if (Math.abs(den) < 1e-12) return null;
  const qpX = cx - ax,
    qpY = cy - ay;
  const t = (qpX * sY - qpY * sX) / den;
  const u = (qpX * rY - qpY * rX) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/** All intersections between two polylines, as arc-length pairs. */
export function polyIntersections(a: Polyline, b: Polyline): { sa: number; sb: number; x: number; y: number }[] {
  const res: { sa: number; sb: number; x: number; y: number }[] = [];
  const na = polyCount(a),
    nb = polyCount(b);
  // bounding box reject
  const bb = (p: Polyline) => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let i = 0; i < p.pts.length; i += 2) {
      x0 = Math.min(x0, p.pts[i]);
      x1 = Math.max(x1, p.pts[i]);
      y0 = Math.min(y0, p.pts[i + 1]);
      y1 = Math.max(y1, p.pts[i + 1]);
    }
    return { x0, y0, x1, y1 };
  };
  const A = bb(a),
    B = bb(b);
  if (A.x1 < B.x0 || B.x1 < A.x0 || A.y1 < B.y0 || B.y1 < A.y0) return res;
  for (let i = 0; i < na - 1; i++) {
    const ax = a.pts[i * 2],
      ay = a.pts[i * 2 + 1],
      bx = a.pts[i * 2 + 2],
      by = a.pts[i * 2 + 3];
    for (let j = 0; j < nb - 1; j++) {
      const r = segIntersect(ax, ay, bx, by, b.pts[j * 2], b.pts[j * 2 + 1], b.pts[j * 2 + 2], b.pts[j * 2 + 3]);
      if (r) {
        const sa = a.cum[i] + (a.cum[i + 1] - a.cum[i]) * r.t;
        const sb = b.cum[j] + (b.cum[j + 1] - b.cum[j]) * r.u;
        // dedupe hits on shared vertices
        if (res.some((h) => Math.abs(h.sa - sa) < 0.5 && Math.abs(h.sb - sb) < 0.5)) continue;
        res.push({ sa, sb, x: ax + (bx - ax) * r.t, y: ay + (by - ay) * r.t });
      }
    }
  }
  return res;
}

/** Signed curvature radius estimate of a polyline (min radius along it). */
export function minRadius(p: Polyline): number {
  let minR = Infinity;
  const n = polyCount(p);
  for (let i = 1; i < n - 1; i++) {
    const a = polyVertex(p, i - 1),
      b = polyVertex(p, i),
      c = polyVertex(p, i + 1);
    const ab = dist(a, b),
      bc = dist(b, c),
      ca = dist(c, a);
    const area2 = Math.abs(cross(sub(b, a), sub(c, a)));
    if (area2 < 1e-9) continue;
    const r = (ab * bc * ca) / (2 * area2);
    if (r < minR) minR = r;
  }
  return minR;
}

export function pointInPolygon(q: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
