// Helpers for authoring maps with rivers.

type P = [number, number];

/**
 * Outline of a river `width` metres wide following a smooth curve through `center` (Catmull-Rom).
 * The first and last points should sit on the edge of the map so the river runs off the site.
 */
export function riverOutline(center: P[], width: number, mapW: number, mapH: number, spacing = 60): P[] {
  const pts: P[] = [];
  const at = (i: number) => center[Math.max(0, Math.min(center.length - 1, i))];
  for (let i = 0; i < center.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const steps = Math.max(1, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / spacing));
    for (let k = 0; k < steps; k++) {
      const t = k / steps,
        t2 = t * t,
        t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      pts.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  pts.push(center[center.length - 1]);
  const left: P[] = [],
    right: P[] = [];
  const clampEdge = (p: P, end: boolean): P => {
    if (!end) return p;
    const [x, y] = p;
    // keep the end of the river exactly on the map edge it leaves through
    const d = [x, mapW - x, y, mapH - y];
    const k = d.indexOf(Math.min(...d));
    return k === 0 ? [0, y] : k === 1 ? [mapW, y] : k === 2 ? [x, 0] : [x, mapH];
  };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)],
      b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b[0] - a[0],
      ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    const nx = -ty / l,
      ny = tx / l;
    const end = i === 0 || i === pts.length - 1;
    left.push(clampEdge([Math.round(pts[i][0] + (nx * width) / 2), Math.round(pts[i][1] + (ny * width) / 2)], end));
    right.push(clampEdge([Math.round(pts[i][0] - (nx * width) / 2), Math.round(pts[i][1] - (ny * width) / 2)], end));
  }
  return [...left, ...right.reverse()];
}
