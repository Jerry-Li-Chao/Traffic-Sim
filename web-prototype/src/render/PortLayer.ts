import * as THREE from 'three';
import { type Renderer, SUN_DIR } from './Renderer';
import type { PortRuntime } from '../game/loadLevel';

/** A painted metal name plate: the town's colour, a white keyline, a little sheen and bevel. */
function plateTexture(text: string, color: string, town: boolean): { tex: THREE.Texture; aspect: number } {
  const k = 4; // texture pixels per CSS-ish pixel
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d')!;
  const font = `700 ${15 * k}px Inter, -apple-system, Segoe UI, sans-serif`;
  g.font = font;
  const icon = town ? 14 * k : 0;
  const w = Math.ceil(g.measureText(text).width + icon + 22 * k);
  const h = 28 * k;
  canvas.width = w;
  canvas.height = h;
  const r = 4 * k;
  const base = new THREE.Color(color);
  const hex = (c: THREE.Color) => '#' + c.getHexString();
  // body: light at the top edge, darker below (brushed metal)
  const body = g.createLinearGradient(0, 0, 0, h);
  body.addColorStop(0, hex(base.clone().lerp(new THREE.Color('#ffffff'), 0.22)));
  body.addColorStop(0.45, hex(base));
  body.addColorStop(1, hex(base.clone().multiplyScalar(0.72)));
  g.fillStyle = body;
  g.beginPath();
  g.roundRect(0, 0, w, h, r);
  g.fill();
  // dark rim
  g.lineWidth = 1.2 * k;
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.stroke();
  // sheen across the top half
  const sheen = g.createLinearGradient(0, 0, w, h);
  sheen.addColorStop(0, 'rgba(255,255,255,0.18)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0.04)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.beginPath();
  g.roundRect(k, k, w - 2 * k, h / 2, r);
  g.fill();
  // white keyline
  g.lineWidth = 1.4 * k;
  g.strokeStyle = 'rgba(255,255,255,0.92)';
  g.beginPath();
  g.roundRect(3 * k, 3 * k, w - 6 * k, h - 6 * k, 2.5 * k);
  g.stroke();
  // destination pin for towns inside the site
  let x = 11 * k;
  if (town) {
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(x + 4.5 * k, h / 2 - 1.5 * k, 3.6 * k, Math.PI, 0);
    g.lineTo(x + 4.5 * k, h / 2 + 5 * k);
    g.closePath();
    g.fill();
    g.fillStyle = hex(base);
    g.beginPath();
    g.arc(x + 4.5 * k, h / 2 - 1.5 * k, 1.4 * k, 0, Math.PI * 2);
    g.fill();
    x += icon;
  }
  // embossed lettering
  g.font = font;
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillText(text, x, h / 2 + 1.2 * k);
  g.fillStyle = '#ffffff';
  g.fillText(text, x, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, aspect: w / h };
}

interface Board {
  mesh: THREE.Mesh;
  /** soft shadow the plate throws on the ground */
  shadow: THREE.Mesh;
  post: THREE.Mesh;
  /** point beside the road the plate stands next to, and the side it stands on */
  base: { x: number; y: number };
  side: { x: number; y: number };
  w: number;
  h: number;
}

/** Name plates on posts beside the roads into the site; one per town even if it has two carriageways. */
export class PortLayer {
  group = new THREE.Group();
  private boards: Board[] = [];
  private map = { w: 0, h: 0 };
  private scale = 1;

  constructor(r: Renderer) {
    r.world.add(this.group);
  }

  set(ports: PortRuntime[], mapW: number, mapH: number) {
    for (const b of this.boards) {
      this.group.remove(b.mesh, b.post, b.shadow);
      b.mesh.geometry.dispose();
      b.shadow.geometry.dispose();
      b.post.geometry.dispose();
      (b.mesh.material as THREE.MeshBasicMaterial).map?.dispose();
    }
    this.boards = [];
    this.map = { w: mapW, h: mapH };
    // a town's in and out carriageways share one plate
    const groups: PortRuntime[][] = [];
    for (const p of ports) {
      const g = groups.find((g) => g[0].name === p.name && g[0].kind === p.kind && Math.hypot(g[0].x - p.x, g[0].y - p.y) < 150);
      if (g) g.push(p);
      else groups.push([p]);
    }
    for (const g of groups) {
      const p = g[0];
      const { tex, aspect } = plateTexture(p.name, p.color, p.kind === 'town');
      const h = 6.5;
      const w = h * aspect;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
      mesh.renderOrder = 40;
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: '#000000', map: tex, transparent: true, opacity: 0.3, depthWrite: false }));
      shadow.renderOrder = 3;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1, 0.5), new THREE.MeshLambertMaterial({ color: '#4a4f55' }));
      post.castShadow = true;
      this.group.add(shadow, mesh, post);
      // stand beside the stub a little way into the map, outside all of the town's carriageways
      const dx = Math.cos(p.dir),
        dy = Math.sin(p.dir);
      const bases = g.map((q) => ({ x: q.x + dx * 26, y: q.y + dy * 26 }));
      const pick = (side: { x: number; y: number }) => bases.reduce((a, b) => (b.x * side.x + b.y * side.y > a.x * side.x + a.y * side.y ? b : a));
      let side = { x: -dy, y: dx };
      let base = pick(side);
      const probe = { x: base.x + side.x * (w + 30), y: base.y + side.y * (w + 30) };
      if (probe.x < 0 || probe.y < 0 || probe.x > mapW || probe.y > mapH) {
        side = { x: dy, y: -dx };
        base = pick(side);
      }
      this.boards.push({ mesh, shadow, post, base, side, w, h });
    }
    this.place();
  }

  /** Keep plates readable when zoomed far out; they grow away from the road, never over it. */
  update(mpp: number) {
    const s = Math.max(1, mpp / 0.4);
    if (Math.abs(s - this.scale) < 1e-3) return;
    this.scale = s;
    this.place();
  }

  private place() {
    const s = this.scale;
    for (const b of this.boards) {
      b.mesh.scale.set(s, s, 1);
      // half the plate's extent across the road, plus a clear gap past the road's edge
      const half = ((Math.abs(b.side.x) * b.w + Math.abs(b.side.y) * b.h) / 2) * s;
      const off = 9 + 3 * s + half;
      let x = b.base.x + b.side.x * off,
        y = b.base.y + b.side.y * off;
      const hw = (b.w * s) / 2 + 2,
        hh = (b.h * s) / 2 + 2;
      x = Math.min(this.map.w - hw, Math.max(hw, x));
      y = Math.min(this.map.h - hh, Math.max(hh, y));
      const z = 6 + 2 * s;
      b.mesh.position.set(x, y, z);
      b.shadow.scale.set(s, s, 1);
      b.shadow.position.set(x - (SUN_DIR.x / SUN_DIR.z) * z, y - (SUN_DIR.y / SUN_DIR.z) * z, 0.25);
      // a post from the ground up to the bottom edge of the plate
      const pz = z - 0.2;
      b.post.scale.set(Math.min(2, s * 0.6), Math.min(2, s * 0.6), pz);
      b.post.position.set(x, y - (b.h * s) / 2 + 0.3 * s, pz / 2);
    }
  }
}
