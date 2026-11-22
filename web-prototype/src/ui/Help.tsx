import { useState } from 'react';
import { useUI, setUI } from '../game/store';
import { LEVEL_NAMES, MAX_LEVEL, MIN_LEVEL } from '../world/roads';

const TABS = [
  { id: 'goal', label: 'Goal' },
  { id: 'tools', label: 'Tools' },
  { id: 'building', label: 'Building' },
  { id: 'controls', label: 'Controls' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const K = ({ children }: { children: React.ReactNode }) => <kbd>{children}</kbd>;

function Goal() {
  const steps = [
    { icon: '╱', title: 'Build', text: 'Connect the entries (coloured signs at the map edge) to the destinations with roads, junctions and interchanges.' },
    { icon: '▶', title: 'Open to traffic', text: 'Press Space. Every driver picks the fastest route through your network and reacts to jams.' },
    { icon: '◎', title: 'Hold the targets', text: 'Keep every destination at or above its target flow until the completion bar fills. More money left means more stars.' },
  ];
  return (
    <>
      <div className="help-steps">
        {steps.map((s, i) => (
          <div className="help-step" key={s.title}>
            <div className="help-step-icon">{s.icon}</div>
            <div>
              <div className="help-step-title">
                <span className="help-num">{i + 1}</span>
                {s.title}
              </div>
              <p>{s.text}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="help-note">
        <b>Reading the goals panel:</b> “4.0 / 3.5” is the flow now against the target. The line below shows how many drivers want to get there, so you
        can tell a slow network from a quiet destination. Turn on the <b>Heat map</b> to see where traffic crawls.
      </div>
    </>
  );
}

function Tools() {
  const tools = [
    { key: '1', icon: '⌖', name: 'Inspect', text: 'Click a car to trace its whole route and see why it is waiting (or remove it if stuck), or a road or junction for details.' },
    { key: '2', icon: '╱', name: 'Road', text: 'Pick a road type in the palette and click to lay it. Clicks chain from the last point.' },
    { key: '3', icon: '⇧', name: 'Upgrade', text: 'Click a road to swap it for the selected type, keeping its junctions.' },
    { key: '4', icon: '☰', name: 'Lanes', text: 'Add or remove lanes in each direction, make a road one-way or reverse it.' },
    { key: '5', icon: '✣', name: 'Junction', text: 'Give way, stop signs, all-way stop or signals, plus lane-by-lane connections.' },
    { key: '6', icon: '◯', name: 'Roundabout', text: 'Drop one on a junction, or on a bridge for a two-level interchange.' },
    { key: '8', icon: '▦', name: 'Templates', text: 'Ready-made interchanges and junctions. Highway ones join a highway under the cursor or bring their own; all turn with Q / E.' },
    { key: '9', icon: '⌂', name: 'Houses', text: 'Build a house beside a street. It sends and receives a few local trips, never more than two cars each way.' },
    { key: '7', icon: '✕', name: 'Bulldoze', text: 'Click to remove a ~50 m section of road; hold and drag to clear everything you touch. Part of the cost is refunded.' },
  ];
  return (
    <div className="help-tools">
      {tools.map((t) => (
        <div className="help-tool" key={t.key}>
          <div className="help-tool-head">
            <span className="help-tool-icon">{t.icon}</span>
            <span className="help-tool-name">{t.name}</span>
            <K>{t.key}</K>
          </div>
          <p>{t.text}</p>
        </div>
      ))}
    </div>
  );
}

function Building() {
  const levels = Array.from({ length: MAX_LEVEL - MIN_LEVEL + 1 }, (_, i) => MAX_LEVEL - i);
  return (
    <div className="help-building">
      <div className="help-levels">
        <div className="help-sub">
          Heights <K>[</K> <K>]</K>
        </div>
        {levels.map((lv) => (
          <div key={lv} className={`help-level ${lv === 0 ? 'ground' : lv > 0 ? 'up' : 'down'}`}>
            <span className="lvl-bar" style={{ width: 10 + (lv - MIN_LEVEL) * 7 }} />
            {LEVEL_NAMES[lv]}
          </div>
        ))}
        <p className="help-small">The height applies to each point you click, so a bridge is: Ground point, Bridge points over the obstacle, Ground point.</p>
      </div>
      <div>
        <div className="help-sub">Rules of the road</div>
        <ul className="help-list">
          <li>Bridges need one full height level of clearance over roads and railways.</li>
          <li>Slopes need length: a climb of one level needs roughly 70 m of road. Roads can join a slope part-way up.</li>
          <li>Roads crossing at the same height make a junction; at a railway they make a level crossing with barriers.</li>
          <li>Highways are one-way: exits leave on the right, entries join from the right with Ramps.</li>
          <li>Water can only be crossed on a bridge or in a tunnel. On some sites highways may not cross anything at the same height at all, so traffic turning left has to loop round or fly over.</li>
        </ul>
        <div className="help-sub">Precision aids</div>
        <ul className="help-list">
          <li>
            <b>Angle</b> catches 15° steps against north and the road you start from. Hold <K>Shift</K> to force it.
          </li>
          <li>
            <b>Length</b> rounds to 5 m · <b>Grid</b> snaps to 8 m <K>G</K>
          </li>
          <li>
            <b>Guides</b> follow the straight-ahead line of road ends.
          </li>
          <li>The label by the cursor shows length, cost, bearing, turn angle, grade and height.</li>
        </ul>
      </div>
    </div>
  );
}

function Controls() {
  const groups: { title: string; rows: [React.ReactNode, string][] }[] = [
    {
      title: 'Building',
      rows: [
        [<K key="c">C</K>, 'Straight / curved roads'],
        [
          <>
            <K>[</K> <K>]</K>
          </>,
          'Height (road tool) · size (roundabout)',
        ],
        [<K key="l">L</K>, 'Roundabout: switch between stacked levels'],
        [<K key="g">G</K>, 'Grid snap'],
        [<K key="s">Shift</K>, 'Force 15° angles'],
        [<K key="rc">right-click</K>, 'Cancel the current step'],
        [<K key="esc">Esc</K>, 'Close a dialog · cancel the current step · back to Inspect'],
      ],
    },
    {
      title: 'Editing',
      rows: [
        [<K key="z">⌘Z</K>, 'Undo'],
        [<K key="y">⇧⌘Z</K>, 'Redo'],
        [<K key="t">1 – 9</K>, 'Pick a tool'],
        [<K key="q">Q / E</K>, 'Templates: turn a street junction'],
      ],
    },
    {
      title: 'Traffic & camera',
      rows: [
        [<K key="sp">Space</K>, 'Open to traffic / pause'],
        ['Two-finger swipe', 'Pan (trackpad) · or drag the map, or WASD'],
        ['Pinch / mouse wheel', 'Zoom'],
      ],
    },
  ];
  return (
    <div className="help-controls">
      {groups.map((g) => (
        <div key={g.title}>
          <div className="help-sub">{g.title}</div>
          <table className="help-keys">
            <tbody>
              {g.rows.map(([k, v], i) => (
                <tr key={i}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

export function HelpModal() {
  const show = useUI((s) => s.showHelp);
  const [tab, setTab] = useState<TabId>('goal');
  if (!show) return null;
  const close = () => setUI({ showHelp: false });
  return (
    <div className="modal-back" onClick={close}>
      <div className="panel modal help" onClick={(e) => e.stopPropagation()} data-testid="help">
        <div className="modal-head">
          <h2>How to play</h2>
          <button className="btn icon" onClick={close} title="Close" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} data-testid={`help-tab-${t.id}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="help-body">
          {tab === 'goal' && <Goal />}
          {tab === 'tools' && <Tools />}
          {tab === 'building' && <Building />}
          {tab === 'controls' && <Controls />}
        </div>
      </div>
    </div>
  );
}
