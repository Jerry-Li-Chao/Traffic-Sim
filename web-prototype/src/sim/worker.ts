/// <reference lib="webworker" />
// Simulation worker: runs the fixed-step Sim and streams snapshots to the main thread.
import { Sim } from './Sim';
import { SIM_DT, TIME_SCALE, type FromWorker, type ToWorker } from './protocol';

const sim = new Sim();
let running = false;
let speed = 1;
let acc = 0;
let last = performance.now();
let inspect: number | null = null;

const post = (m: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

function send() {
  const snap = sim.snapshot(inspect);
  post({ type: 'snapshot', snap }, [snap.vehicles.buffer, snap.ids.buffer, snap.trains.buffer]);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'load':
        sim.load(m.input);
        acc = 0;
        send();
        break;
      case 'update':
        sim.update(m.input);
        send();
        break;
      case 'run':
        running = m.running;
        last = performance.now();
        break;
      case 'speed':
        speed = m.speed;
        break;
      case 'reset':
        sim.load(sim.input);
        send();
        break;
      case 'inspect':
        inspect = m.vehicleId;
        send();
        break;
      case 'removeVehicle':
        sim.removeVehicle(m.vehicleId);
        send();
        break;
      case 'advance': {
        const steps = Math.round(m.seconds / SIM_DT);
        for (let i = 0; i < steps; i++) sim.step();
        send();
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.stack ?? err) });
  }
};

setInterval(() => {
  const now = performance.now();
  const realDt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (!running) return;
  acc += realDt * speed * TIME_SCALE;
  let steps = 0;
  const t0 = performance.now();
  while (acc >= SIM_DT && steps < 400) {
    try {
      sim.step();
    } catch (err) {
      // never stall silently: restart the traffic on the current network and keep going
      const message = String((err as Error)?.stack ?? err);
      try {
        sim.load(sim.input);
        acc = 0;
        post({ type: 'error', message, recovered: true });
        send();
      } catch {
        running = false;
        post({ type: 'error', message, recovered: false });
      }
      return;
    }
    acc -= SIM_DT;
    steps++;
    // Don't fall into a spiral if the machine can't keep up.
    if (performance.now() - t0 > 40) {
      acc = 0;
      break;
    }
  }
  if (steps > 0) send();
}, 33);

post({ type: 'ready' });
