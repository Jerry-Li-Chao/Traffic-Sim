import { TIME_SCALE, type FromWorker, type Snapshot, type ToWorker } from '../sim/protocol';
import type { SimInput } from '../sim/types';

/** Main-thread handle to the simulation worker. Keeps the last two snapshots for interpolation. */
export class SimClient {
  private worker: Worker;
  prev: Snapshot | null = null;
  curr: Snapshot | null = null;
  /** performance.now() when `curr` arrived */
  currAt = 0;
  interval = 33;
  /** recent snapshots (oldest first) for time-based interpolation */
  private buffer: Snapshot[] = [];
  /** simulation time currently being displayed (trails the newest snapshot slightly) */
  renderTime = 0;
  onSnapshot?: (s: Snapshot) => void;
  onError?: (msg: string, recovered: boolean) => void;

  constructor() {
    this.worker = new Worker(new URL('../sim/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'snapshot') {
        const now = performance.now();
        if (this.curr) this.interval = this.interval * 0.8 + Math.min(200, now - this.currAt) * 0.2;
        this.prev = this.curr;
        this.curr = m.snap;
        this.currAt = now;
        const last = this.buffer[this.buffer.length - 1];
        // a jump back in time (reset / reload) or a big jump forward (fast-forward) restarts the buffer
        if (!last || m.snap.time < last.time || m.snap.time - last.time > 5) {
          this.buffer = [];
          this.renderTime = m.snap.time;
        }
        this.buffer.push(m.snap);
        if (this.buffer.length > 8) this.buffer.shift();
        this.onSnapshot?.(m.snap);
      } else if (m.type === 'error') {
        console.error('[sim]', m.message);
        this.onError?.(m.message, !!m.recovered);
      }
    };
  }

  private send(m: ToWorker) {
    this.worker.postMessage(m);
  }

  load(input: SimInput) {
    this.prev = this.curr = null;
    this.buffer = [];
    this.send({ type: 'load', input });
  }
  update(input: SimInput) {
    this.send({ type: 'update', input });
  }
  run(running: boolean) {
    this.send({ type: 'run', running });
  }
  speed(speed: number) {
    this.send({ type: 'speed', speed });
  }
  reset() {
    this.prev = this.curr = null;
    this.buffer = [];
    this.send({ type: 'reset' });
  }
  advance(seconds: number) {
    this.send({ type: 'advance', seconds });
  }
  removeVehicle(vehicleId: number) {
    this.send({ type: 'removeVehicle', vehicleId });
  }
  inspect(vehicleId: number | null) {
    this.send({ type: 'inspect', vehicleId });
  }

  /**
   * Advance the display clock. It runs at the simulation speed and trails the newest
   * snapshot by a small buffer, gently steering to stay there, so motion stays smooth
   * no matter how irregularly snapshots arrive.
   */
  advanceClock(dt: number, running: boolean, uiSpeed: number) {
    const speed = uiSpeed * TIME_SCALE;
    const last = this.buffer[this.buffer.length - 1];
    if (!last) return;
    if (!running) {
      this.renderTime = last.time;
      return;
    }
    const lag = 0.18 * Math.max(1, speed);
    this.renderTime += dt * speed;
    const target = last.time - lag;
    const err = target - this.renderTime;
    if (Math.abs(err) > 1.5 * Math.max(1, speed)) this.renderTime = target;
    else this.renderTime += err * Math.min(1, dt * 1.5);
    this.renderTime = Math.max(this.buffer[0].time, Math.min(last.time, this.renderTime));
  }

  /** The two snapshots around the display clock and the blend factor between them. */
  pair(): { a: Snapshot; b: Snapshot; alpha: number } | null {
    const n = this.buffer.length;
    if (!n) return null;
    const t = this.renderTime;
    for (let i = n - 1; i > 0; i--) {
      const a = this.buffer[i - 1],
        b = this.buffer[i];
      if (t >= a.time) {
        const span = b.time - a.time;
        return { a, b, alpha: span > 0 ? Math.min(1, Math.max(0, (t - a.time) / span)) : 1 };
      }
    }
    return { a: this.buffer[0], b: this.buffer[0], alpha: 1 };
  }

  /** Interpolation factor between prev and curr for rendering. */
  alpha(now = performance.now()) {
    if (!this.prev) return 1;
    return Math.min(1, (now - this.currAt) / Math.max(1, this.interval));
  }

  terminate() {
    this.worker.terminate();
  }
}
