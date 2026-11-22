import { useRef, useState } from 'react';
import type { Game } from '../game/Game';
import { useUI, setUI, toast } from '../game/store';
import { listSlots, saveSlot, deleteSlot, type SaveGame } from '../game/progress';
import { loadSettings, saveSettings, type Settings } from '../game/settings';
import { formatMoney } from './format';

function Toggle({ on, onChange, testid, label }: { on: boolean; onChange: (v: boolean) => void; testid?: string; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} data-testid={testid}>
      <span className="knob" />
    </button>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{title}</div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

export function SettingsModal({ game }: { game: Game }) {
  const show = useUI((s) => s.showSettings);
  const [st, setSt] = useState<Settings>(() => loadSettings());
  if (!show) return null;
  const update = (p: Partial<Settings>) => {
    const next = { ...st, ...p };
    setSt(next);
    saveSettings(next);
    game.applySettings(next);
  };
  const close = () => setUI({ showSettings: false });
  return (
    <div className="modal-back" onClick={close}>
      <div className="panel modal settings" onClick={(e) => e.stopPropagation()} data-testid="settings">
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="btn icon" onClick={close} title="Close" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="set-group">Sound</div>
        <Row title="Volume" hint={st.muted ? 'Muted' : `${Math.round(st.volume * 100)}%`}>
          <input
            className="range"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={st.volume}
            disabled={st.muted}
            style={{ ['--fill' as string]: `${st.volume * 100}%` }}
            onChange={(e) => update({ volume: +e.target.value })}
            aria-label="Volume"
          />
        </Row>
        <Row title="Mute" hint="Silence traffic, trains and interface sounds">
          <Toggle on={st.muted} onChange={(v) => update({ muted: v })} testid="mute" label="Mute" />
        </Row>
        <div className="set-group">Graphics</div>
        <Row title="Shadows" hint="Turn off for a faster, cooler-running game">
          <Toggle on={st.shadows} onChange={(v) => update({ shadows: v })} testid="shadows" label="Shadows" />
        </Row>
        <Row title="Sharp rendering" hint="Full resolution on high-DPI screens">
          <Toggle on={st.hiDpi} onChange={(v) => update({ hiDpi: v })} label="Sharp rendering" />
        </Row>
        <div className="set-group">Display</div>
        <Row title="Speed units">
          <div className="segmented" role="radiogroup" aria-label="Speed units">
            {(['kmh', 'mph'] as const).map((u) => (
              <button key={u} role="radio" aria-checked={st.units === u} className={st.units === u ? 'active' : ''} onClick={() => update({ units: u })}>
                {u === 'kmh' ? 'km/h' : 'mph'}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Show FPS" hint="Frame rate in the top bar">
          <Toggle on={st.showFps} onChange={(v) => update({ showFps: v })} label="Show FPS" />
        </Row>
        <div className="modal-foot">
          <button className="btn primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export function SavesModal({ game }: { game: Game }) {
  const show = useUI((s) => s.showSaves);
  const [rev, setRev] = useState(0);
  const [name, setName] = useState('My network');
  const file = useRef<HTMLInputElement>(null);
  if (!show) return null;
  void rev;
  const slots = listSlots().filter((s) => s.levelId === game.level.id);
  const doSave = () => {
    if (!name.trim()) return;
    saveSlot(name.trim(), { levelId: game.level.id, world: game.world.toJSON(), money: game.money() });
    toast(`Saved “${name.trim()}”`, 'good');
    setRev(rev + 1);
  };
  const doExport = () => {
    const data: SaveGame = { levelId: game.level.id, world: game.world.toJSON(), money: game.money(), savedAt: Date.now(), name };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.trim().replace(/[^\w-]+/g, '_') || 'flowline'}.flowline.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const doImport = async (f: File) => {
    try {
      const data = JSON.parse(await f.text()) as SaveGame;
      if (!data.world?.nodes || data.levelId !== game.level.id) throw new Error('This file is for a different site');
      game.loadSave(data);
      setUI({ showSaves: false });
      toast('Network imported', 'good');
    } catch (e) {
      toast(String((e as Error).message || e), 'error');
    }
  };
  return (
    <div className="modal-back" onClick={() => setUI({ showSaves: false })}>
      <div className="panel modal" onClick={(e) => e.stopPropagation()} data-testid="saves">
        <h2>Saved networks</h2>
        <div style={{ display: 'flex', gap: 6, margin: '8px 0 12px' }}>
          <input className="text" value={name} onChange={(e) => setName(e.target.value)} data-testid="save-name" />
          <button className="btn primary" onClick={doSave} data-testid="save-slot">
            Save
          </button>
        </div>
        {slots.length === 0 && <div style={{ color: 'var(--ink-2)' }}>No saves for this site yet.</div>}
        {slots.map((s) => (
          <div className="kv" key={s.name} style={{ alignItems: 'center' }}>
            <span>
              <b style={{ color: 'var(--ink)' }}>{s.name}</b> · {new Date(s.savedAt).toLocaleString()}
            </span>
            <span style={{ display: 'flex', gap: 4 }}>
              <button
                className="btn"
                style={{ border: '1px solid var(--line)' }}
                onClick={() => {
                  game.loadSave(s);
                  setUI({ showSaves: false });
                }}
                data-testid={`load-${s.name}`}
              >
                Load
              </button>
              <button
                className="btn"
                onClick={() => {
                  deleteSlot(s.name!);
                  setRev(rev + 1);
                }}
              >
                ✕
              </button>
            </span>
          </div>
        ))}
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn" style={{ border: '1px solid var(--line)' }} onClick={doExport}>
            Export file…
          </button>
          <button className="btn" style={{ border: '1px solid var(--line)' }} onClick={() => file.current?.click()}>
            Import file…
          </button>
          <input ref={file} type="file" accept=".json" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
          <button className="btn" onClick={() => setUI({ showSaves: false })}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function ResetSiteModal({ game }: { game: Game }) {
  const show = useUI((s) => s.showReset);
  const name = useUI((s) => s.levelName);
  const budget = useUI((s) => s.budget);
  const unlimited = useUI((s) => s.unlimited);
  if (!show) return null;
  const close = () => setUI({ showReset: false });
  return (
    <div className="modal-back" onClick={close}>
      <div className="panel modal confirm" onClick={(e) => e.stopPropagation()} data-testid="reset-site">
        <h2>Reset {name}?</h2>
        <p>
          Every road, junction and roundabout you have built here is removed and the site goes back to how it started
          {unlimited ? '' : `, with the full ${formatMoney(budget)} budget`}. Traffic restarts from zero.
        </p>
        <p className="set-hint">You can bring your network back with Undo (⌘Z) until you leave the site.</p>
        <div className="modal-foot">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn danger"
            onClick={() => {
              close();
              game.resetSite();
            }}
            data-testid="reset-site-confirm"
          >
            Reset site
          </button>
        </div>
      </div>
    </div>
  );
}
