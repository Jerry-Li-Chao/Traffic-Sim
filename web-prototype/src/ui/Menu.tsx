import { TipFigure } from './TipFigures';
import { useMemo, useState } from 'react';
import type { Game } from '../game/Game';
import { CAMPAIGN } from '../levels/campaign';
import { SANDBOXES } from '../levels/sandbox';
import { loadProgress, loadAutosave } from '../game/progress';
import { useUI, setUI } from '../game/store';
import { formatMoney } from './format';

export function MainMenu({ game }: { game: Game }) {
  const [rev, setRev] = useState(0);
  const [pickMap, setPickMap] = useState(false);
  const progress = useMemo(() => loadProgress(), [rev]);
  const last = progress.lastLevel ? [...CAMPAIGN, ...SANDBOXES].find((l) => l.id === progress.lastLevel) : null;
  const done = Object.keys(progress.completed).length;
  return (
    <div className="menu" data-testid="menu">
      <div className="panel card">
        <h1>Flowline</h1>
        <div className="tag">Build the roads. Open them to traffic. Find the problem. Fix it.</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {last && (
            <button className="btn primary" onClick={() => game.play(last, true)} data-testid="continue">
              ▶ Continue · {last.name}
            </button>
          )}
          <button className={'btn' + (pickMap ? '' : ' primary')} onClick={() => setPickMap(!pickMap)} data-testid="sandbox" aria-expanded={pickMap}>
            Sandbox {pickMap ? '▴' : '▾'}
          </button>
          <button className="btn" style={{ border: '1px solid var(--line)' }} onClick={() => setUI({ showHelp: true })}>
            How to play
          </button>
        </div>
        {pickMap && (
          <div className="map-picks" data-testid="sandbox-maps">
            {SANDBOXES.map((l) => (
              <button key={l.id} className="level-card" onClick={() => game.play(l, true)} data-testid={`map-${l.id}`}>
                <span className="num">
                  {(l.width / 1000).toFixed(1)} × {(l.height / 1000).toFixed(1)} km{loadAutosave(l.id) ? ' · in progress' : ''}
                </span>
                <span className="title">{l.id === 'sandbox' ? 'Valley' : l.name.replace(' sandbox', '')}</span>
                <span className="desc">{l.brief}</span>
              </button>
            ))}
          </div>
        )}
        <h3 style={{ margin: '20px 0 0', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-2)' }}>
          Campaign · {done}/{CAMPAIGN.length} sites complete
        </h3>
        <div className="level-grid">
          {CAMPAIGN.map((l, i) => {
            const stars = progress.completed[l.id] ?? 0;
            const unlocked = i === 0 || (progress.completed[CAMPAIGN[i - 1].id] ?? 0) > 0 || stars > 0;
            const hasSave = !!loadAutosave(l.id);
            return (
              <button key={l.id} className="level-card" disabled={!unlocked} onClick={() => game.play(l, true)} data-testid={`level-${l.id}`}>
                <span className="num">
                  Site {i + 1} · {formatMoney(l.budget)}
                </span>
                <span className="title">{l.name}</span>
                <span className="desc">{unlocked ? l.brief : 'Complete the previous site to unlock.'}</span>
                {stars > 0 && <span className="done">{'★'.repeat(stars) + '☆'.repeat(3 - stars)} complete</span>}
                {!stars && hasSave && <span className="desc" style={{ color: 'var(--accent)' }}>In progress</span>}
              </button>
            );
          })}
        </div>
        <div style={{ color: 'var(--ink-2)', fontSize: 12 }}>
          A traffic puzzle about roads, junctions and the drivers who use them.{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              if (confirm('Reset all campaign progress and saves?')) {
                try {
                  Object.keys(localStorage)
                    .filter((k) => k.startsWith('flowline.'))
                    .forEach((k) => localStorage.removeItem(k));
                } catch {
                  /* ignore */
                }
                setRev(rev + 1);
              }
            }}
            style={{ color: 'var(--ink-2)' }}
          >
            Reset progress
          </a>
        </div>
      </div>
    </div>
  );
}

export function WinModal({ game }: { game: Game }) {
  const show = useUI((s) => s.showWin);
  const id = useUI((s) => s.levelId);
  const money = useUI((s) => s.money);
  const budget = useUI((s) => s.budget);
  if (!show) return null;
  const idx = CAMPAIGN.findIndex((l) => l.id === id);
  const next = idx >= 0 ? CAMPAIGN[idx + 1] : undefined;
  const stars = loadProgress().completed[id] ?? 1;
  return (
    <div className="modal-back" data-testid="win">
      <div className="panel modal">
        <div style={{ fontSize: 34, color: '#e0a422', letterSpacing: 4 }}>{'★'.repeat(stars) + '☆'.repeat(3 - stars)}</div>
        <h2>Site complete!</h2>
        <p style={{ color: 'var(--ink-2)', lineHeight: 1.5 }}>
          Traffic is flowing. You finished with {formatMoney(money)} of {formatMoney(budget)} left.
          {stars < 3 ? ' Spend less to earn more stars.' : ' A thrifty, elegant network.'}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {next && (
            <button className="btn primary" onClick={() => game.play(next, true)} data-testid="next-site">
              Next site: {next.name} →
            </button>
          )}
          <button className="btn" style={{ border: '1px solid var(--line)' }} onClick={() => setUI({ showWin: false })}>
            Keep building
          </button>
          <button className="btn" style={{ border: '1px solid var(--line)' }} onClick={() => game.toMenu()}>
            Menu
          </button>
        </div>
      </div>
    </div>
  );
}

export function Tutorial() {
  const steps = useUI((s) => s.tutorial);
  const step = useUI((s) => s.tutorialStep);
  const screen = useUI((s) => s.screen);
  if (!steps || screen !== 'game' || step >= steps.length) return null;
  return (
    <div className="panel tutorial" data-testid="tutorial">
      <div className="group-title" style={{ marginBottom: 6 }}>
        Tip {step + 1} of {steps.length}
      </div>
      {typeof steps[step] === 'string' ? (
        <p>{steps[step] as string}</p>
      ) : (
        <>
          <p>{(steps[step] as { text: string }).text}</p>
          <TipFigure id={(steps[step] as { figure: string }).figure} />
        </>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn primary" onClick={() => setUI({ tutorialStep: step + 1 })}>
          {step + 1 < steps.length ? 'Next' : 'Got it'}
        </button>
        <button className="btn" onClick={() => setUI({ tutorial: null })}>
          Hide tips
        </button>
      </div>
    </div>
  );
}

export { HelpModal } from './Help';
