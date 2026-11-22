// Railway geometry helpers: double-track polylines and crossings with roads.
import { type Polyline, makePolyline, offsetPolyline, reversePolyline, polyIntersections } from '../core/math';
import type { RailLine, World } from './World';
import { levelZ } from './roads';

export const TRACK_OFFSET = 2.3; // metres from the line centre to each track
export const RAIL_CORRIDOR = 5.5; // half width of the ballast bed

export function railCenter(line: RailLine): Polyline {
  return makePolyline(line.pts.map(([x, y]) => ({ x, y })));
}

/** Track polylines: [0] runs along the line direction (right-hand), [1] runs the other way. */
export function railTracks(line: RailLine): [Polyline, Polyline] {
  const c = railCenter(line);
  return [offsetPolyline(c, -TRACK_OFFSET), reversePolyline(offsetPolyline(c, TRACK_OFFSET))];
}

export interface RailHit {
  rail: number;
  /** arc length along the road centre polyline */
  along: number;
  x: number;
  y: number;
  z: number;
  /** cosine of the crossing angle (1 = parallel) */
  cos: number;
}

/** Where a road polyline crosses rail lines at the same height (level crossings). */
export function railHits(world: World, poly: Polyline, zAt: (along: number) => number): { same: RailHit[]; clash: boolean } {
  const same: RailHit[] = [];
  let clash = false;
  for (const line of world.rails) {
    const c = railCenter(line);
    const zr = levelZ(line.level);
    for (const h of polyIntersections(poly, c)) {
      const z = zAt(h.sa);
      const dz = Math.abs(z - zr);
      if (dz >= 5.5) continue; // bridge or tunnel
      if (dz > 0.4) {
        clash = true;
        continue;
      }
      // crossing angle
      const i = Math.max(0, poly.cum.findIndex((v) => v >= h.sa) - 1);
      const tx = poly.pts[i * 2 + 2] - poly.pts[i * 2],
        ty = poly.pts[i * 2 + 3] - poly.pts[i * 2 + 1];
      const j = Math.max(0, c.cum.findIndex((v) => v >= h.sb) - 1);
      const rx = c.pts[j * 2 + 2] - c.pts[j * 2],
        ry = c.pts[j * 2 + 3] - c.pts[j * 2 + 1];
      const cos = Math.abs(tx * rx + ty * ry) / (Math.hypot(tx, ty) * Math.hypot(rx, ry) || 1);
      same.push({ rail: line.id, along: h.sa, x: h.x, y: h.y, z, cos });
    }
  }
  return { same, clash };
}
