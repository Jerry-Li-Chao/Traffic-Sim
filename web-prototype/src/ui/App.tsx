import { useEffect, useRef, useState } from 'react';
import { Game } from '../game/Game';
import { useUI, uiStore, setUI, getUI } from '../game/store';
import { Hud } from './Hud';
import { MainMenu, WinModal, Tutorial, HelpModal } from './Menu';
import { SettingsModal, SavesModal, ResetSiteModal } from './Settings';
import { audio } from '../game/audio';
import { setToastSound } from '../game/store';
import { laneMarkers } from '../world/laneEdit';
import { snapAnchor, planRoad, applyRoad } from '../world/build';
import { SANDBOXES } from '../levels/sandbox';
import { CAMPAIGN } from '../levels/campaign';

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [game, setGame] = useState<Game | null>(null);

  useEffect(() => {
    const g = new Game(canvasRef.current!);
    setToastSound((k) => (k === 'warn' || k === 'error') && audio.error());
    const wake = () => audio.resume();
    const clicks = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest?.('button')) audio.click();
    };
    window.addEventListener('pointerdown', wake);
    window.addEventListener('click', clicks);
    setGame(g);
    Object.assign(window as object, {
      game: g,
      __store: { store: uiStore, setUI, getUI },
      __laneMarkers: (id: number) => laneMarkers(g.world, g.geom, id),
      /** dev/test helper: start a site fresh (no autosave) */
      __play: (id: string) => {
        const def = [...SANDBOXES, ...CAMPAIGN].find((l) => l.id === id);
        if (def) g.play(def, false);
      },
      /** dev/test helper: build a road through the normal planner (chained points) */
      __road: (cls: string, pts: [number, number][], level = 0, endLevel?: number) => {
        for (let i = 0; i < pts.length - 1; i++) {
          const lv = i === pts.length - 2 && endLevel !== undefined ? endLevel : level;
          const a = snapAnchor(g.world, { x: pts[i][0], y: pts[i][1] }, 3, { level });
          const b = snapAnchor(g.world, { x: pts[i + 1][0], y: pts[i + 1][1] }, 3, { level: lv });
          const plan = planRoad(g.world, { start: a, end: b, cls, level: lv }, g.map);
          if (!plan.valid) return plan.reason;
          g.commit('Build', plan.cost, () => applyRoad(g.world, plan));
        }
        return 'ok';
      },
    });
    return () => {
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('click', clicks);
      g.dispose();
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="view" tabIndex={0} data-testid="view" />
      {game && <Screens game={game} />}
      <HelpModal />
      {game && <SettingsModal game={game} />}
      {game && <SavesModal game={game} />}
      {game && <ResetSiteModal game={game} />}
      <Toasts />
    </>
  );
}

function Screens({ game }: { game: Game }) {
  const screen = useUI((s) => s.screen);
  if (screen === 'menu') return <MainMenu game={game} />;
  return (
    <>
      <Hud game={game} />
      <Tutorial />
      <WinModal game={game} />
    </>
  );
}

function Toasts() {
  const toasts = useUI((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
