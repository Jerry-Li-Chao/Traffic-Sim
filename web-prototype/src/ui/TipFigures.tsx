// Small illustrated diagrams shown inside tutorial tips.

const C = {
  grass: '#8a9a5b',
  road: '#44474d',
  edge: '#ecebe4',
  bridge: '#5a5e66',
  shadow: 'rgba(0,0,0,0.28)',
  exit: '#e08a1e',
  entry: '#2f7fd6',
  label: '#1f2a1c',
};

function Badge({ x, y, n }: { x: number; y: number; n: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={7} fill="#fff" stroke={C.label} strokeWidth={1.2} />
      <text x={x} y={y + 3.5} fontSize={10} fontWeight={700} textAnchor="middle" fill={C.label}>
        {n}
      </text>
    </g>
  );
}

function Arrow({ x, y, dir }: { x: number; y: number; dir: 1 | -1 }) {
  const p = dir > 0 ? `${x - 5},${y - 3} ${x + 3},${y} ${x - 5},${y + 3}` : `${x + 5},${y - 3} ${x - 3},${y} ${x + 5},${y + 3}`;
  return <polygon points={p} fill={C.edge} />;
}

/** Top-down diamond interchange: a street bridged over a dual-carriageway highway, four ramps. */
function Diamond() {
  // carriageways (y), street (x)
  const top = 74,
    bot = 102,
    sx = 130;
  const ramp = (d: string, color: string) => (
    <g>
      <path d={d} fill="none" stroke={C.road} strokeWidth={7} strokeLinecap="round" />
      <path d={d} fill="none" stroke={color} strokeWidth={2.2} strokeDasharray="4 3" strokeLinecap="round" />
    </g>
  );
  return (
    <svg viewBox="0 0 260 176" width="100%" role="img" aria-label="Diamond interchange: a street on a bridge over both highway carriageways, with an exit and an entry ramp for each direction">
      <rect width={260} height={176} rx={6} fill={C.grass} />
      {/* highway carriageways */}
      <rect x={0} y={top - 8} width={260} height={16} fill={C.road} />
      <rect x={0} y={bot - 8} width={260} height={16} fill={C.road} />
      <Arrow x={30} y={top} dir={-1} />
      <Arrow x={60} y={top} dir={-1} />
      <Arrow x={200} y={bot} dir={1} />
      <Arrow x={230} y={bot} dir={1} />
      {/* ramps: exits leave on the right before the bridge, entries join on the right after it */}
      {ramp(`M 44 ${bot + 7} C 80 ${bot + 9}, 112 ${bot + 26}, ${sx - 6} 152`, C.exit)}
      {ramp(`M ${sx + 6} 152 C 148 ${bot + 26}, 180 ${bot + 9}, 216 ${bot + 7}`, C.entry)}
      {ramp(`M 216 ${top - 7} C 180 ${top - 9}, 148 ${top - 26}, ${sx + 6} 24`, C.exit)}
      {ramp(`M ${sx - 6} 24 C 112 ${top - 26}, 80 ${top - 9}, 44 ${top - 7}`, C.entry)}
      {/* the street: at ground at both ends, on a bridge over the highway */}
      <rect x={sx - 6} y={0} width={12} height={176} fill={C.road} />
      <rect x={sx - 2} y={top - 22} width={14} height={bot - top + 44} fill={C.shadow} />
      <rect x={sx - 8} y={top - 22} width={16} height={bot - top + 44} rx={2} fill={C.bridge} stroke={C.edge} strokeWidth={1} />
      <line x1={sx} y1={top - 20} x2={sx} y2={bot + 20} stroke={C.edge} strokeWidth={0.8} strokeDasharray="3 3" />
      {/* junctions where the ramps meet the street */}
      <circle cx={sx} cy={24} r={5} fill="none" stroke="#fff" strokeWidth={1.2} />
      <circle cx={sx} cy={152} r={5} fill="none" stroke="#fff" strokeWidth={1.2} />
      <Badge x={sx + 20} y={top + 14} n={1} />
      <Badge x={70} y={bot + 26} n={2} />
      <Badge x={190} y={bot + 26} n={3} />
      <Badge x={190} y={top - 26} n={2} />
      <Badge x={70} y={top - 26} n={3} />
    </svg>
  );
}

const FIGURES: Record<string, { svg: () => React.JSX.Element; steps: string[] }> = {
  diamond: {
    svg: Diamond,
    steps: [
      'Bridge: with the Road tool on Street, click at Ground about 200 m from the highway. Press ] for Bridge, then click about 50 m before the highway and again 50 m past it. Press [ for Ground and click about 200 m out on the far side. The street climbs and comes back down on its own.',
      'Exits (orange): for each direction, a Ramp that leaves the carriageway on its right-hand side before the bridge and runs to the street where it is back on the ground.',
      'Entries (blue): a Ramp from the street that joins each carriageway on its right-hand side after the bridge.',
    ],
  },
};

export function TipFigure({ id }: { id: string }) {
  const f = FIGURES[id];
  if (!f) return null;
  const Svg = f.svg;
  return (
    <div className="tip-figure" data-testid={`tip-figure-${id}`}>
      <Svg />
      <ol>
        {f.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </div>
  );
}
