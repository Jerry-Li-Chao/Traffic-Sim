// Build a World from a LevelDef (pure; used by the game and by tests).
import { World, housePorts } from '../world/World';
import { planRoad, applyRoad, snapAnchor, type Anchor } from '../world/build';
import { straightBezier, quadToCubic } from '../core/math';
import type { LevelDef } from './level';
import { computeNetGeometry } from '../world/geometry';
import { allConnectors } from '../world/lanes';
import { compileWorld } from '../world/compile';
import type { SimInput } from '../sim/types';

export interface PortRuntime {
  id: number;
  name: string;
  color: string;
  node: number;
  kind: 'edge' | 'town';
  dir: number;
  x: number;
  y: number;
}

export function buildLevelWorld(def: LevelDef): { world: World; ports: PortRuntime[] } {
  const world = new World();
  const ports: PortRuntime[] = [];
  world.rails = (def.rails ?? []).map((r, i) => ({
    id: i + 1,
    pts: r.pts,
    level: r.level ?? 0,
    perHour: r.perHour,
    speedKmh: r.speedKmh ?? 90,
    cars: r.cars ?? 4,
  }));
  world.obstacles = structuredClone(def.obstacles ?? []);
  for (const p of def.ports) {
    const lv = p.level ?? 0;
    const node = world.addNode(p.x, p.y, lv, { port: p.id, locked: true });
    const stub = p.stub ?? 40;
    const end = world.addNode(p.x + Math.cos(p.dir) * stub, p.y + Math.sin(p.dir) * stub, lv);
    const bz = straightBezier(node, end);
    const s = world.addSegment(node.id, end.id, { c1: bz.p1, c2: bz.p2 }, p.cls, { locked: true, cost: 0 });
    // exits: traffic must flow out of the site through this stub
    if (p.flow === 'out' && s.lanesB === 0) world.reverseSegment(s.id);
    ports.push({ id: p.id, name: p.name, color: p.color, node: node.id, kind: p.kind, dir: p.dir, x: p.x, y: p.y });
  }
  for (const r of def.prebuilt ?? []) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i],
        b = r.pts[i + 1];
      const lvA = r.level ?? 0;
      const lvB = i === r.pts.length - 2 && r.endLevel !== undefined ? r.endLevel : lvA;
      const A: Anchor = snapAnchor(world, { x: a[0], y: a[1] }, 1.5, { level: lvA });
      const B: Anchor = snapAnchor(world, { x: b[0], y: b[1] }, 1.5, { level: lvB });
      const control = r.control && r.pts.length === 2 ? { x: r.control[0], y: r.control[1] } : undefined;
      const plan = planRoad(world, { start: A, end: B, cls: r.cls, level: B.kind === 'free' ? lvB : lvA, control }, { width: def.width, height: def.height });
      if (!plan.valid) {
        // fall back to a forced placement so authored levels never silently lose roads
        console.warn(`prebuilt road ${a} -> ${b} invalid: ${plan.reason}`);
        const na = A.kind === 'node' ? A.node : world.addNode(a[0], a[1], lvA).id;
        const nb = B.kind === 'node' ? B.node : world.addNode(b[0], b[1], lvB).id;
        const bz = control ? quadToCubic(world.node(na), control, world.node(nb)) : straightBezier(world.node(na), world.node(nb));
        world.addSegment(na, nb, { c1: bz.p1, c2: bz.p2 }, r.cls, { locked: r.locked ?? false, cost: 0 });
        continue;
      }
      const ids = applyRoad(world, plan);
      for (const id of ids) {
        const s = world.seg(id);
        s.locked = r.locked ?? false;
        s.cost = 0;
      }
    }
  }
  return { world, ports };
}

/** Compile a world + level demand into SimInput (used by tests and the game). */
export function compileLevel(world: World, def: Pick<LevelDef, 'seed' | 'demand' | 'rampUp'>, ports: PortRuntime[], extra: Partial<Parameters<typeof compileWorld>[3]> = {}): SimInput {
  const geom = computeNetGeometry(world);
  const conns = allConnectors(world, geom);
  return compileWorld(world, geom, conns, {
    seed: def.seed,
    demand: def.demand,
    ports: [...ports.map((p) => ({ id: p.id, name: p.name, node: p.node })), ...housePorts(world)],
    rampUp: def.rampUp ?? 60,
    ...extra,
  });
}
