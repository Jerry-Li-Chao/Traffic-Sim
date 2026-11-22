// Lane connection editing at a junction: markers for incoming/outgoing lanes and override toggling.
import type { World } from './World';
import type { NetGeometry } from './geometry';
import { approaches, laneGeometry, nodeConnectors, nodeLaneKey, type Connector } from './lanes';
import { polyAt, type Vec2 } from '../core/math';

export interface LaneMarker {
  /** node-local key "seg:idx" */
  key: string;
  seg: number;
  idx: number;
  pos: Vec2;
  dir: Vec2;
  incoming: boolean;
}

export function laneMarkers(world: World, geom: NetGeometry, nodeId: number): LaneMarker[] {
  const out: LaneMarker[] = [];
  for (const a of approaches(world, nodeId)) {
    if (a.inDir)
      for (let i = 0; i < a.inLanes; i++) {
        const lg = laneGeometry(world, geom, { seg: a.seg, dir: a.inDir, idx: i });
        const p = polyAt(lg.poly, Math.max(0, lg.poly.length - 3));
        out.push({ key: nodeLaneKey(a.seg, i), seg: a.seg, idx: i, pos: { x: p.x, y: p.y }, dir: { x: p.tx, y: p.ty }, incoming: true });
      }
    if (a.outDir)
      for (let i = 0; i < a.outLanes; i++) {
        const lg = laneGeometry(world, geom, { seg: a.seg, dir: a.outDir, idx: i });
        const p = polyAt(lg.poly, Math.min(lg.poly.length, 3));
        out.push({ key: nodeLaneKey(a.seg, i), seg: a.seg, idx: i, pos: { x: p.x, y: p.y }, dir: { x: p.tx, y: p.ty }, incoming: false });
      }
  }
  return out;
}

/** Current outgoing targets for an incoming lane (from overrides or defaults). */
export function targetsOf(conns: Connector[], seg: number, idx: number): string[] {
  return conns.filter((c) => c.from.seg === seg && c.from.idx === idx && !c.direct).map((c) => nodeLaneKey(c.to.seg, c.to.idx));
}

/**
 * Toggle a connection. The first edit on an approach copies that approach's current
 * connections into overrides so the other lanes keep their behaviour.
 */
export function toggleConnection(world: World, geom: NetGeometry, nodeId: number, fromKey: string, toKey: string) {
  const node = world.node(nodeId);
  const conns = nodeConnectors(world, geom, nodeId);
  const [fromSeg, fromIdx] = fromKey.split(':').map(Number);
  const [toSeg] = toKey.split(':').map(Number);
  if (fromSeg === toSeg) return false; // no U-turns
  const lanes = { ...(node.lanes ?? {}) };
  const app = approaches(world, nodeId).find((a) => a.seg === fromSeg);
  if (!app) return false;
  const hasOverride = Array.from({ length: app.inLanes }, (_, l) => nodeLaneKey(fromSeg, l)).some((k) => k in lanes);
  if (!hasOverride) for (let l = 0; l < app.inLanes; l++) lanes[nodeLaneKey(fromSeg, l)] = targetsOf(conns, fromSeg, l);
  const list = new Set(lanes[nodeLaneKey(fromSeg, fromIdx)] ?? []);
  if (list.has(toKey)) list.delete(toKey);
  else list.add(toKey);
  lanes[nodeLaneKey(fromSeg, fromIdx)] = [...list];
  node.lanes = lanes;
  world.touch();
  return true;
}
