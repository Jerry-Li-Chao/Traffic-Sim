import { useEffect, useState } from 'react';
import type { Game } from '../game/Game';
import { useUI, setUI, type ToolId } from '../game/store';
import { formatClock, formatMoney } from './format';
import { PALETTE_CLASSES, LEVEL_NAMES, MAX_LEVEL, MIN_LEVEL, type RoadClass } from '../world/roads';
import { crossSection } from '../world/World';
import { Inspector } from './Inspector';
import { TEMPLATES } from '../world/templates';
import { MenuIcon, HelpIcon, SettingsIcon, SaveIcon, ResetIcon } from './Icons';
import { formatSpeed } from '../game/settings';

export function Hud({ game }: { game: Game }) {
  const tool = useUI((s) => s.tool);
  return (
    <div className="hud">
      <TopLeft game={game} />
      <TopStats />
      <SimControls game={game} />
      <Toolbar game={game} />
      {(tool === 'road' || tool === 'upgrade') && <RoadPalette withOptions={tool === 'road'} />}
      {tool === 'templates' && <TemplatePalette />}
      <Inspector game={game} />
      <GoalsPanel />
      <CursorTip />
    </div>
  );
}

function TopLeft({ game }: { game: Game }) {
  const money = useUI((s) => s.money);
  const unlimited = useUI((s) => s.unlimited);
  const name = useUI((s) => s.levelName);
  return (
    <div className="panel bar top-left">
      <button className="btn icon" title="Menu" aria-label="Menu" onClick={() => game.toMenu()} data-testid="menu-btn">
        <MenuIcon />
      </button>
      <button className="btn icon" title="How to play" aria-label="How to play" onClick={() => setUI({ showHelp: true })} data-testid="help-btn">
        <HelpIcon />
      </button>
      <button className="btn icon" title="Settings" aria-label="Settings" onClick={() => setUI({ showSettings: true })} data-testid="settings-btn">
        <SettingsIcon />
      </button>
      <button className="btn icon" title="Save / load networks" aria-label="Save or load networks" onClick={() => setUI({ showSaves: true })} data-testid="saves-btn">
        <SaveIcon />
      </button>
      <button className="btn icon" title="Reset site: clear everything you have built" aria-label="Reset site" onClick={() => setUI({ showReset: true })} data-testid="reset-site-btn">
        <ResetIcon />
      </button>
      <div className="sep" />
      <div className="stat">
        <span className="k">Site</span>
        <span className="v">{name}</span>
      </div>
      <div className="sep" />
      <div className="stat">
        <span className="k">{unlimited ? 'Spent' : 'Budget'}</span>
        <span className="v mono" data-testid="money" style={{ color: !unlimited && money < 0 ? 'var(--bad)' : undefined }}>
          {formatMoney(money)}
        </span>
      </div>
    </div>
  );
}

function SimControls({ game }: { game: Game }) {
  const running = useUI((s) => s.running);
  const speed = useUI((s) => s.speed);
  const overlay = useUI((s) => s.overlay);
  return (
    <div className="panel bar top-right" data-testid="sim-controls">
      <button
        className={`btn ${overlay === 'congestion' ? 'active' : ''}`}
        title="Congestion heat map"
        onClick={() => game.setOverlay(overlay === 'congestion' ? 'none' : 'congestion')}
        data-testid="heatmap"
      >
        ◐ Heat map
      </button>
      <button className="btn" title="Restart traffic" onClick={() => game.resetTraffic()} data-testid="reset-traffic">
        ↺
      </button>
      <div className="sep" />
      <button
        className={`btn ${running ? '' : 'primary'}`}
        title={running ? 'Pause (Space)' : 'Open to traffic (Space)'}
        onClick={() => game.setRunning(!running)}
        data-testid="play"
      >
        {running ? '❚❚ Pause' : '▶ Open to traffic'}
      </button>
      {[1, 2, 4].map((s) => (
        <button key={s} className={`btn ${speed === s ? 'active' : ''}`} onClick={() => game.setSpeed(s)}>
          {s}×
        </button>
      ))}
    </div>
  );
}

function TopStats() {
  const t = useUI((s) => s.simTime);
  const vehicles = useUI((s) => s.vehicles);
  const fps = useUI((s) => s.fps);
  const showFps = useUI((s) => s.showFps);
  return (
    <div className="panel bar top-center">
      <div className="stat">
        <span className="k">Time</span>
        <span className="v mono" data-testid="clock">
          {formatClock(t)}
        </span>
      </div>
      <div className="stat">
        <span className="k">Vehicles</span>
        <span className="v mono" data-testid="vehicles">
          {vehicles}
        </span>
      </div>
      {showFps && (
        <div className="stat">
          <span className="k">FPS</span>
          <span className="v mono">{fps}</span>
        </div>
      )}
    </div>
  );
}

const TOOLS: { id: ToolId; label: string; icon: string; key: string }[] = [
  { id: 'inspect', label: 'Inspect', icon: '⌖', key: '1' },
  { id: 'road', label: 'Road', icon: '╱', key: '2' },
  { id: 'upgrade', label: 'Upgrade', icon: '⇧', key: '3' },
  { id: 'lanes', label: 'Lanes', icon: '☰', key: '4' },
  { id: 'junction', label: 'Junction', icon: '✣', key: '5' },
  { id: 'roundabout', label: 'Roundabout', icon: '◯', key: '6' },
  { id: 'templates', label: 'Templates', icon: '▦', key: '8' },
  { id: 'houses', label: 'Houses', icon: '⌂', key: '9' },
  { id: 'bulldoze', label: 'Bulldoze', icon: '✕', key: '7' },
];

function Toolbar({ game }: { game: Game }) {
  const tool = useUI((s) => s.tool);
  const canUndo = useUI((s) => s.canUndo);
  const canRedo = useUI((s) => s.canRedo);
  return (
    <div className="panel bar bottom-center" data-testid="toolbar">
      {TOOLS.filter((t) => game.tools[t.id] || t.id === 'inspect').map((t) => (
        <button
          key={t.id}
          className={`btn ${tool === t.id ? 'active' : ''}`}
          title={`${t.label} (${t.key})`}
          onClick={() => game.setTool(t.id)}
          data-testid={`tool-${t.id}`}
        >
          <span style={{ fontSize: 15 }}>{t.icon}</span>
          {t.label}
        </button>
      ))}
      <div className="sep" />
      <button className="btn" disabled={!canUndo} onClick={() => game.undo()} title="Undo (⌘Z)">
        ↶
      </button>
      <button className="btn" disabled={!canRedo} onClick={() => game.redo()} title="Redo (⇧⌘Z)">
        ↷
      </button>
    </div>
  );
}

function RoadIcon({ c }: { c: RoadClass }) {
  const cs = crossSection({ cls: c.id, lanesF: c.lanesF, lanesB: c.lanesB } as never);
  const scale = 46 / 34;
  const w = Math.min(46, cs.width * scale);
  return (
    <svg width="56" height="22" viewBox="0 0 56 22">
      <rect x={(56 - w) / 2} y="2" width={w} height="18" rx="2" fill={c.sidewalk ? '#b9b4a6' : '#3e4147'} />
      <rect x={(56 - cs.carriage * scale) / 2} y="2" width={cs.carriage * scale} height="18" fill="#44474d" />
      {c.lanesF > 0 && c.lanesB > 0 && (
        <rect x={28 + cs.medianOffset * scale - 0.75} y="2" width="1.5" height="18" fill={c.medianKind === 'grass' ? '#7f9353' : '#e3b440'} />
      )}
      {c.lanesF > 0 &&
        Array.from({ length: c.lanesF }, (_, i) => (
          <path key={'f' + i} d={`M${28 - cs.fwdOffset(i) * scale} 6 l0 9 l-2 -3 m2 3 l2 -3`} stroke="#fff" strokeWidth="1" fill="none" />
        ))}
      {Array.from({ length: c.lanesB }, (_, i) => (
        <path key={'b' + i} d={`M${28 - cs.bwdOffset(i) * scale} 16 l0 -9 l-2 3 m2 -3 l2 3`} stroke="#fff" strokeWidth="1" fill="none" />
      ))}
    </svg>
  );
}

function RoadPalette({ withOptions }: { withOptions: boolean }) {
  const roadClass = useUI((s) => s.roadClass);
  const allowed = useUI((s) => s.allowedClasses);
  const units = useUI((s) => s.units);
  const groups = ['Street', 'Avenue', 'Highway'] as const;
  return (
    <div className="panel palette" data-testid="palette">
      {groups.map((g) => (
        <div className="group" key={g}>
          <div className="group-title">{g}</div>
          <div className="items">
            {PALETTE_CLASSES.filter((c) => c.group === g).map((c) => {
              const locked = !allowed.includes(c.id);
              return (
                <button
                  key={c.id}
                  className={`road-item ${roadClass === c.id ? 'active' : ''} ${locked ? 'locked' : ''}`}
                  title={`${c.name} · ${c.lanesF}+${c.lanesB} lanes · ${formatSpeed(c.speedKmh, units)}${locked ? ' · locked on this site' : ''}`}
                  onClick={() => !locked && setUI({ roadClass: c.id })}
                  data-testid={`class-${c.id}`}
                >
                  <RoadIcon c={c} />
                  <span>{c.name}</span>
                  <span className="price">${c.costPerM}/m</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {withOptions && <BuildOptions />}
    </div>
  );
}

/** Ready-made junctions and interchanges (Templates tool). */
function TemplatePalette() {
  const selected = useUI((s) => s.templateId);
  const allowed = useUI((s) => s.allowedClasses);
  return (
    <div className="panel palette templates" data-testid="template-palette">
      {(['Highway', 'Street'] as const).map((g) => (
        <div className="group" key={g}>
          <div className="group-title">{g === 'Highway' ? 'Highway interchanges' : 'Street junctions'}</div>
          <div className="items">
            {TEMPLATES.filter((t) => t.group === g).map((t) => {
              const locked = t.build(20).pieces.some((p) => !allowed.includes(p.cls));
              return (
                <button
                  key={t.id}
                  className={`template-item ${selected === t.id ? 'active' : ''} ${locked ? 'locked' : ''}`}
                  title={`${t.description}${locked ? ' · uses roads not available on this site' : ''}`}
                  onClick={() => setUI({ templateId: t.id })}
                  data-testid={`template-${t.id}`}
                >
                  <TemplateIcon id={t.id} />
                  <span className="name">{t.name}</span>
                  <span className="desc">{t.fit === 'highway' ? 'Anywhere, or on a highway' : 'Q / E to turn'}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Thumbnail of a template, drawn from its own road layout. */
function TemplateIcon({ id }: { id: string }) {
  const t = TEMPLATES.find((x) => x.id === id)!;
  const spec = t.build(20);
  const pts = spec.pieces.flatMap((p) => p.pts.map(([x, y]) => [x, y]));
  const r = Math.max(...pts.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y)))) * 1.05;
  const toSvg = (x: number, y: number) => `${(x / r) * 22 + 24},${(-y / r) * 22 + 24}`;
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="6" fill="#8a9a5b" />
      {t.fit === 'highway' && (
        <>
          <line x1="0" y1={24 + (20 / r) * 22} x2="48" y2={24 + (20 / r) * 22} stroke="#2e3036" strokeWidth="3" />
          <line x1="0" y1={24 - (20 / r) * 22} x2="48" y2={24 - (20 / r) * 22} stroke="#2e3036" strokeWidth="3" />
        </>
      )}
      {spec.pieces.map((p, i) =>
        p.control ? (
          <path key={i} d={`M${toSvg(p.pts[0][0], p.pts[0][1])} Q${toSvg(p.control[0], p.control[1])} ${toSvg(p.pts[1][0], p.pts[1][1])}`} fill="none" stroke="#f3efe6" strokeWidth="1.6" />
        ) : (
          <polyline key={i} points={p.pts.map(([x, y]) => toSvg(x, y)).join(' ')} fill="none" stroke={p.pts.some((q) => (q[2] ?? 0) > 0) ? '#ffffff' : '#f3efe6'} strokeWidth={getClassWidth(p.cls)} />
        ),
      )}
      {(spec.roundabouts ?? []).map((rb, i) => (
        <circle key={i} cx={(rb.at[0] / r) * 22 + 24} cy={(-rb.at[1] / r) * 22 + 24} r={Math.max(2.5, (rb.radius / r) * 22)} fill="none" stroke="#f3efe6" strokeWidth="1.6" />
      ))}
    </svg>
  );
}

const getClassWidth = (cls: string) => (cls === 'avenue' || cls === 'boulevard' ? 2.6 : 1.6);

function GoalsPanel() {
  const goals = useUI((s) => s.goals);
  const sel = useUI((s) => s.selection);
  const stuck = useUI((s) => s.stuck);
  const removed = useUI((s) => s.removed);
  const completed = useUI((s) => s.completed);
  const meanTrip = useUI((s) => s.meanTrip);
  const hold = useUI((s) => s.goalHold);
  const holdTarget = useUI((s) => s.goalHoldTarget);
  const won = useUI((s) => s.won);
  if (sel) return null;
  const hasTargets = goals.some((g) => g.target > 0);
  const allMet = hasTargets && goals.every((g) => g.flow >= g.target);
  return (
    <div className="panel side" style={{ right: 10, top: 64 }} data-testid="goals">
      <h3>{hasTargets ? 'Site goals · vehicles/min' : 'Traffic · arrivals/min'}</h3>
      {hasTargets && (
        <div style={{ marginBottom: 10 }} data-testid="completion">
          <div className="row" style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
            <span>{won ? 'Site complete ✓' : allMet ? 'Holding targets…' : 'Meet every target'}</span>
            <span className="mono">{Math.min(100, Math.round((hold / holdTarget) * 100))}%</span>
          </div>
          <div className="meter" style={{ height: 8 }}>
            <div className={won || allMet ? 'ok' : ''} style={{ width: `${Math.min(100, (hold / holdTarget) * 100)}%` }} />
          </div>
        </div>
      )}
      {goals.map((g) => {
        const pct = g.target > 0 ? Math.min(1, g.flow / g.target) : Math.min(1, g.flow / 20);
        const ok = g.target > 0 ? g.flow >= g.target : true;
        return (
          <div className="goal" key={g.port}>
            <div className="row">
              <span className="name">
                <span className="swatch" style={{ background: g.color }} />
                {g.name}
              </span>
              <span className="mono">
                {g.flow.toFixed(1)}
                {g.target > 0 ? ` / ${g.target}` : ''}
              </span>
            </div>
            <div className="meter">
              <div className={ok ? 'ok' : ''} style={{ width: `${pct * 100}%` }} />
            </div>
            {g.target > 0 && (
              <div style={{ color: 'var(--ink-2)', fontSize: 11, marginTop: 2 }}>
                {g.demand.toFixed(g.demand % 1 ? 1 : 0)}/min heading here · need {g.target}
              </div>
            )}
            {g.backlog > 4 && <div style={{ color: 'var(--warn)', fontSize: 11, marginTop: 2 }}>{g.backlog} waiting to enter</div>}
          </div>
        );
      })}
      <div className="kv" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, color: 'var(--ink-2)' }}>
        <span>Trips done</span>
        <span className="mono">{completed}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--ink-2)' }}>
        <span>Avg trip</span>
        <span className="mono">{Math.round(meanTrip)} s</span>
      </div>
      {(stuck > 0 || removed > 0) && (
        <div style={{ color: 'var(--bad)', marginTop: 6, fontWeight: 600 }} data-testid="gridlock">
          {stuck > 0 ? `${stuck} vehicles stuck` : ''} {removed > 0 ? `· ${removed} gave up` : ''}
        </div>
      )}
    </div>
  );
}

function BuildOptions() {
  const level = useUI((s) => s.level);
  const curve = useUI((s) => s.curveMode);
  const grid = useUI((s) => s.gridSnap);
  const snapAngle = useUI((s) => s.snapAngle);
  const snapLength = useUI((s) => s.snapLength);
  const snapGuides = useUI((s) => s.snapGuides);
  const toggles: { on: boolean; label: string; title: string; set: () => void; testid?: string }[] = [
    { on: snapAngle, label: '∠ Angle', title: 'Snap to 15° steps, against north and against the road you start from (hold Shift to force)', set: () => setUI({ snapAngle: !snapAngle }), testid: 'snap-angle' },
    { on: snapLength, label: '↔ Length', title: 'Round road lengths to 5 m', set: () => setUI({ snapLength: !snapLength }), testid: 'snap-length' },
    { on: grid, label: '# Grid', title: 'Snap points to an 8 m grid (G)', set: () => setUI({ gridSnap: !grid }) },
    { on: snapGuides, label: '┈ Guides', title: 'Snap onto the straight-ahead line of road ends', set: () => setUI({ snapGuides: !snapGuides }), testid: 'snap-guides' },
  ];
  return (
    <div className="build-options" data-testid="build-options">
      <div className="group">
        <div className="group-title">
          Mode <kbd title="Press C to switch between straight and curved">C</kbd>
        </div>
        <div className="opt-col">
          <button className={`btn ${!curve ? 'active' : ''}`} onClick={() => setUI({ curveMode: false })} title="Straight (C)">
            ╱ Straight
          </button>
          <button className={`btn ${curve ? 'active' : ''}`} onClick={() => setUI({ curveMode: true })} title="Curved (C)" data-testid="curve">
            ⌒ Curve
          </button>
        </div>
      </div>
      <div className="group">
        <div className="group-title">Snapping</div>
        <div className="opt-grid">
          {toggles.map((t) => (
            <button key={t.label} className={`btn ${t.on ? 'active' : ''}`} onClick={t.set} title={t.title} data-testid={t.testid}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="group">
        <div className="group-title">Height</div>
        <div className="key-hint" title="Press [ to go lower, ] to go higher">
          <kbd>[</kbd> lower · <kbd>]</kbd> higher
        </div>
        <div className="levels" data-testid="levels">
          {Array.from({ length: MAX_LEVEL - MIN_LEVEL + 1 }, (_, i) => MAX_LEVEL - i).map((lv) => (
            <div key={lv} className={`lvl ${lv === level ? 'active' : ''}`} onClick={() => setUI({ level: lv })} data-testid={`level-${lv}`}>
              <div className="barviz" style={{ width: 6 + (lv - MIN_LEVEL) * 4 }} />
              <span>{LEVEL_NAMES[lv]}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CursorTip() {
  const ghost = useUI((s) => s.ghostInfo);
  const hover = useUI((s) => s.hover);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const f = (e: PointerEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('pointermove', f);
    return () => window.removeEventListener('pointermove', f);
  }, []);
  if (!ghost && !hover) return null;
  return (
    <div className={`panel ghost-tip ${ghost && !ghost.valid ? 'bad' : ''}`} style={{ left: pos.x, top: pos.y }}>
      {ghost ? (
        <>
          {Math.round(ghost.length)} m · {formatMoney(ghost.cost)}
          {ghost.reason ? ` · ${ghost.reason}` : ''}
          {ghost.detail && <div className="ghost-detail">{ghost.detail}</div>}
        </>
      ) : (
        hover
      )}
    </div>
  );
}

export { formatClock };
