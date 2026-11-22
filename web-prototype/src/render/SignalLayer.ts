import * as THREE from 'three';
import type { Renderer } from './Renderer';
import type { SimClient } from '../game/SimClient';
import type { World } from '../world/World';
import type { NetGeometry } from '../world/geometry';
import { approaches } from '../world/lanes';
import { signalPhases } from '../world/control';

const COLORS = [new THREE.Color('#e5372b'), new THREE.Color('#f2b51d'), new THREE.Color('#2fcf62')];

/** Traffic signal heads at the stop line of every signalised approach. */
export class SignalLayer {
  private mesh: THREE.InstancedMesh;
  private heads: { node: number; arm: number }[] = [];
  private poles: THREE.InstancedMesh;

  constructor(
    private r: Renderer,
    private sim: SimClient,
  ) {
    const g = new THREE.CylinderGeometry(0.9, 0.9, 0.5, 16);
    g.rotateX(Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: '#ffffff' }), 1);
    this.mesh.count = 0;
    this.mesh.renderOrder = 30;
    const pg = new THREE.BoxGeometry(1, 1, 1);
    this.poles = new THREE.InstancedMesh(pg, new THREE.MeshLambertMaterial({ color: '#3a3d42' }), 1);
    this.poles.count = 0;
    this.poles.castShadow = true;
    r.world.add(this.mesh, this.poles);
  }

  rebuild(world: World, geom: NetGeometry) {
    const items: { node: number; arm: number; x: number; y: number; z: number; ang: number }[] = [];
    for (const n of world.nodes.values()) {
      if (n.control !== 'signal') continue;
      const ng = geom.nodes.get(n.id);
      if (!ng || ng.arms.length < 3) continue;
      const apps = approaches(world, n.id);
      const phased = new Set(signalPhases(world, n.id).flat());
      ng.arms.forEach((a, armIdx) => {
        const app = apps.find((x) => x.seg === a.seg);
        if (!app || app.inLanes === 0 || !phased.has(a.seg)) return;
        // incoming lanes sit on the arm's left side (looking away from the node)
        const x = a.left.x + a.dir.x * 1.5 - a.dir.y * 1.2;
        const y = a.left.y + a.dir.y * 1.5 + a.dir.x * 1.2;
        items.push({ node: n.id, arm: armIdx, x, y, z: ng.z, ang: Math.atan2(a.dir.y, a.dir.x) });
      });
    }
    this.heads = items.map((i) => ({ node: i.node, arm: i.arm }));
    const cap = Math.max(1, items.length);
    for (const key of ['mesh', 'poles'] as const) {
      const old = this[key];
      const m = new THREE.InstancedMesh(old.geometry, old.material, cap);
      m.renderOrder = old.renderOrder;
      m.castShadow = old.castShadow;
      this.r.world.remove(old);
      this.r.world.add(m);
      this[key] = m;
    }
    const mat = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    items.forEach((it, i) => {
      mat.compose(new THREE.Vector3(it.x, it.y, it.z + 6), q, new THREE.Vector3(1, 1, 1));
      this.mesh.setMatrixAt(i, mat);
      this.mesh.setColorAt(i, COLORS[0]);
      q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), it.ang);
      mat.compose(new THREE.Vector3(it.x, it.y, it.z + 3), q, new THREE.Vector3(0.35, 0.35, 6));
      this.poles.setMatrixAt(i, mat);
      q.identity();
    });
    this.mesh.count = this.poles.count = items.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.poles.instanceMatrix.needsUpdate = true;
  }

  update() {
    const snap = this.sim.curr;
    if (!snap || this.heads.length === 0) return;
    const state = new Map<string, number>();
    const s = snap.signals;
    for (let i = 0; i < s.length; i += 3) state.set(`${s[i]}:${s[i + 1]}`, s[i + 2]);
    this.heads.forEach((h, i) => this.mesh.setColorAt(i, COLORS[state.get(`${h.node}:${h.arm}`) ?? 0]));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
