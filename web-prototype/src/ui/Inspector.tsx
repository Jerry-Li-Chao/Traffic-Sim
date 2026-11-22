import type { Game } from '../game/Game';
import { useUI } from '../game/store';
import { formatMoney } from './format';
import { formatSpeed } from '../game/settings';

export function Inspector({ game }: { game: Game }) {
  const sel = useUI((s) => s.selection);
  useUI((s) => s.worldRev); // re-render on world changes
  if (!sel) return null;
  return (
    <div className="panel inspector" data-testid="inspector">
      {sel.kind === 'segment' && <SegmentPanel game={game} id={sel.id} />}
      {sel.kind === 'node' && <NodePanel game={game} id={sel.id} />}
      {sel.kind === 'vehicle' && <VehiclePanel game={game} id={sel.id} />}
    </div>
  );
}

function Close({ game }: { game: Game }) {
  return (
    <button className="btn" style={{ position: 'absolute', right: 6, top: 4 }} onClick={() => game.select(null)} title="Close (Esc)">
      ✕
    </button>
  );
}

function SegmentPanel({ game, id }: { game: Game; id: number }) {
  const units = useUI((s) => s.units);
  const info = game.segmentInfo(id);
  if (!info) return null;
  const { seg, cls, length, z, grade } = info;
  void 0;
  const zText = (v: number) => (Math.abs(v) < 0.5 ? 'ground' : v > 0 ? `+${v.toFixed(0)} m` : `${v.toFixed(0)} m`);
  return (
    <>
      <Close game={game} />
      <h3>Road</h3>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>{cls.name}</div>
      <div className="kv">
        <span>Length</span>
        <span className="mono">{Math.round(length)} m</span>
      </div>
      <div className="kv">
        <span>Speed limit</span>
        <span className="mono">{formatSpeed(cls.speedKmh, units)}</span>
      </div>
      <div className="kv">
        <span>Height</span>
        <span className="mono">
          {zText(z[0])}
          {Math.abs(z[0] - z[1]) > 0.5 ? ` → ${zText(z[1])} (${Math.round(grade * 100)}%)` : ''}
        </span>
      </div>
      <div className="kv">
        <span>Value</span>
        <span className="mono">{formatMoney(seg.cost ?? 0)}</span>
      </div>
      {seg.locked ? (
        <div className="kv">
          <span>Fixed by the site</span>
        </div>
      ) : (
        <>
          <div className="kv" style={{ marginTop: 6 }}>
            <span>Lanes → (white)</span>
            <Stepper value={seg.lanesF} onChange={(v) => game.setSegmentLanes(id, v, seg.lanesB)} testid="lanesF" />
          </div>
          <div className="kv">
            <span>Lanes ← (yellow)</span>
            <Stepper value={seg.lanesB} onChange={(v) => game.setSegmentLanes(id, seg.lanesF, v)} testid="lanesB" />
          </div>
          <div className="actions">
            <button className="btn" onClick={() => game.toggleOneWay(id)} data-testid="oneway">
              {seg.lanesF > 0 && seg.lanesB > 0 ? 'Make one-way' : 'Make two-way'}
            </button>
            <button className="btn" onClick={() => game.reverseSegment(id)} data-testid="reverse">
              ⇄ Reverse
            </button>
          </div>
        </>
      )}
    </>
  );
}

function Stepper({ value, onChange, testid }: { value: number; onChange: (v: number) => void; testid?: string }) {
  return (
    <span className="stepper">
      <button className="btn" onClick={() => onChange(value - 1)} data-testid={testid ? `${testid}-minus` : undefined}>
        −
      </button>
      <span className="mono" style={{ minWidth: 14, textAlign: 'center' }}>
        {value}
      </span>
      <button className="btn" onClick={() => onChange(value + 1)} data-testid={testid ? `${testid}-plus` : undefined}>
        +
      </button>
    </span>
  );
}

const CONTROLS: { id: import('../world/World').NodeControl; label: string; hint: string; explain: string }[] = [
  {
    id: 'auto',
    label: 'Give way',
    hint: 'Side roads give way to the main road',
    explain: 'The main road never stops. Drivers on the side roads slow down at the dashed line and only wait if traffic is coming. Cheap and quick, but side roads struggle when the main road is busy.',
  },
  {
    id: 'stop',
    label: 'Stop signs',
    hint: 'Side roads must stop completely, then give way',
    explain: 'Like Give way, but side-road drivers must come to a full stop at the solid line before pulling out, even if the road is clear. Slower for the side roads; the main road still never stops.',
  },
  {
    id: 'allstop',
    label: 'All-way stop',
    hint: 'Everyone stops; first to arrive goes first',
    explain: 'There is no main road. Every driver from every direction stops at the line, and whoever arrived first goes first. Fair to all directions, but each car has to stop, so it only suits light traffic.',
  },
  {
    id: 'signal',
    label: 'Signals',
    hint: 'Traffic lights give each direction its turn',
    explain: 'Traffic lights give each direction (or opposite pair) a green phase in turn. Handles heavy traffic from every side; lengthen the green time for the busiest direction below.',
  },
];

function NodePanel({ game, id }: { game: Game; id: number }) {
  const info = game.nodeInfo(id);
  if (!info) return null;
  const { node, arms, phases, green } = info;
  const ctl = node.control;
  return (
    <>
      <Close game={game} />
      <h3>Junction control</h3>
      <div className="seg-control" data-testid="control">
        {CONTROLS.map((c) => (
          <button key={c.id} className={`btn ${ctl === c.id ? 'active' : ''}`} title={c.hint} onClick={() => game.setNodeControl(id, c.id)} data-testid={`control-${c.id}`}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="explain" data-testid="control-explain">
        {CONTROLS.find((c) => c.id === ctl)?.explain}
      </div>
      {(ctl === 'auto' || ctl === 'stop') && (
        <>
          <div style={{ color: 'var(--ink-2)', margin: '8px 0 4px' }}>Which roads are the main road? (click to change)</div>
          {arms.map((a) => (
            <div className="kv" key={a.seg}>
              <span>{a.name}</span>
              <button className={`btn ${a.major ? 'active' : ''}`} style={{ padding: '1px 8px' }} onClick={() => game.toggleMajor(id, a.seg)} data-testid={`major-${a.seg}`}>
                {a.major ? 'Main road' : ctl === 'stop' ? 'Stop' : 'Give way'}
              </button>
            </div>
          ))}
        </>
      )}
      {ctl === 'signal' && (
        <>
          <div style={{ color: 'var(--ink-2)', margin: '8px 0 4px' }}>Green time per phase</div>
          {phases.map((ph, k) => (
            <div className="kv" key={k}>
              <span>
                Phase {k + 1} · {ph.map((seg) => arms.find((a) => a.seg === seg)?.name.split(' · ')[0]).join(' + ')}
              </span>
              <span className="stepper">
                <button className="btn" onClick={() => game.setSignalGreen(id, k, green[k] - 5)} data-testid={`green-${k}-minus`}>
                  −
                </button>
                <span className="mono">{green[k]}s</span>
                <button className="btn" onClick={() => game.setSignalGreen(id, k, green[k] + 5)} data-testid={`green-${k}-plus`}>
                  +
                </button>
              </span>
            </div>
          ))}
        </>
      )}
      <div className="kv" style={{ marginTop: 8 }}>
        <span>Lane connections</span>
        <span className="mono">{info.connectors}</span>
      </div>
      <LaneEditButtons game={game} id={id} custom={!!node.lanes} />
    </>
  );
}

function LaneEditButtons({ game, id, custom }: { game: Game; id: number; custom: boolean }) {
  const le = useUI((s) => s.laneEdit);
  const editing = le?.node === id;
  return (
    <>
      <div className="actions">
        <button className={`btn ${editing ? 'active' : ''}`} onClick={() => game.editLanes(editing ? null : id)} data-testid="edit-lanes">
          {editing ? 'Done editing lanes' : 'Edit lane connections'}
        </button>
        {custom && (
          <button className="btn" onClick={() => game.resetLanes(id)} data-testid="reset-lanes">
            Reset
          </button>
        )}
      </div>
      {editing && (
        <div style={{ color: 'var(--ink-2)', marginTop: 6, fontSize: 12, lineHeight: 1.4 }}>
          Click an incoming lane (white dot), then click outgoing lanes (blue dots) to connect or disconnect them.
        </div>
      )}
    </>
  );
}

/** What a holding vehicle is waiting for (Vehicle.holdWhy). */
const HOLD_REASONS: Record<number, string> = {
  1: 'a red light',
  2: 'its turn at a stop sign',
  3: 'a gap to give way',
  4: 'the junction to clear',
  5: 'space on the road ahead',
  6: 'its turn in the queue',
  7: 'a train at the level crossing',
};

function VehiclePanel({ game, id }: { game: Game; id: number }) {
  const ins = useUI((s) => s.inspected);
  const port = ins ? game.ports.find((p) => p.id === ins.dest) : null;
  const toHouse = ins && !port && ins.dest >= 100_000;
  const status = !ins
    ? ''
    : !ins.reachable
      ? 'No route to its destination from here'
      : ins.wait >= 1
        ? `Waiting ${ins.wait.toFixed(0)} s${HOLD_REASONS[ins.holdWhy] ? ` for ${HOLD_REASONS[ins.holdWhy]}` : ' in traffic'}`
        : 'Moving';
  return (
    <>
      <Close game={game} />
      <h3>Vehicle #{id}</h3>
      {ins && ins.id === id ? (
        <>
          <div className="kv">
            <span>Heading to</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
              {port && <span className="swatch" style={{ background: port.color }} />}
              {port?.name ?? (toHouse ? 'A house' : '—')}
            </span>
          </div>
          <div className="kv">
            <span>Status</span>
            <span style={{ color: !ins.reachable ? 'var(--bad)' : ins.wait > 20 ? 'var(--warn)' : undefined, textAlign: 'right' }} data-testid="vehicle-status">
              {status}
            </span>
          </div>
          {ins.reachable && Number.isFinite(ins.eta) && (
            <div className="kv">
              <span>Time to go</span>
              <span className="mono">≈ {Math.max(1, Math.round(ins.eta))} s</span>
            </div>
          )}
          <div className="explain" data-testid="vehicle-route">
            {ins.reachable ? (
              <>
                Its whole route is traced in <b style={{ color: '#b8860b' }}>yellow</b>, lane changes included, ending at the ring on its destination.
              </>
            ) : (
              <>
                The <b style={{ color: 'var(--bad)' }}>red</b> line shows how far it can get. Connect the road at the red ring to its destination, fix the lane
                connections there, or remove the car.
              </>
            )}
          </div>
          <button className="btn" style={{ marginTop: 8 }} onClick={() => game.removeVehicle(id)} data-testid="remove-vehicle">
            ✕ Remove car
          </button>
        </>
      ) : (
        <div className="kv">
          <span>Arrived</span>
        </div>
      )}
    </>
  );
}
