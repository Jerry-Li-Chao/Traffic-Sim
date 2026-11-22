import * as THREE from 'three';
import { type Renderer, SUN_DIR } from './Renderer';
import { type World, type WSegment, crossSection } from '../world/World';
import type { NetGeometry, SegGeom } from '../world/geometry';
import { type Connector, type Turn, laneGeometry } from '../world/lanes';
import { type Polyline, type Vec2, offsetPolyline, offsetPolylineVar, subPolyline, polyCount, polyAt, makePolyline } from '../core/math';
import { getClass, TUNNEL_Z } from '../world/roads';
import { makeAsphaltTexture } from './textures';

// Colours
const C = {
  asphalt: new THREE.Color('#44474d'),
  asphaltHw: new THREE.Color('#3e4147'),
  shoulder: new THREE.Color('#4c4f55'),
  sidewalk: new THREE.Color('#b9b4a6'),
  curb: new THREE.Color('#d8d3c6'),
  white: new THREE.Color('#ecebe4'),
  yellow: new THREE.Color('#e3b440'),
  grass: new THREE.Color('#7f9353'),
  barrier: new THREE.Color('#cfcac0'),
  parapet: new THREE.Color('#dcd8cf'),
  concrete: new THREE.Color('#a9a59b'),
  trench: new THREE.Color('#5d5a50'),
  tunnel: new THREE.Color('#2b2d31'),
};

export type StopStyle = 'stop' | 'yield' | 'none';
export type StopStyleFn = (nodeId: number, segId: number) => StopStyle;
const defaultStopStyle: StopStyleFn = () => 'stop';

/** Accumulates triangles with per-vertex colours. */
class MeshBuilder {
  pos: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  private v(x: number, y: number, z: number, c: THREE.Color) {
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    this.uv.push(x / 7, y / 7);
    return this.pos.length / 3 - 1;
  }

  /** Strip between two offset polylines of the same vertex count. */
  ribbon(left: Polyline, right: Polyline, z: number[], zBias: number, c: THREE.Color) {
    const n = Math.min(polyCount(left), polyCount(right), z.length);
    if (n < 2) return;
    const base = this.pos.length / 3;
    for (let i = 0; i < n; i++) {
      this.v(left.pts[i * 2], left.pts[i * 2 + 1], z[i] + zBias, c);
      this.v(right.pts[i * 2], right.pts[i * 2 + 1], z[i] + zBias, c);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  /** Vertical wall hanging below a polyline (for bridge sides). */
  wall(line: Polyline, z: number[], depth: number, c: THREE.Color) {
    const n = Math.min(polyCount(line), z.length);
    const base = this.pos.length / 3;
    for (let i = 0; i < n; i++) {
      this.v(line.pts[i * 2], line.pts[i * 2 + 1], z[i], c);
      this.v(line.pts[i * 2], line.pts[i * 2 + 1], z[i] - depth, c);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      this.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  /** Triangle fan polygon at height z. */
  polygon(pts: Vec2[], _center: Vec2, z: number, c: THREE.Color) {
    if (pts.length < 3) return;
    // proper triangulation: junction outlines are not always star-shaped around the node
    const contour = pts.map((p) => new THREE.Vector2(p.x, p.y));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const base = this.pos.length / 3;
    for (const p of pts) this.v(p.x, p.y, z, c);
    for (const t of tris) this.idx.push(base + t[0], base + t[1], base + t[2]);
  }

  /** Polygon with its own height at every corner (e.g. a gore on a slope). */
  polygonZ(pts: Vec2[], zs: number[], c: THREE.Color) {
    if (pts.length < 3) return;
    const tris = THREE.ShapeUtils.triangulateShape(
      pts.map((p) => new THREE.Vector2(p.x, p.y)),
      [],
    );
    const base = this.pos.length / 3;
    pts.forEach((p, i) => this.v(p.x, p.y, zs[i], c));
    for (const t of tris) this.idx.push(base + t[0], base + t[1], base + t[2]);
  }

  quad(a: Vec2, b: Vec2, c2: Vec2, d: Vec2, z: number, c: THREE.Color) {
    const base = this.pos.length / 3;
    this.v(a.x, a.y, z, c);
    this.v(b.x, b.y, z, c);
    this.v(c2.x, c2.y, z, c);
    this.v(d.x, d.y, z, c);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  box(cx: number, cy: number, z0: number, z1: number, hx: number, hy: number, angle: number, c: THREE.Color) {
    const ca = Math.cos(angle),
      sa = Math.sin(angle);
    const corner = (sx: number, sy: number) => ({ x: cx + sx * hx * ca - sy * hy * sa, y: cy + sx * hx * sa + sy * hy * ca });
    const p = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    const base = this.pos.length / 3;
    for (const q of p) this.v(q.x, q.y, z0, c);
    for (const q of p) this.v(q.x, q.y, z1, c);
    const f = (a: number, b: number, c3: number, d: number) => this.idx.push(base + a, base + b, base + c3, base + a, base + c3, base + d);
    f(0, 1, 5, 4);
    f(1, 2, 6, 5);
    f(2, 3, 7, 6);
    f(3, 0, 4, 7);
    f(4, 5, 6, 7);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

/** Split a centre line into runs where predicate on z holds. Returns [startIdx, endIdx] inclusive. */
function runs(z: number[], pred: (z: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < z.length; i++) {
    const ok = pred(z[i]);
    if (ok && start < 0) start = Math.max(0, i - 1);
    if (!ok && start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, z.length - 1]);
  return out;
}

function slicePoly(p: Polyline, i0: number, i1: number): Polyline {
  return { pts: p.pts.slice(i0 * 2, i1 * 2 + 2), cum: p.cum.slice(i0, i1 + 1).map((c) => c - p.cum[i0]), length: p.cum[i1] - p.cum[i0] };
}

/** Dashed line: quads along `line` with dash/gap lengths. */
function dashes(mb: MeshBuilder, line: Polyline, z: number[], width: number, dash: number, gap: number, c: THREE.Color, zb: number) {
  const L = line.length;
  const sample = (s: number) => {
    // linear lookup
    let i = 0;
    while (i < line.cum.length - 2 && line.cum[i + 1] < s) i++;
    const seg = line.cum[i + 1] - line.cum[i] || 1;
    const t = Math.min(1, Math.max(0, (s - line.cum[i]) / seg));
    const x0 = line.pts[i * 2],
      y0 = line.pts[i * 2 + 1],
      x1 = line.pts[i * 2 + 2],
      y1 = line.pts[i * 2 + 3];
    const dl = Math.hypot(x1 - x0, y1 - y0) || 1;
    return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, nx: -(y1 - y0) / dl, ny: (x1 - x0) / dl, z: z[i] + (z[i + 1] - z[i]) * t };
  };
  const hw = width / 2;
  for (let s = gap / 2; s + dash <= L; s += dash + gap) {
    const a = sample(s),
      b = sample(s + dash);
    mb.quad(
      { x: a.x + a.nx * hw, y: a.y + a.ny * hw },
      { x: a.x - a.nx * hw, y: a.y - a.ny * hw },
      { x: b.x - b.nx * hw, y: b.y - b.ny * hw },
      { x: b.x + b.nx * hw, y: b.y + b.ny * hw },
      (a.z + b.z) / 2 + zb,
      c,
    );
  }
}

function solid(mb: MeshBuilder, center: Polyline, z: number[], off: number, width: number, c: THREE.Color, zb: number) {
  mb.ribbon(offsetPolyline(center, off + width / 2), offsetPolyline(center, off - width / 2), z, zb, c);
}

export class RoadLayer {
  group = new THREE.Group();
  private ground?: THREE.Mesh;
  private elevated?: THREE.Mesh;
  private tunnel?: THREE.Mesh;
  /** soft shade cast by cutting walls across the road below */
  private shade?: THREE.Mesh;
  private shadeMb: MeshBuilder | null = null;
  private matShade: THREE.MeshBasicMaterial;
  private matGround: THREE.MeshLambertMaterial;
  private matElevated: THREE.MeshLambertMaterial;
  private matTunnel: THREE.MeshBasicMaterial;

  constructor(r: Renderer) {
    const tex = makeAsphaltTexture();
    this.matGround = new THREE.MeshLambertMaterial({ vertexColors: true, map: tex, side: THREE.DoubleSide });
    this.matElevated = new THREE.MeshLambertMaterial({ vertexColors: true, map: tex, side: THREE.DoubleSide });
    this.matShade = new THREE.MeshBasicMaterial({ color: '#0b0d08', transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
    this.matTunnel = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
    r.world.add(this.group);
  }

  rebuild(world: World, geom: NetGeometry, connectors: Map<number, Connector[]> = new Map(), stopStyle: StopStyleFn = defaultStopStyle) {
    for (const m of [this.ground, this.elevated, this.tunnel, this.shade]) {
      if (m) {
        this.group.remove(m);
        m.geometry.dispose();
      }
    }
    const G = new MeshBuilder(),
      E = new MeshBuilder(),
      T = new MeshBuilder();
    this.shadeMb = new MeshBuilder();

    for (const g of geom.segs.values()) {
      const s = world.segments.get(g.id);
      if (!s) continue;
      const isTunnel = (z: number) => z <= TUNNEL_Z;
      for (const [i0, i1] of runs(g.z, (z) => !isTunnel(z))) {
        const center = slicePoly(g.center, i0, i1);
        const z = g.z.slice(i0, i1 + 1);
        const elevated = z.some((v) => v > 0.8);
        this.segmentSurface(elevated ? E : G, s.id, world, g, center, z, elevated);
      }
      for (const [i0, i1] of runs(g.z, isTunnel)) {
        const center = slicePoly(g.center, i0, i1);
        const z = g.z.slice(i0, i1 + 1);
        const hw = g.cs.carriage / 2 + 0.5;
        T.ribbon(offsetPolyline(center, hw), offsetPolyline(center, -hw), z, 0.1, C.tunnel);
        dashes(T, offsetPolyline(center, hw), z, 0.4, 4, 4, C.white, 0.15);
        dashes(T, offsetPolyline(center, -hw), z, 0.4, 4, 4, C.white, 0.15);
      }
    }

    // smooth bends at seamless joints
    for (const ng of geom.nodes.values()) {
      if (!ng.bend) continue;
      const base = world.segments.get(ng.bend.seg);
      if (!base) continue;
      const seg: WSegment = ng.bend.reversed ? { ...base, lanesF: base.lanesB, lanesB: base.lanesF } : base;
      const z = ng.bend.center.cum.map(() => ng.bend!.z);
      const g = { ...geom.segs.get(base.id)!, cs: crossSection(seg) };
      const mb = ng.z > 0.8 ? E : ng.z <= TUNNEL_Z ? T : G;
      if (mb === T) continue;
      this.segmentSurface(mb, base.id, world, g, ng.bend.center, z, ng.z > 0.8, seg);
    }

    // tapers where the number of lanes changes
    for (const ng of geom.nodes.values()) {
      if (!ng.taper) continue;
      const sa = world.segments.get(ng.taper.a.seg),
        sb = world.segments.get(ng.taper.b.seg);
      if (!sa || !sb) continue;
      const mb = ng.z > 0.8 ? E : ng.z <= TUNNEL_Z ? T : G;
      if (mb === T) continue;
      const oa = ng.taper.a.reversed ? { ...sa, lanesF: sa.lanesB, lanesB: sa.lanesF } : sa;
      const ob = ng.taper.b.reversed ? { ...sb, lanesF: sb.lanesB, lanesB: sb.lanesF } : sb;
      if (ng.merge) {
        // the joining road's gore sits just under the through road's surface
        const m = ng.merge;
        mb.polygonZ(m.gore, m.goreZ.map((z) => z + 0.115), m.highway || getClass(sa.cls).highway ? C.asphaltHw : C.asphalt);
        const [e0, e1] = m.edge;
        const dx = e1.x - e0.x,
          dy = e1.y - e0.y;
        const l = Math.hypot(dx, dy) || 1;
        const nx = (-dy / l) * 0.09,
          ny = (dx / l) * 0.09;
        const base = { pts: [e0.x, e0.y, e1.x, e1.y], cum: [0, l], length: l };
        mb.ribbon(
          { ...base, pts: [e0.x + nx, e0.y + ny, e1.x + nx, e1.y + ny] },
          { ...base, pts: [e0.x - nx, e0.y - ny, e1.x - nx, e1.y - ny] },
          [m.edgeZ[0], m.edgeZ[1]],
          0.17,
          C.white,
        );
      }
      this.taperSurface(mb, oa, ob, ng.taper.center, ng.z, ng.z > 0.8);
    }

    for (const ng of geom.nodes.values()) {
      if (!ng.junction || ng.taper || ng.polygon.length < 3) continue;
      const n = world.nodes.get(ng.id);
      if (!n) continue;
      const mb = ng.z > 0.8 ? E : ng.z <= TUNNEL_Z ? T : G;
      const cx = ng.polygon.reduce((a, p) => a + p.x, 0) / ng.polygon.length;
      const cy = ng.polygon.reduce((a, p) => a + p.y, 0) / ng.polygon.length;
      mb.polygon(ng.polygon, { x: n.x, y: n.y }, ng.z + 0.12, ng.z <= TUNNEL_Z ? C.tunnel : C.asphalt);
      void cx;
      void cy;
      if (ng.z > 0.8) this.pier(E, n.x, n.y, ng.z, 0);
    }

    for (const ng of geom.nodes.values()) {
      if (!ng.junction || ng.merge) continue;
      const mb = ng.z > 0.8 ? E : ng.z <= TUNNEL_Z ? null : G;
      if (!mb) continue;
      this.junctionMarkings(mb, world, geom, ng.id, connectors.get(ng.id) ?? [], stopStyle);
    }

    this.ground = new THREE.Mesh(G.build(), this.matGround);
    this.ground.receiveShadow = true;
    this.elevated = new THREE.Mesh(E.build(), this.matElevated);
    this.elevated.castShadow = true;
    this.elevated.receiveShadow = true;
    this.tunnel = new THREE.Mesh(T.build(), this.matTunnel);
    this.tunnel.renderOrder = 5;
    this.shade = new THREE.Mesh(this.shadeMb.build(), this.matShade);
    this.shade.renderOrder = 4;
    this.shadeMb = null;
    this.group.add(this.ground, this.elevated, this.tunnel, this.shade);
  }

  private junctionMarkings(mb: MeshBuilder, world: World, geom: NetGeometry, nodeId: number, conns: Connector[], stopStyle: StopStyleFn) {
    const ng = geom.nodes.get(nodeId)!;
    const z = ng.z;
    const big = ng.arms.length >= 3;
    // pedestrian crossings in the junction mouth
    if (big) {
      for (const a of ng.arms) {
        const s = world.seg(a.seg);
        const cls = getClass(s.cls);
        if (cls.sidewalk <= 0) continue;
        const g = geom.segs.get(a.seg)!;
        const half = g.cs.carriage / 2;
        const back = { x: -a.dir.x, y: -a.dir.y };
        const left = { x: -a.dir.y, y: a.dir.x };
        for (let off = -half + 0.6; off < half - 0.3; off += 1.1) {
          const c0 = { x: a.center.x + back.x * 0.6 + left.x * off, y: a.center.y + back.y * 0.6 + left.y * off };
          const c1 = { x: c0.x + back.x * 2.6, y: c0.y + back.y * 2.6 };
          const w = 0.28;
          mb.quad(
            { x: c0.x + left.x * w, y: c0.y + left.y * w },
            { x: c1.x + left.x * w, y: c1.y + left.y * w },
            { x: c1.x - left.x * w, y: c1.y - left.y * w },
            { x: c0.x - left.x * w, y: c0.y - left.y * w },
            z + 0.18,
            C.white,
          );
        }
      }
    }
    // stop lines + turn arrows per incoming lane
    const byLane = new Map<string, { turns: Set<Turn>; c: Connector }>();
    for (const c of conns) {
      if (c.direct) continue;
      const k = `${c.from.seg}:${c.from.dir}:${c.from.idx}`;
      if (!byLane.has(k)) byLane.set(k, { turns: new Set(), c });
      byLane.get(k)!.turns.add(c.turn);
    }
    for (const { turns, c } of byLane.values()) {
      const s = world.seg(c.from.seg);
      const cls = getClass(s.cls);
      const lg = laneGeometry(world, geom, c.from);
      const end = polyAt(lg.poly, lg.poly.length);
      const d = { x: end.tx, y: end.ty };
      const l = { x: -d.y, y: d.x };
      const hw = cls.laneWidth / 2 - 0.1;
      const style = big ? stopStyle(nodeId, c.from.seg) : 'none';
      if (style !== 'none') {
        if (style === 'stop') {
          const p0 = { x: end.x - d.x * 0.25, y: end.y - d.y * 0.25 };
          mb.quad(
            { x: p0.x + l.x * hw - d.x * 0.25, y: p0.y + l.y * hw - d.y * 0.25 },
            { x: p0.x + l.x * hw + d.x * 0.25, y: p0.y + l.y * hw + d.y * 0.25 },
            { x: p0.x - l.x * hw + d.x * 0.25, y: p0.y - l.y * hw + d.y * 0.25 },
            { x: p0.x - l.x * hw - d.x * 0.25, y: p0.y - l.y * hw - d.y * 0.25 },
            z + 0.19,
            C.white,
          );
        } else {
          // give-way: dashed line + triangle
          for (let o = -hw; o < hw - 0.3; o += 0.9) {
            const p = { x: end.x - d.x * 0.3 + l.x * (o + 0.3), y: end.y - d.y * 0.3 + l.y * (o + 0.3) };
            mb.quad(
              { x: p.x - l.x * 0.25 - d.x * 0.2, y: p.y - l.y * 0.25 - d.y * 0.2 },
              { x: p.x - l.x * 0.25 + d.x * 0.2, y: p.y - l.y * 0.25 + d.y * 0.2 },
              { x: p.x + l.x * 0.25 + d.x * 0.2, y: p.y + l.y * 0.25 + d.y * 0.2 },
              { x: p.x + l.x * 0.25 - d.x * 0.2, y: p.y + l.y * 0.25 - d.y * 0.2 },
              z + 0.19,
              C.white,
            );
          }
        }
      }
      if (big && lg.poly.length > 14) this.turnArrow(mb, polyAt(lg.poly, lg.poly.length - 7), turns, z + 0.19);
    }
  }

  private turnArrow(mb: MeshBuilder, p: { x: number; y: number; tx: number; ty: number }, turns: Set<Turn>, z: number) {
    const d = { x: p.tx, y: p.ty },
      l = { x: -p.ty, y: p.tx };
    const at = (u: number, v: number) => ({ x: p.x + d.x * u + l.x * v, y: p.y + d.y * u + l.y * v });
    const seg = (u0: number, v0: number, u1: number, v1: number, w: number) => {
      const a = at(u0, v0),
        b = at(u1, v1);
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const nx = (-dy / L) * w,
        ny = (dx / L) * w;
      mb.quad({ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }, z, C.white);
      // head
      const hx = dx / L,
        hy = dy / L;
      const tip = { x: b.x + hx * 1.1, y: b.y + hy * 1.1 };
      mb.quad({ x: b.x - hy * 0.55, y: b.y + hx * 0.55 }, tip, tip, { x: b.x + hy * 0.55, y: b.y - hx * 0.55 }, z, C.white);
    };
    mb.quad(at(-2.6, 0.13), at(0.2, 0.13), at(0.2, -0.13), at(-2.6, -0.13), z, C.white);
    if (turns.has('S')) seg(0.2, 0, 1.3, 0, 0.13);
    if (turns.has('L')) seg(0.1, 0, 0.9, 0.8, 0.13);
    if (turns.has('R')) seg(0.1, 0, 0.9, -0.8, 0.13);
  }

  private pier(mb: MeshBuilder, x: number, y: number, z: number, angle: number) {
    mb.box(x, y, 0, z - 0.8, 1.1, 1.1, angle, C.concrete);
  }

  /**
   * A piece of road whose cross-section blends from road `a` to road `b` (both oriented in the
   * direction of travel along `center`): edges, centre line and lane lines shift smoothly, and
   * lanes that end run out into the edge of the carriageway.
   */
  private taperSurface(mb: MeshBuilder, a: WSegment, b: WSegment, center: Polyline, zc: number, elevated: boolean) {
    const ca = getClass(a.cls),
      cb = getClass(b.cls);
    const xa = crossSection(a),
      xb = crossSection(b);
    const z = center.cum.map(() => zc);
    const ease = (u: number) => u * u * (3 - 2 * u);
    const lerp = (p: number, q: number) => (u: number) => p + (q - p) * ease(u);
    const off = (f: (u: number) => number) => offsetPolylineVar(center, f);

    const roadHalf = lerp(xa.carriage / 2 + ca.shoulder, xb.carriage / 2 + cb.shoulder);
    const outer = lerp(xa.width / 2, xb.width / 2);
    const carrHalf = lerp(xa.carriage / 2, xb.carriage / 2);
    const neg = (f: (u: number) => number) => (u: number) => -f(u);
    const hw = ca.highway || cb.highway;

    if (ca.sidewalk > 0 || cb.sidewalk > 0) {
      mb.ribbon(off(outer), off(roadHalf), z, 0.14, C.sidewalk);
      mb.ribbon(off(neg(roadHalf)), off(neg(outer)), z, 0.14, C.sidewalk);
      mb.ribbon(off((u) => roadHalf(u) + 0.3), off(roadHalf), z, 0.16, C.curb);
      mb.ribbon(off(neg(roadHalf)), off((u) => -roadHalf(u) - 0.3), z, 0.16, C.curb);
    }
    mb.ribbon(off(roadHalf), off(neg(roadHalf)), z, 0.12, hw ? C.asphaltHw : C.asphalt);

    // centre line / median, styled after the busier road
    const twoWay = a.lanesF > 0 && a.lanesB > 0 && b.lanesF > 0 && b.lanesB > 0;
    if (twoWay) {
      const big = a.lanesF + a.lanesB >= b.lanesF + b.lanesB ? ca : cb;
      const mo = lerp(xa.medianOffset, xb.medianOffset);
      const mw = lerp(xa.median, xb.median);
      if (big.medianKind === 'grass' || big.medianKind === 'barrier') {
        mb.ribbon(off((u) => mo(u) + mw(u) / 2), off((u) => mo(u) - mw(u) / 2), z, 0.15, big.medianKind === 'grass' ? C.grass : C.barrier);
      } else if (big.medianKind === 'paint') {
        mb.ribbon(off((u) => mo(u) + 0.255), off((u) => mo(u) + 0.105), z, 0.17, C.yellow);
        mb.ribbon(off((u) => mo(u) - 0.105), off((u) => mo(u) - 0.255), z, 0.17, C.yellow);
      } else {
        dashes(mb, off(mo), z, 0.15, 3, 5, C.white, 0.17);
      }
    }
    // edge lines
    if (ca.id !== 'lane' || cb.id !== 'lane') {
      mb.ribbon(off((u) => carrHalf(u) - 0.11), off((u) => carrHalf(u) - 0.29), z, 0.17, C.white);
      mb.ribbon(off((u) => -carrHalf(u) + 0.29), off((u) => -carrHalf(u) + 0.11), z, 0.17, C.white);
    }
    // lane separators: shared ones glide across; extra ones run out into the outer edge
    const [dash, gap] = hw ? [4.5, 8] : [3, 6];
    const sepF = (x: ReturnType<typeof crossSection>, i: number) => (x.fwdOffset(i) + x.fwdOffset(i - 1)) / 2;
    const sepB = (x: ReturnType<typeof crossSection>, j: number) => (x.bwdOffset(j) + x.bwdOffset(j - 1)) / 2;
    const sides: [number, number, (x: ReturnType<typeof crossSection>, i: number) => number, number][] = [
      [a.lanesF, b.lanesF, sepF, -1],
      [a.lanesB, b.lanesB, sepB, 1],
    ];
    for (const [na, nb, sep, side] of sides) {
      for (let i = 1; i < Math.max(na, nb); i++) {
        const pa = i < na ? sep(xa, i) : side * (xa.carriage / 2);
        const pb = i < nb ? sep(xb, i) : side * (xb.carriage / 2);
        const f = lerp(pa, pb);
        if (i < na && i < nb) {
          dashes(mb, off(f), z, 0.16, dash, gap, C.white, 0.17);
          continue;
        }
        // a lane that opens (or closes) here: mark it only where it is at least half open
        const [u0, u1] = i < na ? [0, 0.5] : [0.5, 1];
        const part = subPolyline(center, u0 * center.length, u1 * center.length);
        const line = offsetPolylineVar(part, (u) => f(u0 + (u1 - u0) * u));
        dashes(mb, line, line.cum.map(() => zc), 0.16, dash, gap, C.white, 0.17);
      }
    }
    if (elevated) {
      mb.ribbon(off((u) => outer(u) + 0.5), off(outer), z.map((v) => v + 0.5), 0, C.parapet);
      mb.ribbon(off(neg(outer)), off((u) => -outer(u) - 0.5), z.map((v) => v + 0.5), 0, C.parapet);
      mb.wall(off((u) => outer(u) + 0.5), z.map((v) => v + 0.5), 1.6, C.concrete);
      mb.wall(off((u) => -outer(u) - 0.5), z.map((v) => v + 0.5), 1.6, C.concrete);
    }
  }

  /**
   * The cutting wall on the sun's side throws a shadow across the road (towards the bottom
   * right): as wide as the wall is deep, stretched by how low the sun is and how squarely the
   * wall faces it.
   */
  private cuttingShade(mb: MeshBuilder, center: Polyline, z: number[], half: number) {
    const n = Math.min(polyCount(center), z.length);
    if (n < 2) return;
    const sx = SUN_DIR.x,
      sy = SUN_DIR.y,
      sz = SUN_DIR.z;
    for (const side of [1, -1]) {
      const edge: Vec2[] = [],
        inner: Vec2[] = [],
        zs: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1),
          b = Math.min(n - 1, i + 1);
        const tx = center.pts[b * 2] - center.pts[a * 2],
          ty = center.pts[b * 2 + 1] - center.pts[a * 2 + 1];
        const tl = Math.hypot(tx, ty) || 1;
        // outward normal of this side's wall
        const nx = (-ty / tl) * side,
          ny = (tx / tl) * side;
        const facing = nx * sx + ny * sy; // > 0: the wall stands between the road and the sun
        const depth = Math.max(0, 0.2 - z[i]);
        const len = facing > 0 ? Math.min(half * 2 - 0.5, (depth * facing) / sz) : 0;
        const cx = center.pts[i * 2],
          cy = center.pts[i * 2 + 1];
        edge.push({ x: cx + nx * half, y: cy + ny * half });
        inner.push({ x: cx + nx * (half - len), y: cy + ny * (half - len) });
        zs.push(z[i] + 0.22);
      }
      mb.ribbon(makePolyline(edge), makePolyline(inner), zs, 0, C.white);
    }
  }

  private segmentSurface(mb: MeshBuilder, segId: number, world: World, g: SegGeom, center: Polyline, z: number[], elevated: boolean, override?: WSegment) {
    const s = override ?? world.seg(segId);
    const cls = getClass(s.cls);
    const cs = g.cs;
    const half = cs.width / 2;
    const carriageHalf = cs.carriage / 2;
    const roadHalf = carriageHalf + cls.shoulder;
    const asphalt = cls.highway ? C.asphaltHw : C.asphalt;
    const cut = z.some((v) => v < -1);

    // sidewalks / verges
    if (cls.sidewalk > 0) {
      mb.ribbon(offsetPolyline(center, half), offsetPolyline(center, roadHalf), z, 0.14, C.sidewalk);
      mb.ribbon(offsetPolyline(center, -roadHalf), offsetPolyline(center, -half), z, 0.14, C.sidewalk);
      solid(mb, center, z, roadHalf + 0.15, 0.3, C.curb, 0.16);
      solid(mb, center, z, -roadHalf - 0.15, 0.3, C.curb, 0.16);
    }
    // asphalt
    mb.ribbon(offsetPolyline(center, roadHalf), offsetPolyline(center, -roadHalf), z, 0.12, asphalt);

    // median
    const isTwoWay = s.lanesF > 0 && s.lanesB > 0;
    if (isTwoWay) {
      const mo = cs.medianOffset;
      if (cls.medianKind === 'grass' && cs.median > 0) {
        mb.ribbon(offsetPolyline(center, mo + cs.median / 2 - 0.3), offsetPolyline(center, mo - cs.median / 2 + 0.3), z, 0.15, C.grass);
        solid(mb, center, z, mo + cs.median / 2 - 0.15, 0.3, C.curb, 0.16);
        solid(mb, center, z, mo - cs.median / 2 + 0.15, 0.3, C.curb, 0.16);
      } else if (cls.medianKind === 'barrier' && cs.median > 0) {
        solid(mb, center, z, mo, 0.8, C.barrier, 0.2);
        solid(mb, center, z, mo + cs.median / 2 - 0.3, 0.2, C.white, 0.17);
        solid(mb, center, z, mo - cs.median / 2 + 0.3, 0.2, C.white, 0.17);
      } else if (cls.medianKind === 'paint') {
        solid(mb, center, z, mo + 0.18, 0.15, C.yellow, 0.17);
        solid(mb, center, z, mo - 0.18, 0.15, C.yellow, 0.17);
      } else {
        dashes(mb, offsetPolyline(center, mo), z, 0.15, 3, 5, C.white, 0.17);
      }
    }
    // edge lines
    if (cls.id !== 'lane') {
      solid(mb, center, z, carriageHalf - 0.2, 0.18, C.white, 0.17);
      solid(mb, center, z, -carriageHalf + 0.2, 0.18, C.white, 0.17);
    }
    // lane separators
    const [dash, gap] = cls.highway ? [4.5, 8] : [3, 6];
    for (let i = 1; i < s.lanesF; i++) {
      const off = (cs.fwdOffset(i) + cs.fwdOffset(i - 1)) / 2;
      dashes(mb, offsetPolyline(center, off), z, 0.16, dash, gap, C.white, 0.17);
    }
    for (let j = 1; j < s.lanesB; j++) {
      const off = (cs.bwdOffset(j) + cs.bwdOffset(j - 1)) / 2;
      dashes(mb, offsetPolyline(center, off), z, 0.16, dash, gap, C.white, 0.17);
    }

    if (elevated) {
      // parapets + side walls + piers
      solid(mb, center, z, half + 0.25, 0.5, C.parapet, 0.5);
      solid(mb, center, z, -half - 0.25, 0.5, C.parapet, 0.5);
      mb.wall(offsetPolyline(center, half + 0.5), z.map((v) => v + 0.5), 1.6, C.concrete);
      mb.wall(offsetPolyline(center, -half - 0.5), z.map((v) => v + 0.5), 1.6, C.concrete);
      const spacing = 28;
      for (let d = spacing / 2; d < center.length; d += spacing) {
        let i = 0;
        while (i < center.cum.length - 2 && center.cum[i + 1] < d) i++;
        const zz = z[i];
        if (zz < 2.5) continue;
        const x = center.pts[i * 2],
          y = center.pts[i * 2 + 1];
        const ang = Math.atan2(center.pts[i * 2 + 3] - y, center.pts[i * 2 + 2] - x);
        mb.box(x, y, 0, zz - 1, 1.0, Math.max(1.2, half * 0.55), ang, C.concrete);
      }
    } else if (cut) {
      // retaining wall tops for cuttings
      const zt = z.map((v) => (v < -1 ? 0.2 : v + 0.2));
      solid(mb, center, zt, half + 0.6, 1.2, C.concrete, 0);
      solid(mb, center, zt, -half - 0.6, 1.2, C.concrete, 0);
      solid(mb, center, z, half - 0.6, 1.2, C.trench, 0.18);
      if (this.shadeMb) this.cuttingShade(this.shadeMb, center, z, half);
    }
  }
}
