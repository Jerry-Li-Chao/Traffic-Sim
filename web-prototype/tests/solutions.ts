// Scripted reference solutions for every campaign site (used to prove the campaign is solvable).
import type { World, NodeControl } from '../src/world/World';
import { planRoad, applyRoad, snapAnchor } from '../src/world/build';
import { planRoundabout, applyRoundabout } from '../src/world/roundabout';
import { signalPhases, DEFAULT_GREEN } from '../src/world/control';

export type Action =
  | { road: string; pts: [number, number][]; level?: number; endLevel?: number; control?: [number, number] }
  | { control: NodeControl; at: [number, number]; green?: number[] }
  | { roundabout: [number, number]; radius: number; cls: string };

export function applyActions(world: World, map: { width: number; height: number }, actions: Action[]): number {
  let spent = 0;
  for (const a of actions) {
    if ('road' in a) {
      for (let i = 0; i < a.pts.length - 1; i++) {
        const lvA = a.level ?? 0;
        const lvB = i === a.pts.length - 2 && a.endLevel !== undefined ? a.endLevel : lvA;
        const A = snapAnchor(world, { x: a.pts[i][0], y: a.pts[i][1] }, 3, { level: lvA });
        const B = snapAnchor(world, { x: a.pts[i + 1][0], y: a.pts[i + 1][1] }, 3, { level: lvB });
        const plan = planRoad(world, { start: A, end: B, cls: a.road, level: lvB, control: a.control && a.pts.length === 2 ? { x: a.control[0], y: a.control[1] } : undefined }, map);
        if (!plan.valid) throw new Error(`road ${JSON.stringify(a.pts[i])} -> ${JSON.stringify(a.pts[i + 1])}: ${plan.reason}`);
        spent += plan.cost;
        applyRoad(world, plan);
      }
    } else if ('roundabout' in a) {
      const plan = planRoundabout(world, { x: a.roundabout[0], y: a.roundabout[1] }, a.radius, a.cls, map);
      if (!plan.valid) throw new Error(`roundabout: ${plan.reason}`);
      spent += plan.cost;
      applyRoundabout(world, plan);
    } else {
      const n = [...world.nodes.values()].find((x) => Math.hypot(x.x - a.at[0], x.y - a.at[1]) < 3);
      if (!n) throw new Error(`no node at ${a.at}`);
      n.control = a.control;
      if (a.control === 'signal') n.signal = { green: a.green ?? signalPhases(world, n.id).map(() => DEFAULT_GREEN) };
      spent += a.control === 'signal' ? 9000 : 600;
    }
  }
  return spent;
}

/** Turn a layout half a turn about the centre of a w x h site (for point-symmetric sites). */
function halfTurn(actions: Action[], w: number, h: number): Action[] {
  const m = (p: [number, number]): [number, number] => [w - p[0], h - p[1]];
  return actions.map((a) => ('road' in a ? { ...a, pts: a.pts.map(m), control: a.control && m(a.control) } : a));
}

/** Four Shores: everything heading south gathers into one road, crosses once and splits up again. */
const SOUTHBOUND: Action[] = [
  // Holme traffic leaves the eastbound carriageway on the right
  { road: 'ramp', pts: [[700, 1250], [900, 1100]], control: [860, 1228] },
  { road: 'ramp', pts: [[900, 1100], [900, 1020]] },
  // Whiteley traffic leaves the westbound carriageway on the right and flies back over both
  { road: 'ramp', pts: [[1100, 1290], [980, 1360]], level: 0, endLevel: 1, control: [1030, 1308] },
  { road: 'ramp', pts: [[980, 1360], [930, 1200]], level: 1, control: [930, 1360] },
  { road: 'ramp', pts: [[930, 1200], [900, 1020]], level: 1, endLevel: 0, control: [930, 1100] },
  // one highway over the river
  { road: 'highway', pts: [[900, 1020], [900, 930]], level: 0, endLevel: 1 },
  { road: 'highway', pts: [[900, 930], [900, 640]], level: 1 },
  { road: 'highway', pts: [[900, 640], [900, 560]], level: 1 },
  // Barton: down and join the westbound carriageway from the right
  { road: 'ramp', pts: [[900, 560], [760, 420]], level: 1, endLevel: 0, control: [870, 450] },
  { road: 'ramp', pts: [[760, 420], [600, 350]], control: [680, 368] },
  // Clifton: over both carriageways, round and join the eastbound one from the right
  { road: 'ramp', pts: [[900, 560], [900, 250]], level: 1 },
  { road: 'ramp', pts: [[900, 250], [980, 180]], level: 1, control: [900, 180] },
  { road: 'ramp', pts: [[980, 180], [1200, 310]], level: 1, endLevel: 0, control: [1120, 180] },
];

export const SOLUTIONS: Record<string, Action[]> = {
  'c11-four-shores': [...SOUTHBOUND, ...halfTurn(SOUTHBOUND, 2400, 1600)],
  'c1-first-road': [{ road: 'street', pts: [[40, 300], [860, 320]] }],
  'c2-crossroads': [
    { road: 'street', pts: [[40, 400], [960, 400]] },
    { road: 'street', pts: [[500, 760], [500, 40]] },
  ],
  'c3-market-day': [{ control: 'signal', at: [500, 400] }],
  'c4-river': [
    { road: 'street', pts: [[40, 400], [380, 400]] },
    { road: 'street', pts: [[380, 400], [500, 402]], level: 0, endLevel: 1 },
    { road: 'street', pts: [[500, 402], [760, 410]], level: 1 },
    { road: 'street', pts: [[760, 410], [880, 412]], level: 1, endLevel: 0 },
    { road: 'street', pts: [[880, 412], [1160, 420]] },
    { road: 'lane', pts: [[900, 760], [880, 412]] },
  ],
  'c5-level-crossing': [
    { road: 'avenue', pts: [[40, 400], [420, 400]] },
    { road: 'avenue', pts: [[420, 400], [540, 400]], level: 0, endLevel: 1 },
    { road: 'avenue', pts: [[540, 400], [690, 400]], level: 1 },
    { road: 'avenue', pts: [[690, 400], [810, 400]], level: 1, endLevel: 0 },
    { road: 'avenue', pts: [[810, 400], [1160, 400]] },
  ],
  'c6-highway-exit': [
    { road: 'street', pts: [[800, 930], [800, 740]] },
    { road: 'street', pts: [[800, 740], [800, 620]], level: 0, endLevel: 1 },
    { road: 'street', pts: [[800, 620], [800, 380]], level: 1 },
    { road: 'street', pts: [[800, 380], [800, 260]], level: 1, endLevel: 0 },
    { road: 'street', pts: [[800, 260], [800, 70]] },
    { road: 'ramp', pts: [[550, 480], [800, 260]], control: [700, 455] },
    { road: 'ramp', pts: [[800, 260], [1050, 480]], control: [900, 455] },
    { road: 'ramp', pts: [[1050, 520], [800, 740]], control: [900, 545] },
    { road: 'ramp', pts: [[800, 740], [550, 520]], control: [700, 545] },
  ],
  'c7-five-ways': [{ roundabout: [600, 500], radius: 32, cls: 'roundabout2' }],
  'c8-interchange': [
    { road: 'highway', pts: [[820, 440], [820, 560]], level: 0, endLevel: 1 },
    { road: 'highway', pts: [[820, 560], [820, 840]], level: 1 },
    { road: 'highway', pts: [[820, 840], [820, 960]], level: 1, endLevel: 0 },
    { road: 'highway', pts: [[780, 960], [780, 840]], level: 0, endLevel: 1 },
    { road: 'highway', pts: [[780, 840], [780, 560]], level: 1 },
    { road: 'highway', pts: [[780, 560], [780, 440]], level: 1, endLevel: 0 },
    { road: 'ramp', pts: [[500, 680], [780, 250]], control: [740, 640] },
    { road: 'ramp', pts: [[820, 250], [1100, 680]], control: [860, 640] },
    { road: 'ramp', pts: [[780, 1150], [500, 720]], control: [740, 760] },
    { road: 'ramp', pts: [[1100, 720], [820, 1150]], control: [860, 760] },
  ],
  'c9-station': [
    { road: 'avenue', pts: [[600, 760], [600, 560]] },
    { road: 'avenue', pts: [[600, 560], [600, 440]], level: 0, endLevel: -1 },
    { road: 'avenue', pts: [[600, 440], [600, 360]], level: -1 },
    { road: 'avenue', pts: [[600, 360], [600, 240]], level: -1, endLevel: 0 },
    { road: 'avenue', pts: [[600, 240], [600, 40]] },
    { road: 'street', pts: [[850, 270], [600, 160]] },
    { roundabout: [600, 160], radius: 32, cls: 'roundabout2' },
  ],
  'c10-twin-towns': [
    { road: 'street', pts: [[40, 800], [620, 800]] },
    { road: 'street', pts: [[620, 800], [740, 800]], level: 0, endLevel: 1 },
    { road: 'street', pts: [[740, 800], [890, 800]], level: 1 },
    { road: 'street', pts: [[890, 800], [1010, 800]], level: 1, endLevel: 0 },
    { road: 'street', pts: [[1010, 800], [1560, 800]] },
    { road: 'street', pts: [[300, 970], [300, 800]] },
    { road: 'street', pts: [[1300, 970], [1300, 800]] },
    { road: 'street', pts: [[300, 40], [300, 250]] },
    { road: 'street', pts: [[300, 250], [300, 370]], level: 0, endLevel: -1 },
    { road: 'street', pts: [[300, 370], [300, 450]], level: -1 },
    { road: 'street', pts: [[300, 450], [300, 570]], level: -1, endLevel: 0 },
    { road: 'street', pts: [[300, 570], [300, 800]] },
    { road: 'street', pts: [[1300, 40], [1300, 250]] },
    { road: 'street', pts: [[1300, 250], [1300, 370]], level: 0, endLevel: -1 },
    { road: 'street', pts: [[1300, 370], [1300, 450]], level: -1 },
    { road: 'street', pts: [[1300, 450], [1300, 570]], level: -1, endLevel: 0 },
    { road: 'street', pts: [[1300, 570], [1300, 800]] },
    { roundabout: [300, 800], radius: 24, cls: 'roundabout' },
    { roundabout: [1300, 800], radius: 24, cls: 'roundabout' },
  ],
};
