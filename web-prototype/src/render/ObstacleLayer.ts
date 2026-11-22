import * as THREE from 'three';
import type { Renderer } from './Renderer';
import type { Obstacle } from '../world/World';
import { Rng } from '../core/rng';
import { pointInPolygon } from '../core/math';

/** Rivers and built-up areas drawn on the ground. */
export class ObstacleLayer {
  private group = new THREE.Group();
  private waterMats: THREE.MeshLambertMaterial[] = [];
  private size = { w: 1000, h: 1000 };
  private time = 0;
  constructor(r: Renderer) {
    r.world.add(this.group);
    r.addLayer(this);
  }

  /** Animate the water. */
  update(dt: number) {
    this.time += dt;
    for (const m of this.waterMats) {
      const u = m.userData.uniforms as { uTime: { value: number } } | undefined;
      if (u) u.uTime.value = this.time;
    }
  }

  set(obstacles: Obstacle[], mapW = this.size.w, mapH = this.size.h) {
    this.size = { w: mapW, h: mapH };
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    for (const m of this.waterMats) m.dispose();
    this.waterMats = [];
    for (const o of obstacles) {
      const shape = new THREE.Shape(o.pts.map(([x, y]) => new THREE.Vector2(x, y)));
      if (o.kind === 'water') {
        const water = makeWater(o.pts, this.size.w, this.size.h, this.waterMats.length);
        this.waterMats.push(water.material as THREE.MeshLambertMaterial);
        this.group.add(water);
      } else {
        const ground = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshLambertMaterial({ color: '#a7a397', depthWrite: false }));
        ground.position.z = 0.02;
        ground.receiveShadow = true;
        ground.renderOrder = -5;
        this.group.add(ground);
        // little houses
        const rng = new Rng(o.pts.length * 977 + Math.round(o.pts[0][0]));
        const poly = o.pts.map(([x, y]) => ({ x, y }));
        const xs = o.pts.map((p) => p[0]),
          ys = o.pts.map((p) => p[1]);
        const geo = new THREE.BoxGeometry(1, 1, 1);
        geo.translate(0, 0, 0.5);
        const houses = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: '#ffffff' }), 400);
        houses.castShadow = true;
        let n = 0;
        const m = new THREE.Matrix4();
        const roofs = ['#b5543c', '#8d6e63', '#c9a26b', '#6d7b8d', '#a14b3c'];
        for (let i = 0; i < 2000 && n < 400; i++) {
          const x = Math.min(...xs) + rng.next() * (Math.max(...xs) - Math.min(...xs));
          const y = Math.min(...ys) + rng.next() * (Math.max(...ys) - Math.min(...ys));
          if (!pointInPolygon({ x, y }, poly)) continue;
          const w = 8 + rng.next() * 10,
            d = 7 + rng.next() * 8,
            h = 5 + rng.next() * 7;
          m.compose(new THREE.Vector3(x, y, 0), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.round(rng.next() * 4) * (Math.PI / 2) + 0.05), new THREE.Vector3(w, d, h));
          houses.setMatrixAt(n, m);
          houses.setColorAt(n, new THREE.Color(roofs[n % roofs.length]));
          n++;
        }
        houses.count = n;
        this.group.add(houses);
      }
    }
  }

  /** Hide trees inside obstacles. */
  blocks(obstacles: Obstacle[]) {
    const polys = obstacles.map((o) => o.pts.map(([x, y]) => ({ x, y })));
    return (x: number, y: number) => polys.some((p) => pointInPolygon({ x, y }, p));
  }
}

const MAX_PTS = 128;

/**
 * A river or lake surface: sandy shore, a foam line that laps at the bank, shallows that deepen
 * towards the middle, and ripples drifting downstream that catch the sun. Lit by the scene, so
 * bridges cast their shadows onto it.
 */
function makeWater(pts: [number, number][], mapW: number, mapH: number, seed: number): THREE.Mesh {
  // Where the outline runs along the edge of the site the water carries on past it: push those
  // points out under the surrounding land and don't draw a shore there.
  const PAD = 400,
    eps = 1;
  const onEdge = (p: [number, number]) => p[0] <= eps || p[1] <= eps || p[0] >= mapW - eps || p[1] >= mapH - eps;
  const out = pts.map(([x, y]): [number, number] => [x <= eps ? -PAD : x >= mapW - eps ? mapW + PAD : x, y <= eps ? -PAD : y >= mapH - eps ? mapH + PAD : y]);
  const n = Math.min(MAX_PTS, out.length);
  const ptsU = Array.from({ length: MAX_PTS }, (_, i) => new THREE.Vector2(...(out[Math.min(i, n - 1)] as [number, number])));
  const shore = Array.from({ length: MAX_PTS }, (_, i) => (i < n && !(onEdge(pts[i]) && onEdge(pts[(i + 1) % n])) ? 1 : 0));
  // downstream direction: along the long axis of the water
  const xs = out.map((p) => p[0]),
    ys = out.map((p) => p[1]);
  const flow = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys) ? new THREE.Vector2(1, 0.08) : new THREE.Vector2(0.08, -1);

  const shape = new THREE.Shape(out.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ShapeGeometry(shape);
  const mat = new THREE.MeshLambertMaterial({ color: '#ffffff', depthWrite: false });
  const uniforms = {
    uTime: { value: 0 },
    uPts: { value: ptsU },
    uShore: { value: shore },
    uCount: { value: n },
    uFlow: { value: flow.normalize() },
    uSeed: { value: seed * 17.3 },
    uSun: { value: new THREE.Vector3(-0.62, 0.72, 0.7).normalize() },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWorldXY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorldXY = (modelMatrix * vec4(transformed, 1.0)).xy;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec2 vWorldXY;
uniform float uTime;
uniform vec2 uPts[${MAX_PTS}];
uniform float uShore[${MAX_PTS}];
uniform int uCount;
uniform vec2 uFlow;
uniform float uSeed;
uniform vec3 uSun;
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float wFbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * wNoise(p); p = p * 2.03 + vec2(17.0, 9.0); a *= 0.5; }
  return v;
}
/** distance to the nearest shore */
float shoreDist(vec2 p) {
  float d = 1e9;
  for (int i = 0; i < ${MAX_PTS}; i++) {
    if (i >= uCount) break;
    if (uShore[i] < 0.5) continue;
    vec2 a = uPts[i];
    vec2 b = uPts[i + 1 < uCount ? i + 1 : 0];
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    d = min(d, length(p - a - ab * t));
  }
  return d;
}
/** water surface height field (for ripples) drifting downstream */
float wHeight(vec2 p) {
  vec2 drift = uFlow * uTime * 1.6;
  vec2 side = vec2(-uFlow.y, uFlow.x);
  float h = wFbm((p - drift) * 0.06);
  h += 0.45 * wFbm((p - drift * 1.7 + side * uTime * 0.4) * 0.15);
  return h;
}`,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `float sd = shoreDist(vWorldXY);
  // wobble the shoreline a little so it isn't ruler straight
  sd += (wNoise(vWorldXY * 0.12) - 0.5) * 2.2;
  vec3 sand = vec3(0.80, 0.73, 0.55);
  vec3 wetSand = vec3(0.60, 0.56, 0.43);
  vec3 shallow = vec3(0.33, 0.62, 0.63);
  vec3 deep = vec3(0.13, 0.33, 0.45);
  float depth = smoothstep(5.0, 70.0, sd);
  vec3 col = mix(shallow, deep, depth);
  // ripples: shade by the slope of the surface
  float e = 0.8;
  float h0 = wHeight(vWorldXY);
  vec2 grad = vec2(wHeight(vWorldXY + vec2(e, 0.0)) - h0, wHeight(vWorldXY + vec2(0.0, e)) - h0) / e;
  vec3 nrm = normalize(vec3(-grad * 6.0, 1.0));
  col *= 0.9 + 0.25 * dot(nrm, normalize(vec3(uSun.xy, 1.2)));
  // lapping foam just off the shore
  float lap = 0.5 + 0.5 * sin(uTime * 1.3 - sd * 0.9 + wNoise(vWorldXY * 0.3) * 4.0);
  float foam = smoothstep(7.5, 4.5, sd) * smoothstep(0.35, 0.9, lap * wNoise(vWorldXY * 0.5 + uTime * 0.2) + 0.25);
  col = mix(col, vec3(0.93, 0.96, 0.95), foam * 0.75);
  // shore: dry sand, then wet sand
  col = mix(col, wetSand, smoothstep(4.8, 3.6, sd));
  col = mix(col, sand, smoothstep(2.6, 1.2, sd));
  vec4 diffuseColor = vec4( col, opacity );
  // sun glints on the ripples
  vec3 refl = reflect(-uSun, nrm);
  // (fade out when zoomed out, where they would only shimmer)
  float px = fwidth(vWorldXY.x);
  float glint = pow(max(refl.z, 0.0), 70.0) * smoothstep(4.5, 9.0, sd) * smoothstep(0.7, 0.25, px);`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vec3(1.0, 0.97, 0.88) * glint * 0.45;');
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.z = 0.03;
  mesh.receiveShadow = true;
  mesh.renderOrder = -5;
  return mesh;
}
