import * as THREE from 'three';
import type { Renderer } from './Renderer';
import type { SimClient } from '../game/SimClient';
import type { World } from '../world/World';
import type { NetGeometry, SegGeom } from '../world/geometry';
import type { SimInput } from '../sim/types';
import { railCenter, railTracks, RAIL_CORRIDOR } from '../world/rail';
import { offsetPolyline, polyAt, closestOnPolyline, type Polyline } from '../core/math';
import { levelZ } from '../world/roads';

const BALLAST = new THREE.Color('#9b9283');
const SLEEPER = new THREE.Color('#5b4a3a');
const RAIL = new THREE.Color('#d6d8dc');

/** Railway tracks + level crossing barriers. */
export class RailLayer {
  private group = new THREE.Group();
  private static?: THREE.Mesh;
  private barriers: THREE.InstancedMesh;
  private lights: THREE.InstancedMesh;
  private barrierInfo: { id: number }[] = [];
  private t = 0;

  constructor(
    r: Renderer,
    private sim: SimClient,
  ) {
    r.world.add(this.group);
    const bar = new THREE.BoxGeometry(1, 1, 1);
    this.barriers = new THREE.InstancedMesh(bar, new THREE.MeshLambertMaterial({ color: '#ffffff' }), 1);
    this.lights = new THREE.InstancedMesh(new THREE.CircleGeometry(0.8, 16), new THREE.MeshBasicMaterial({ color: '#ffffff' }), 1);
    this.barriers.count = this.lights.count = 0;
    this.group.add(this.barriers, this.lights);
  }

  rebuild(world: World, geom: NetGeometry, input: SimInput | null) {
    if (this.static) {
      this.group.remove(this.static);
      this.static.geometry.dispose();
    }
    const pos: number[] = [],
      col: number[] = [],
      idx: number[] = [];
    const quad = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }, z: number, color: THREE.Color) => {
      const base = pos.length / 3;
      for (const p of [a, b, c, d]) {
        pos.push(p.x, p.y, z);
        col.push(color.r, color.g, color.b);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const ribbon = (line: Polyline, half: number, z: number, color: THREE.Color) => {
      const l = offsetPolyline(line, half),
        r = offsetPolyline(line, -half);
      const n = Math.min(l.pts.length, r.pts.length) / 2;
      for (let i = 0; i < n - 1; i++) {
        quad(
          { x: l.pts[i * 2], y: l.pts[i * 2 + 1] },
          { x: r.pts[i * 2], y: r.pts[i * 2 + 1] },
          { x: r.pts[i * 2 + 2], y: r.pts[i * 2 + 3] },
          { x: l.pts[i * 2 + 2], y: l.pts[i * 2 + 3] },
          z,
          color,
        );
      }
    };
    for (const line of world.rails) {
      const z = levelZ(line.level);
      const c = railCenter(line);
      ribbon(c, RAIL_CORRIDOR, z + 0.04, BALLAST);
      for (const t of railTracks(line)) {
        // sleepers
        for (let s = 0; s < t.length; s += 1.2) {
          const p = polyAt(t, s);
          const nx = -p.ty,
            ny = p.tx;
          const w = 1.4,
            d = 0.22;
          quad(
            { x: p.x + nx * w - p.tx * d, y: p.y + ny * w - p.ty * d },
            { x: p.x + nx * w + p.tx * d, y: p.y + ny * w + p.ty * d },
            { x: p.x - nx * w + p.tx * d, y: p.y - ny * w + p.ty * d },
            { x: p.x - nx * w - p.tx * d, y: p.y - ny * w - p.ty * d },
            z + 0.08,
            SLEEPER,
          );
        }
        // rails are drawn above road surfaces so they show through level crossings
        ribbon(offsetPolyline(t, 0.75), 0.09, z + 0.24, RAIL);
        ribbon(offsetPolyline(t, -0.75), 0.09, z + 0.24, RAIL);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.static = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.static.receiveShadow = true;
    this.group.add(this.static);

    // barriers: one per crossing id and side of the line
    const items: { id: number; x: number; y: number; z: number; ang: number; len: number }[] = [];
    const lights: { id: number; x: number; y: number; z: number }[] = [];
    const seen = new Set<number>();
    for (const c of input?.rail.crossings ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const line = world.rails.find((l) => input!.rail.edges[c.edge].key.startsWith(`R:${l.id}:`));
      if (!line) continue;
      const center = railCenter(line);
      const onRail = closestOnPolyline(center, c);
      const rp = polyAt(center, onRail.s);
      // nearest road segment through this point
      let best: { g: SegGeom; s: number; d: number } | null = null;
      for (const sg of geom.segs.values()) {
        const h = closestOnPolyline(sg.full, rp);
        if (!best || h.d < best.d) best = { g: sg, s: h.s, d: h.d };
      }
      if (!best || best.d > 12) continue;
      const roadP = polyAt(best.g.full, best.s);
      const half = best.g.cs.carriage / 2 + 0.3;
      const z = levelZ(line.level);
      for (const side of [1, -1]) {
        // a half-barrier on each side of the track bed, covering the lanes that approach it
        const off = (RAIL_CORRIDOR + 1.5) * side;
        const cx = roadP.x + roadP.tx * off,
          cy = roadP.y + roadP.ty * off;
        const nx = -roadP.ty,
          ny = roadP.tx;
        // traffic approaching from this side drives on its right: offset towards that half of the road
        const sx = cx + nx * (half / 2) * side,
          sy = cy + ny * (half / 2) * side;
        items.push({ id: c.id, x: sx, y: sy, z, ang: Math.atan2(ny, nx), len: half });
        lights.push({ id: c.id, x: cx + nx * (half + 1.2) * side, y: cy + ny * (half + 1.2) * side, z });
      }
    }
    this.barrierInfo = items.map((i) => ({ id: i.id }));
    for (const key of ['barriers', 'lights'] as const) {
      const old = this[key];
      const m = new THREE.InstancedMesh(old.geometry, old.material, Math.max(1, key === 'barriers' ? items.length : lights.length));
      this.group.remove(old);
      this.group.add(m);
      this[key] = m;
    }
    const mat = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    items.forEach((it, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), it.ang);
      mat.compose(new THREE.Vector3(it.x, it.y, it.z + 1.1), q, new THREE.Vector3(it.len, 0.35, 0.35));
      this.barriers.setMatrixAt(i, mat);
      this.barriers.setColorAt(i, new THREE.Color('#d33'));
    });
    lights.forEach((l, i) => {
      mat.compose(new THREE.Vector3(l.x, l.y, l.z + 3), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
      this.lights.setMatrixAt(i, mat);
      this.lights.setColorAt(i, new THREE.Color('#333'));
    });
    this.barriers.count = items.length;
    this.lights.count = lights.length;
    this.barriers.castShadow = true;
    this.lightIds = lights.map((l) => l.id);
    this.barrierMats = items.map((it) => ({ ...it }));
  }

  private lightIds: number[] = [];
  private barrierMats: { x: number; y: number; z: number; ang: number; len: number }[] = [];

  update(dt: number) {
    const snap = this.sim.curr;
    if (!snap || !this.barrierInfo.length) return;
    this.t += dt;
    const closed = snap.crossings;
    const mat = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const axis = new THREE.Vector3(0, 0, 1);
    this.barrierInfo.forEach((b, i) => {
      const it = this.barrierMats[i];
      const down = closed[b.id] === 1;
      q.setFromAxisAngle(axis, it.ang);
      // raised barriers shrink to a short stub at the post
      const len = down ? it.len : 1.2;
      const shift = down ? 0 : (it.len - 1.2) / 2;
      mat.compose(new THREE.Vector3(it.x + Math.cos(it.ang) * shift, it.y + Math.sin(it.ang) * shift, it.z + 1.1), q, new THREE.Vector3(len, 0.35, down ? 0.35 : 2.5));
      this.barriers.setMatrixAt(i, mat);
    });
    this.barriers.instanceMatrix.needsUpdate = true;
    const blink = Math.floor(this.t * 2) % 2 === 0;
    this.lightIds.forEach((id, i) => this.lights.setColorAt(i, new THREE.Color(closed[id] === 1 ? ((i % 2 === 0) === blink ? '#ff3b2f' : '#4a1410') : '#333333')));
    if (this.lights.instanceColor) this.lights.instanceColor.needsUpdate = true;
  }
}
