import * as THREE from 'three';
import type { Renderer } from './Renderer';
import { type Polyline, type Vec2, offsetPolyline, polyCount } from '../core/math';

export interface OverlayRibbon {
  line: Polyline;
  z?: number[];
  halfWidth: number;
  color: string;
  opacity?: number;
}

export interface OverlayMarker {
  pos: Vec2;
  z?: number;
  radius: number;
  color: string;
  ring?: boolean;
  opacity?: number;
}

export interface OverlayArrow {
  from: Vec2;
  to: Vec2;
  color: string;
  width?: number;
  z?: number;
}

/** Transient visuals drawn on top of the world (ghosts, highlights, markers). */
export class OverlayLayer {
  group = new THREE.Group();
  private channels = new Map<string, THREE.Object3D[]>();

  constructor(r: Renderer) {
    this.group.renderOrder = 50;
    r.world.add(this.group);
  }

  clear(channel: string) {
    for (const o of this.channels.get(channel) ?? []) {
      this.group.remove(o);
      (o as THREE.Mesh).geometry?.dispose();
      ((o as THREE.Mesh).material as THREE.Material)?.dispose();
    }
    this.channels.delete(channel);
  }

  private add(channel: string, o: THREE.Object3D) {
    if (!this.channels.has(channel)) this.channels.set(channel, []);
    this.channels.get(channel)!.push(o);
    o.renderOrder = 60;
    this.group.add(o);
  }

  private mat(color: string, opacity = 0.55) {
    return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  }

  ribbons(channel: string, items: OverlayRibbon[]) {
    this.clear(channel);
    for (const it of items) {
      const l = offsetPolyline(it.line, it.halfWidth),
        r = offsetPolyline(it.line, -it.halfWidth);
      const n = Math.min(polyCount(l), polyCount(r));
      if (n < 2) continue;
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i < n; i++) {
        const z = (it.z?.[Math.min(i, (it.z?.length ?? 1) - 1)] ?? 0) + 1;
        pos.push(l.pts[i * 2], l.pts[i * 2 + 1], z, r.pts[i * 2], r.pts[i * 2 + 1], z);
        if (i < n - 1) {
          const a = i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      this.add(channel, new THREE.Mesh(g, this.mat(it.color, it.opacity ?? 0.5)));
    }
  }

  markers(channel: string, items: OverlayMarker[]) {
    this.clear(channel);
    for (const m of items) {
      const g = m.ring ? new THREE.RingGeometry(m.radius * 0.75, m.radius, 32) : new THREE.CircleGeometry(m.radius, 32);
      const mesh = new THREE.Mesh(g, this.mat(m.color, m.opacity ?? 0.85));
      mesh.position.set(m.pos.x, m.pos.y, (m.z ?? 0) + 1.5);
      this.add(channel, mesh);
    }
  }

  arrows(channel: string, items: OverlayArrow[]) {
    this.clear(channel);
    for (const a of items) {
      const dx = a.to.x - a.from.x,
        dy = a.to.y - a.from.y;
      const L = Math.hypot(dx, dy);
      if (L < 0.1) continue;
      const w = a.width ?? 0.6;
      const head = Math.min(3, L * 0.4);
      const shape = new THREE.Shape();
      shape.moveTo(0, -w / 2);
      shape.lineTo(L - head, -w / 2);
      shape.lineTo(L - head, -w * 1.8);
      shape.lineTo(L, 0);
      shape.lineTo(L - head, w * 1.8);
      shape.lineTo(L - head, w / 2);
      shape.lineTo(0, w / 2);
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), this.mat(a.color, 0.9));
      mesh.position.set(a.from.x, a.from.y, (a.z ?? 0) + 1.6);
      mesh.rotation.z = Math.atan2(dy, dx);
      this.add(channel, mesh);
    }
  }

  /** Many arrows merged into one mesh (direction markers across the whole network). */
  arrowField(channel: string, items: OverlayArrow[]) {
    this.clear(channel);
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    for (const a of items) {
      const dx = a.to.x - a.from.x,
        dy = a.to.y - a.from.y;
      const L = Math.hypot(dx, dy);
      if (L < 0.1) continue;
      const ux = dx / L,
        uy = dy / L;
      const nx = -uy,
        ny = ux;
      const w = (a.width ?? 0.6) / 2;
      const head = Math.min(3, L * 0.45);
      const z = (a.z ?? 0) + 1.5;
      const P = (s: number, o: number) => [a.from.x + ux * s + nx * o, a.from.y + uy * s + ny * o, z];
      const tri = (p: number[][]) => {
        for (const q of p) pos.push(...q);
        c.set(a.color);
        for (let i = 0; i < 3; i++) col.push(c.r, c.g, c.b);
      };
      tri([P(0, -w), P(L - head, -w), P(L - head, w)]);
      tri([P(0, -w), P(L - head, w), P(0, w)]);
      tri([P(L - head, -w * 3.4), P(L, 0), P(L - head, w * 3.4)]);
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.add(channel, new THREE.Mesh(g, m));
  }

  /** Show or hide a channel without rebuilding it. */
  setVisible(channel: string, visible: boolean) {
    for (const o of this.channels.get(channel) ?? []) o.visible = visible;
  }

  /** Many coloured ribbons merged into a single mesh (heat maps). */
  heat(channel: string, items: { pts: number[]; z: number; halfWidth: number; color: THREE.Color }[]) {
    this.clear(channel);
    const pos: number[] = [],
      col: number[] = [],
      idx: number[] = [];
    for (const it of items) {
      const n = it.pts.length / 2;
      if (n < 2) continue;
      const base = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1),
          b = Math.min(n - 1, i + 1);
        const dx = it.pts[b * 2] - it.pts[a * 2],
          dy = it.pts[b * 2 + 1] - it.pts[a * 2 + 1];
        const L = Math.hypot(dx, dy) || 1;
        const nx = (-dy / L) * it.halfWidth,
          ny = (dx / L) * it.halfWidth;
        const x = it.pts[i * 2],
          y = it.pts[i * 2 + 1];
        pos.push(x + nx, y + ny, it.z + 0.9, x - nx, y - ny, it.z + 0.9);
        col.push(it.color.r, it.color.g, it.color.b, it.color.r, it.color.g, it.color.b);
        if (i < n - 1) {
          const k = base + i * 2;
          idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.add(channel, new THREE.Mesh(g, mat));
  }

  /** Arbitrary polylines drawn as thin ribbons (curved connector previews). */
  lines(channel: string, items: { line: Polyline; color: string; width: number; z?: number; opacity?: number }[]) {
    this.ribbons(
      channel,
      items.map((i) => ({ line: i.line, halfWidth: i.width / 2, color: i.color, z: [i.z ?? 0], opacity: i.opacity ?? 0.9 })),
    );
  }
}
