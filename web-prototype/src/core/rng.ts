// Deterministic seeded PRNG (mulberry32). The simulation must never use Math.random.

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  get state() {
    return this.s;
  }
  set state(v: number) {
    this.s = v >>> 0;
  }
  /** float in [0, 1) */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number) {
    return lo + (hi - lo) * this.next();
  }
  int(lo: number, hiExclusive: number) {
    return lo + Math.floor(this.next() * (hiExclusive - lo));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** Exponential inter-arrival time for a Poisson process of `ratePerSec`. */
  exp(ratePerSec: number) {
    return -Math.log(1 - this.next()) / ratePerSec;
  }
}

/** Stable 32-bit hash for strings (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
