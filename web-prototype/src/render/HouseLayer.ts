import * as THREE from 'three';
import type { Renderer } from './Renderer';
import type { World } from '../world/World';
import { HOUSE_SIZE, houseCentre } from '../world/houses';

const WALLS = ['#e9dfc8', '#d8c3a5', '#c9d3c0', '#e3cfc0', '#cfd6dd'];
const ROOFS = ['#9c4a3c', '#6d5b4e', '#7a3f35', '#5a6470'];

/** Player-built houses: a body with a hip roof, facing away from the road. */
export class HouseLayer {
  group = new THREE.Group();
  private body = new THREE.BoxGeometry(1, 1, 1);
  private roof: THREE.BufferGeometry;

  constructor(r: Renderer) {
    // a four-sided pyramid with a square base, used as a hip roof
    this.roof = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
    this.roof.rotateY(Math.PI / 4);
    this.roof.rotateX(Math.PI / 2);
    r.world.add(this.group);
  }

  rebuild(world: World) {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      ((c as THREE.Mesh).material as THREE.Material).dispose();
    }
    for (const n of world.nodes.values()) {
      if (!n.house) continue;
      const c = houseCentre(n);
      const { w, d, h } = HOUSE_SIZE;
      const rot = n.house.angle + Math.PI / 2;
      const body = new THREE.Mesh(this.body, new THREE.MeshLambertMaterial({ color: WALLS[n.id % WALLS.length] }));
      body.scale.set(w, d, h);
      body.position.set(c.x, c.y, h / 2);
      body.rotation.z = rot;
      const roof = new THREE.Mesh(this.roof, new THREE.MeshLambertMaterial({ color: ROOFS[n.id % ROOFS.length] }));
      roof.scale.set(w + 1, d + 1, 3);
      roof.position.set(c.x, c.y, h + 1.5);
      roof.rotation.z = rot;
      for (const m of [body, roof]) {
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
      }
    }
  }
}
