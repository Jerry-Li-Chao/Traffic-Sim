import * as THREE from 'three';
import { CameraModel } from './camera';
import { makeGrassTexture, valueNoise2D } from './textures';
import { Rng } from '../core/rng';

export interface MapInfo {
  width: number;
  height: number;
  seed: number;
  treeDensity: number; // trees per 1000 m²
}

export interface RenderLayer {
  /** called every animation frame */
  update?(dt: number, r: Renderer): void;
}

export const SUN_DIR = new THREE.Vector3(-0.62, 0.72, 0.7).normalize();

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
  readonly cam = new CameraModel();
  readonly sun: THREE.DirectionalLight;
  readonly world = new THREE.Group();
  ground?: THREE.Mesh;
  trees?: THREE.InstancedMesh;
  treeData: { x: number; y: number; r: number }[] = [];
  map: MapInfo = { width: 1000, height: 800, seed: 1, treeDensity: 4 };
  private layers: RenderLayer[] = [];
  private last = performance.now();
  private raf = 0;
  fps = 60;
  shadowsEnabled = true;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color('#5f6b4a');
    this.scene.add(this.world);

    this.camera.up.set(0, 1, 0);
    const hemi = new THREE.HemisphereLight('#f4f1e6', '#5d6a48', 1.5);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight('#fff6e2', 1.7);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
  }

  addLayer(l: RenderLayer) {
    this.layers.push(l);
  }

  resize() {
    const w = this.canvas.clientWidth,
      h = this.canvas.clientHeight;
    this.gl.setSize(w, h, false);
    this.cam.setViewport(w, h);
  }

  setMap(info: MapInfo) {
    this.map = info;
    const m = 150;
    this.cam.bounds = { minX: -m, minY: -m, maxX: info.width + m, maxY: info.height + m };
    this.buildGround();
    this.buildTrees();
    this.resize();
    this.cam.fit({ minX: 0, minY: 0, maxX: info.width, maxY: info.height });
  }

  private buildGround() {
    if (this.ground) {
      this.world.remove(this.ground);
      this.ground.geometry.dispose();
    }
    const { width, height, seed } = this.map;
    const pad = 400;
    const W = width + pad * 2,
      H = height + pad * 2;
    const seg = 96;
    const geo = new THREE.PlaneGeometry(W, H, seg, Math.round((seg * H) / W));
    const noise = valueNoise2D(seed);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const green = new THREE.Color('#8a9a5b'),
      dry = new THREE.Color('#b3ac78'),
      dark = new THREE.Color('#6f8148'),
      out = new THREE.Color('#77805c');
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + width / 2,
        y = pos.getY(i) + height / 2;
      const n = noise(x / 260, y / 260);
      const n2 = noise(x / 70 + 50, y / 70 + 50);
      c.copy(green).lerp(dry, Math.max(0, Math.min(1, (n - 0.42) * 2.6)));
      c.lerp(dark, Math.max(0, n2 - 0.6) * 1.5);
      const inside = x >= 0 && y >= 0 && x <= width && y <= height;
      if (!inside) c.lerp(out, 0.55);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const tex = makeGrassTexture(seed);
    tex.repeat.set(W / 48, H / 48);
    const mat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.position.set(width / 2, height / 2, 0);
    this.ground.receiveShadow = true;
    this.ground.renderOrder = -10;
    // Ground never occludes roads in cuttings/tunnels: no depth write.
    mat.depthWrite = false;
    this.world.add(this.ground);
  }

  private buildTrees() {
    if (this.trees) {
      this.world.remove(this.trees);
      this.trees.geometry.dispose();
    }
    const { width, height, seed, treeDensity } = this.map;
    const rng = new Rng(seed * 31 + 5);
    const noise = valueNoise2D(seed + 99);
    const pad = 250;
    const area = (width + pad * 2) * (height + pad * 2);
    const target = Math.floor((area / 1000) * treeDensity);
    this.treeData = [];
    for (let i = 0; i < target * 2 && this.treeData.length < target; i++) {
      const x = -pad + rng.next() * (width + pad * 2);
      const y = -pad + rng.next() * (height + pad * 2);
      const n = noise(x / 180 + 7, y / 180 + 3);
      if (rng.next() > n * 1.4 - 0.05) continue; // clumpy distribution
      this.treeData.push({ x, y, r: 1.4 + rng.next() * 2.6 });
    }
    const geo = new THREE.IcosahedronGeometry(1, 1);
    geo.scale(1, 1, 0.75);
    const mat = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, this.treeData.length));
    mesh.castShadow = true;
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    const palette = ['#4f6b33', '#5c7a3a', '#42602f', '#6a8540', '#56713a'];
    this.treeData.forEach((t, i) => {
      m.makeScale(t.r, t.r, t.r);
      m.setPosition(t.x, t.y, t.r * 0.8);
      mesh.setMatrixAt(i, m);
      col.set(palette[i % palette.length]).offsetHSL(0, 0, (rng.next() - 0.5) * 0.06);
      mesh.setColorAt(i, col);
    });
    mesh.count = this.treeData.length;
    mesh.instanceMatrix.needsUpdate = true;
    this.trees = mesh;
    this.world.add(mesh);
  }

  /** Hide trees for which `blocked(x,y,r)` returns true (e.g. under roads). */
  updateTreeVisibility(blocked: (x: number, y: number, r: number) => boolean) {
    if (!this.trees) return;
    const m = new THREE.Matrix4();
    this.treeData.forEach((t, i) => {
      const s = blocked(t.x, t.y, t.r) ? 0 : t.r;
      m.makeScale(s, s, s);
      m.setPosition(t.x, t.y, t.r * 0.8);
      this.trees!.setMatrixAt(i, m);
    });
    this.trees.instanceMatrix.needsUpdate = true;
  }

  private syncCamera() {
    const cam = this.cam;
    const v = cam.view();
    this.camera.left = v.minX - cam.cx;
    this.camera.right = v.maxX - cam.cx;
    this.camera.top = v.maxY - cam.cy;
    this.camera.bottom = v.minY - cam.cy;
    this.camera.position.set(cam.cx, cam.cy, 1000);
    this.camera.lookAt(cam.cx, cam.cy, 0);
    this.camera.updateProjectionMatrix();

    // Fit the shadow frustum to the visible area.
    const ext = Math.max(v.maxX - v.minX, v.maxY - v.minY) * 0.75 + 40;
    const sc = this.sun.shadow.camera;
    sc.left = -ext;
    sc.right = ext;
    sc.top = ext;
    sc.bottom = -ext;
    sc.near = 1;
    sc.far = 1200;
    sc.updateProjectionMatrix();
    this.sun.target.position.set(cam.cx, cam.cy, 0);
    this.sun.position.set(cam.cx + SUN_DIR.x * 500, cam.cy + SUN_DIR.y * 500, SUN_DIR.z * 500);
    this.gl.shadowMap.enabled = this.shadowsEnabled && cam.mpp < 2.5;
  }

  start() {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (dt > 0) this.fps = this.fps * 0.95 + (1 / dt) * 0.05;
    const w = this.canvas.clientWidth,
      h = this.canvas.clientHeight;
    if (w !== this.cam.width || h !== this.cam.height) this.resize();
    for (const l of this.layers) l.update?.(dt, this);
    this.syncCamera();
    this.gl.render(this.scene, this.camera);
  }

  setQuality(hiDpi: boolean) {
    this.gl.setPixelRatio(hiDpi ? Math.min(window.devicePixelRatio, 2) : 1);
    this.resize();
  }

  dispose() {
    this.stop();
    this.gl.dispose();
  }
}
