import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Renderer } from './Renderer';
import type { SimClient } from '../game/SimClient';
import { VEH_STRIDE, TRAIN_STRIDE, type Snapshot } from '../sim/protocol';
import { VEH_COLORS } from '../sim/Sim';

function carGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(1, 1, 0.42);
  body.translate(0, 0, 0.32);
  const cabin = new THREE.BoxGeometry(0.52, 0.84, 0.34);
  cabin.translate(-0.06, 0, 0.7);
  const tint = (g: THREE.BufferGeometry, v: number) => {
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3).fill(v);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  };
  tint(body, 1);
  tint(cabin, 0.62);
  return mergeGeometries([body, cabin])!;
}

function truckGeometry(): THREE.BufferGeometry {
  const cab = new THREE.BoxGeometry(0.2, 1, 0.75);
  cab.translate(0.4, 0, 0.42);
  const box = new THREE.BoxGeometry(0.76, 1, 0.95);
  box.translate(-0.11, 0, 0.55);
  const tint = (g: THREE.BufferGeometry, v: number) => {
    const n = g.attributes.position.count;
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(v), 3));
  };
  tint(cab, 0.7);
  tint(box, 1);
  return mergeGeometries([cab, box])!;
}

/** Instanced cars/trucks + trains, interpolated between sim snapshots. */
export class VehicleLayer {
  private cars: THREE.InstancedMesh;
  private trucks: THREE.InstancedMesh;
  private trains: THREE.InstancedMesh;
  private capacity = 0;
  private trainCap = 0;
  private colors = VEH_COLORS.map((c) => new THREE.Color(c));
  private prevIndex = new Map<number, number>();
  private prevSnapRef: unknown = null;
  visible = true;

  constructor(
    private r: Renderer,
    private sim: SimClient,
  ) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.cars = new THREE.InstancedMesh(carGeometry(), mat, 1);
    this.trucks = new THREE.InstancedMesh(truckGeometry(), mat, 1);
    const trainGeo = new THREE.BoxGeometry(1, 1, 1);
    trainGeo.translate(0, 0, 0.5);
    this.trains = new THREE.InstancedMesh(trainGeo, new THREE.MeshLambertMaterial({ color: '#c8ccd2' }), 1);
    for (const m of [this.cars, this.trucks, this.trains]) {
      m.castShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      r.world.add(m);
    }
    this.ensure(512);
  }

  private ensure(n: number) {
    if (n <= this.capacity) return;
    const cap = Math.max(n, this.capacity * 2, 512);
    for (const key of ['cars', 'trucks'] as const) {
      const old = this[key];
      const m = new THREE.InstancedMesh(old.geometry, old.material, cap);
      m.castShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      m.setColorAt(0, new THREE.Color());
      this.r.world.remove(old);
      this.r.world.add(m);
      this[key] = m;
    }
    this.capacity = cap;
  }

  private ensureTrains(n: number) {
    if (n <= this.trainCap) return;
    const cap = Math.max(n, 64);
    const old = this.trains;
    const m = new THREE.InstancedMesh(old.geometry, old.material, cap);
    m.castShadow = true;
    m.frustumCulled = false;
    this.r.world.remove(old);
    this.r.world.add(m);
    this.trains = m;
    this.trainCap = cap;
  }

  private prevTrainRef: Snapshot | null = null;
  private prevTrainIndex = new Map<number, number>();

  update() {
    const pr = this.sim.pair();
    if (!pr) {
      this.cars.count = this.trucks.count = this.trains.count = 0;
      return;
    }
    const curr = pr.b;
    const prev = pr.a === pr.b ? null : pr.a;
    if (this.prevSnapRef !== prev) {
      this.prevSnapRef = prev;
      this.prevIndex.clear();
      if (prev) for (let i = 0; i < prev.vehicleCount; i++) this.prevIndex.set(prev.ids[i], i);
    }
    const alpha = pr.alpha;
    const n = curr.vehicleCount;
    this.ensure(n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const axis = new THREE.Vector3(0, 0, 1);
    const red = new THREE.Color('#ff3b2f');
    const col = new THREE.Color();
    let nc = 0,
      nt = 0;
    const cv = curr.vehicles;
    for (let i = 0; i < n; i++) {
      const o = i * VEH_STRIDE;
      let x = cv[o],
        y = cv[o + 1],
        z = cv[o + 2],
        h = cv[o + 3];
      const pi = prev ? this.prevIndex.get(curr.ids[i]) : undefined;
      if (prev && pi !== undefined) {
        const po = pi * VEH_STRIDE;
        const px = prev.vehicles[po],
          py = prev.vehicles[po + 1];
        if (Math.hypot(px - x, py - y) < 40) {
          x = px + (x - px) * alpha;
          y = py + (y - py) * alpha;
          z = prev.vehicles[po + 2] + (z - prev.vehicles[po + 2]) * alpha;
          let dh = h - prev.vehicles[po + 3];
          while (dh > Math.PI) dh -= Math.PI * 2;
          while (dh < -Math.PI) dh += Math.PI * 2;
          h = prev.vehicles[po + 3] + dh * alpha;
        }
      }
      const flags = cv[o + 7];
      const truck = (flags & 4) !== 0;
      const hidden = (flags & 8) !== 0 || !this.visible;
      const len = cv[o + 4],
        wid = cv[o + 5];
      pos.set(x, y, z + 0.12);
      q.setFromAxisAngle(axis, h);
      const height = truck ? 3.3 : 1.55;
      if (hidden) sc.set(0.0001, 0.0001, 0.0001);
      else sc.set(len, wid, height);
      m.compose(pos, q, sc);
      col.copy(this.colors[cv[o + 6] % this.colors.length]);
      if (flags & 2) col.lerp(red, 0.55);
      if (truck) {
        this.trucks.setMatrixAt(nt, m);
        this.trucks.setColorAt(nt, col);
        nt++;
      } else {
        this.cars.setMatrixAt(nc, m);
        this.cars.setColorAt(nc, col);
        nc++;
      }
    }
    this.cars.count = nc;
    this.trucks.count = nt;
    for (const mm of [this.cars, this.trucks]) {
      mm.instanceMatrix.needsUpdate = true;
      if (mm.instanceColor) mm.instanceColor.needsUpdate = true;
    }
    // trains, smoothed between snapshots like the cars
    const tn = curr.trainCount;
    this.ensureTrains(tn);
    if (this.prevTrainRef !== prev) {
      this.prevTrainRef = prev;
      this.prevTrainIndex.clear();
      if (prev?.trainIds) for (let i = 0; i < prev.trainCount; i++) this.prevTrainIndex.set(prev.trainIds[i], i);
    }
    const tv = curr.trains;
    for (let i = 0; i < tn; i++) {
      const o = i * TRAIN_STRIDE;
      let x = tv[o],
        y = tv[o + 1],
        h = tv[o + 3];
      const pi = prev && curr.trainIds ? this.prevTrainIndex.get(curr.trainIds[i]) : undefined;
      if (prev && pi !== undefined) {
        const po = pi * TRAIN_STRIDE;
        const px = prev.trains[po],
          py = prev.trains[po + 1];
        if (Math.hypot(px - x, py - y) < 60) {
          x = px + (x - px) * alpha;
          y = py + (y - py) * alpha;
          let dh = h - prev.trains[po + 3];
          while (dh > Math.PI) dh -= Math.PI * 2;
          while (dh < -Math.PI) dh += Math.PI * 2;
          h = prev.trains[po + 3] + dh * alpha;
        }
      }
      pos.set(x, y, tv[o + 2] + 0.2);
      q.setFromAxisAngle(axis, h);
      sc.set(tv[o + 4], 3.1, 3.6);
      m.compose(pos, q, sc);
      this.trains.setMatrixAt(i, m);
    }
    this.trains.count = tn;
    this.trains.instanceMatrix.needsUpdate = true;
  }

  /** Nearest vehicle id to a world point (current snapshot). */
  pick(x: number, y: number, radius = 4): number | null {
    const c = this.sim.curr;
    if (!c) return null;
    let best: number | null = null,
      bd = radius;
    for (let i = 0; i < c.vehicleCount; i++) {
      const o = i * VEH_STRIDE;
      const d = Math.hypot(c.vehicles[o] - x, c.vehicles[o + 1] - y);
      if (d < bd) {
        bd = d;
        best = c.ids[i];
      }
    }
    return best;
  }
}
