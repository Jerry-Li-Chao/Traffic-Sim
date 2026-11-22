import * as THREE from 'three';
import { Rng } from '../core/rng';

/** Fine grass speckle texture, tiled across the ground. */
export function makeGrassTexture(seed = 7): THREE.Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  const rng = new Rng(seed);
  for (let i = 0; i < 9000; i++) {
    const x = rng.next() * size,
      y = rng.next() * size;
    const r = 0.6 + rng.next() * 1.6;
    const v = 200 + Math.floor(rng.next() * 55);
    g.fillStyle = `rgba(${v - 30},${v},${v - 60},${0.25 + rng.next() * 0.35})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // light dry flecks
  for (let i = 0; i < 1600; i++) {
    const x = rng.next() * size,
      y = rng.next() * size;
    g.fillStyle = `rgba(255,250,225,${0.25 + rng.next() * 0.3})`;
    g.fillRect(x, y, 1 + rng.next() * 2, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Subtle asphalt grain. */
export function makeAsphaltTexture(seed = 3): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  const rng = new Rng(seed);
  for (let i = 0; i < 6000; i++) {
    const v = 215 + Math.floor(rng.next() * 40);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(rng.next() * size, rng.next() * size, 1, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Smooth value noise in [0,1] for large-scale ground variation. */
export function valueNoise2D(seed: number) {
  const rng = new Rng(seed);
  const perm = new Float32Array(256 * 256);
  for (let i = 0; i < perm.length; i++) perm[i] = rng.next();
  const at = (ix: number, iy: number) => perm[(((ix % 256) + 256) % 256) * 256 + (((iy % 256) + 256) % 256)];
  const fade = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number) => {
    const ix = Math.floor(x),
      iy = Math.floor(y);
    const fx = fade(x - ix),
      fy = fade(y - iy);
    const a = at(ix, iy),
      b = at(ix + 1, iy),
      c = at(ix, iy + 1),
      d = at(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  return (x: number, y: number) =>
    noise(x, y) * 0.55 + noise(x * 2.1 + 17, y * 2.1 + 9) * 0.3 + noise(x * 4.3 + 3, y * 4.3 + 41) * 0.15;
}
