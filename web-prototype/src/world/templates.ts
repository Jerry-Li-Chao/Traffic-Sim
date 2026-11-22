// Ready-made junctions and interchanges, built from the ordinary road classes through the normal
// road planner (so heights, slopes, clearances and costs work exactly as when drawn by hand).
import type { Vec2 } from '../core/math';
import { closestOnPolyline, quadToCubic, sampleBezier } from '../core/math';
import { World } from './World';
import { planRoad, applyRoad, snapAnchor, type MapBounds, type Anchor } from './build';
import { planRoundabout, applyRoundabout } from './roundabout';
import { getClass } from './roads';

/** A point in the template's own frame: x along, y to the left, optional height level. */
type P = [number, number, number?];

export interface TemplatePiece {
  cls: string;
  /** chained points: a road between each consecutive pair */
  pts: P[];
  /** quadratic control point (two-point pieces only) */
  control?: [number, number];
}

export interface RoadTemplate {
  id: string;
  name: string;
  group: 'Highway' | 'Street';
  description: string;
  /**
   * 'highway': snaps onto a dual-carriageway highway when there is one under the cursor, and
   * otherwise brings its own stretch of highway; 'free': place anywhere. Both turn with Q / E.
   */
  fit: 'highway' | 'free';
  /** build list for a highway whose carriageways sit `h` metres either side of the centre */
  build(h: number, standalone?: boolean): { pieces: TemplatePiece[]; roundabouts?: { at: [number, number]; radius: number; cls: string }[]; signals?: [number, number][] };
}

/**
 * Diamond geometry around a highway centred on y = 0: eastbound carriageway (travelling +x) at
 * y = -h, westbound at y = +h (right-hand traffic). The street bridges both carriageways and
 * the four ramps meet it where it is back on the ground.
 */
function diamond(h: number, standalone = false) {
  const B = h + 50; // bridge ends
  const R = h + 140; // the street starts climbing here
  const J = h + 175; // ramp junctions on the street, flat ground (room for a roundabout)
  const far = J + 110;
  const pieces: TemplatePiece[] = [
    // placed on open ground: its own dual carriageway (eastbound on the right-hand side)
    ...(standalone
      ? [
          { cls: 'highway', pts: [[-340, -h], [340, -h]] as P[] },
          { cls: 'highway', pts: [[340, h], [-340, h]] as P[] },
        ]
      : []),
    { cls: 'street', pts: [[0, -far], [0, -J], [0, -R], [0, -B, 1], [0, B, 1], [0, R], [0, J], [0, far]] },
    // exits leave on the right before the bridge, entries join on the right after it
    { cls: 'ramp', pts: [[-280, -h], [0, -J]], control: [-110, -h - 18] },
    { cls: 'ramp', pts: [[0, -J], [280, -h]], control: [110, -h - 18] },
    { cls: 'ramp', pts: [[280, h], [0, J]], control: [110, h + 18] },
    { cls: 'ramp', pts: [[0, J], [-280, h]], control: [-110, h + 18] },
  ];
  return { pieces, J };
}

export const TEMPLATES: RoadTemplate[] = [
  {
    id: 'diamond',
    name: 'Diamond interchange',
    group: 'Highway',
    description: 'A street bridged over the highway, with an exit and an entry ramp for each direction.',
    fit: 'highway',
    build: (h, standalone) => ({ pieces: diamond(h, standalone).pieces }),
  },
  {
    id: 'dumbbell',
    name: 'Dumbbell interchange',
    group: 'Highway',
    description: 'A diamond with a roundabout at each end: no left turns across traffic, so it copes with busy ramps.',
    fit: 'highway',
    build: (h, standalone) => {
      const d = diamond(h, standalone);
      return {
        pieces: d.pieces,
        roundabouts: [
          { at: [0, -d.J], radius: 20, cls: 'roundabout' },
          { at: [0, d.J], radius: 20, cls: 'roundabout' },
        ],
      };
    },
  },
  {
    id: 'signal-cross',
    name: 'Signalised avenue crossing',
    group: 'Street',
    description: 'Two avenues crossing under traffic lights.',
    fit: 'free',
    build: () => ({
      pieces: [
        { cls: 'avenue', pts: [[-150, 0], [0, 0], [150, 0]] },
        { cls: 'avenue', pts: [[0, -150], [0, 0], [0, 150]] },
      ],
      signals: [[0, 0]],
    }),
  },
  {
    id: 'big-roundabout',
    name: 'Large roundabout',
    group: 'Street',
    description: 'A two-lane roundabout joining four avenues.',
    fit: 'free',
    build: () => ({
      pieces: [
        { cls: 'avenue', pts: [[-160, 0], [0, 0], [160, 0]] },
        { cls: 'avenue', pts: [[0, -160], [0, 0], [0, 160]] },
      ],
      roundabouts: [{ at: [0, 0], radius: 32, cls: 'roundabout2' }],
    }),
  },
  {
    id: 'couplet',
    name: 'One-way pair',
    group: 'Street',
    description: 'An avenue splitting into two one-way streets a block apart, with three cross streets.',
    fit: 'free',
    build: () => ({
      pieces: [
        { cls: 'avenue', pts: [[-260, 0], [-170, 0]] },
        { cls: 'avenue', pts: [[170, 0], [260, 0]] },
        // eastbound street on the right-hand (south) side, westbound on the north
        { cls: 'oneway', pts: [[-170, 0], [-110, -40], [110, -40], [170, 0]] },
        { cls: 'oneway', pts: [[170, 0], [110, 40], [-110, 40], [-170, 0]] },
        { cls: 'street', pts: [[-60, -110], [-60, 110]] },
        { cls: 'street', pts: [[60, -110], [60, 110]] },
        { cls: 'street', pts: [[0, -110], [0, -40]] },
        { cls: 'street', pts: [[0, 40], [0, 110]] },
      ],
    }),
  },
  {
    id: 'street-grid',
    name: 'Street grid',
    group: 'Street',
    description: 'Four city blocks: three streets each way, 100 m apart.',
    fit: 'free',
    build: () => ({
      pieces: [
        ...[-100, 0, 100].map((y): TemplatePiece => ({ cls: 'street', pts: [[-150, y], [150, y]] })),
        ...[-100, 0, 100].map((x): TemplatePiece => ({ cls: 'street', pts: [[x, -150], [x, 150]] })),
      ],
    }),
  },
];

/** Where a template sits: origin plus its x axis (unit vector) in world space. */
export interface Frame {
  origin: Vec2;
  ex: Vec2;
  /** half the distance between highway carriageways (highway templates) */
  h: number;
  /** highway template on open ground: build its own carriageways too */
  standalone?: boolean;
}

/** Carriageway half-spacing used when a highway template brings its own highway. */
export const OWN_HIGHWAY_H = 20;

export const toWorld = (f: Frame, x: number, y: number): Vec2 => ({
  x: f.origin.x + f.ex.x * x - f.ex.y * y,
  y: f.origin.y + f.ex.y * x + f.ex.x * y,
});

/**
 * Line a highway template up with the dual carriageway nearest to `p`: centred between the
 * carriageways, x along the right-hand (eastbound in the template) carriageway's travel.
 */
export function highwayFrame(world: World, p: Vec2): Frame | null {
  type Hit = { seg: number; pt: Vec2; t: Vec2; d: number };
  const hits: Hit[] = [];
  for (const s of world.segments.values()) {
    if (!getClass(s.cls).highway || s.roundabout) continue;
    if (s.lanesF > 0 && s.lanesB > 0) continue; // one carriageway at a time
    const poly = world.poly(s);
    const c = closestOnPolyline(poly, p);
    if (c.d > 90) continue;
    const i = Math.max(0, Math.min(poly.cum.length - 2, poly.cum.findIndex((v) => v >= c.s) - 1));
    let tx = poly.pts[i * 2 + 2] - poly.pts[i * 2],
      ty = poly.pts[i * 2 + 3] - poly.pts[i * 2 + 1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    if (s.lanesF === 0) {
      tx = -tx;
      ty = -ty;
    }
    hits.push({ seg: s.id, pt: { x: c.x, y: c.y }, t: { x: tx, y: ty }, d: c.d });
  }
  hits.sort((a, b) => a.d - b.d);
  for (const a of hits) {
    for (const b of hits) {
      if (b.seg === a.seg || a.t.x * b.t.x + a.t.y * b.t.y > -0.9) continue;
      // b's closest point to a's: the other carriageway, straight across
      const poly = world.poly(world.seg(b.seg));
      const q = closestOnPolyline(poly, a.pt);
      const gap = Math.hypot(q.x - a.pt.x, q.y - a.pt.y);
      if (gap < 16 || gap > 90) continue;
      const left = { x: -a.t.y, y: a.t.x };
      const aIsEast = (q.x - a.pt.x) * left.x + (q.y - a.pt.y) * left.y > 0;
      const ex = aIsEast ? a.t : b.t;
      const mid = { x: (a.pt.x + q.x) / 2, y: (a.pt.y + q.y) / 2 };
      // slide along the highway to follow the cursor
      const along = (p.x - mid.x) * ex.x + (p.y - mid.y) * ex.y;
      return { origin: { x: mid.x + ex.x * along, y: mid.y + ex.y * along }, ex, h: gap / 2 };
    }
  }
  return null;
}

export interface TemplatePlan {
  valid: boolean;
  reason?: string;
  cost: number;
  /** world-space outlines for the preview */
  lines: { pts: Vec2[]; cls: string; level: number }[];
}

/** Outline of the template in world space (for the ghost preview). */
export function templateOutline(t: RoadTemplate, f: Frame): TemplatePlan['lines'] {
  const spec = t.build(f.h, f.standalone);
  const lines: TemplatePlan['lines'] = [];
  for (const pc of spec.pieces) {
    for (let i = 0; i + 1 < pc.pts.length; i++) {
      const a = toWorld(f, pc.pts[i][0], pc.pts[i][1]),
        b = toWorld(f, pc.pts[i + 1][0], pc.pts[i + 1][1]);
      let pts = [a, b];
      if (pc.control) {
        const c = toWorld(f, pc.control[0], pc.control[1]);
        const poly = sampleBezier(quadToCubic(a, c, b), 4);
        pts = [];
        for (let k = 0; k < poly.pts.length; k += 2) pts.push({ x: poly.pts[k], y: poly.pts[k + 1] });
      }
      lines.push({ pts, cls: pc.cls, level: Math.max(pc.pts[i][2] ?? 0, pc.pts[i + 1][2] ?? 0) });
    }
  }
  for (const r of spec.roundabouts ?? []) {
    const c = toWorld(f, r.at[0], r.at[1]);
    lines.push({ pts: Array.from({ length: 33 }, (_, k) => ({ x: c.x + r.radius * Math.cos((k / 32) * Math.PI * 2), y: c.y + r.radius * Math.sin((k / 32) * Math.PI * 2) })), cls: r.cls, level: 0 });
  }
  return lines;
}

/**
 * Build the template into `world`. Throws (with a player-facing message) if any part cannot be
 * built; callers run it on a copy for the preview and inside an undoable command for real.
 * Returns the total cost.
 */
export function applyTemplate(world: World, t: RoadTemplate, f: Frame, map: MapBounds): number {
  const spec = t.build(f.h, f.standalone);
  let cost = 0;
  for (const pc of spec.pieces) {
    let prev: Anchor | null = null;
    for (let i = 0; i + 1 < pc.pts.length; i++) {
      const [ax, ay, al = 0] = pc.pts[i];
      const [bx, by, bl = 0] = pc.pts[i + 1];
      let start: Anchor = prev ?? snapAnchor(world, toWorld(f, ax, ay), 4, { level: al });
      if (start.kind === 'free' && al !== bl) {
        // a free start at a different height than the end: give it its own node first
        const n = world.addNode(start.pos.x, start.pos.y, al);
        start = { kind: 'node', node: n.id, pos: { x: n.x, y: n.y } };
      }
      const end = snapAnchor(world, toWorld(f, bx, by), 4, { level: bl, exclude: start.kind === 'node' ? new Set([start.node]) : undefined });
      const control = pc.control ? toWorld(f, pc.control[0], pc.control[1]) : undefined;
      const plan = planRoad(world, { start, end, control, cls: pc.cls, level: start.kind === 'free' ? al : bl }, map);
      if (!plan.valid) throw new Error(`${getClass(pc.cls).name}: ${plan.reason ?? 'cannot be built here'}`);
      const ids = applyRoad(world, plan);
      cost += plan.cost;
      const last = world.seg(ids[ids.length - 1]);
      const n = world.node(last.b);
      prev = { kind: 'node', node: n.id, pos: { x: n.x, y: n.y } };
    }
  }
  for (const r of spec.roundabouts ?? []) {
    const plan = planRoundabout(world, toWorld(f, r.at[0], r.at[1]), r.radius, r.cls, map, 0);
    if (!plan.valid) throw new Error(`Roundabout: ${plan.reason ?? 'cannot be built here'}`);
    applyRoundabout(world, plan, 0);
    cost += plan.cost;
  }
  for (const [x, y] of spec.signals ?? []) {
    const p = toWorld(f, x, y);
    for (const n of world.nodes.values()) if (Math.hypot(n.x - p.x, n.y - p.y) < 4 && world.degree(n.id) >= 3) n.control = 'signal';
  }
  world.touch();
  return cost;
}

/** Try the template on a copy of the world: validity, reason and cost, without changing anything. */
export function planTemplate(world: World, t: RoadTemplate, f: Frame, map: MapBounds, money = Infinity): TemplatePlan {
  const lines = templateOutline(t, f);
  for (const l of lines)
    for (const p of l.pts) if (p.x < 0 || p.y < 0 || p.x > map.width || p.y > map.height) return { valid: false, reason: 'Outside the site', cost: 0, lines };
  try {
    const cost = applyTemplate(world.clone(), t, f, map);
    if (cost > money) return { valid: false, reason: 'Not enough money', cost, lines };
    return { valid: true, cost, lines };
  } catch (e) {
    return { valid: false, reason: (e as Error).message, cost: 0, lines };
  }
}
