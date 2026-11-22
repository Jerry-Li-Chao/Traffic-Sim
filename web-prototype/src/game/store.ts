import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export type ToolId = 'inspect' | 'road' | 'upgrade' | 'lanes' | 'junction' | 'roundabout' | 'templates' | 'houses' | 'bulldoze';
export type Overlay = 'none' | 'congestion';
export type Screen = 'menu' | 'game';

export interface GoalView {
  port: number;
  name: string;
  color: string;
  target: number;
  /** vehicles/min the site sends to this destination */
  demand: number;
  flow: number;
  backlog: number;
}

export interface Selection {
  kind: 'segment' | 'node' | 'vehicle';
  id: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'warn' | 'error' | 'good';
}

export interface UIState {
  screen: Screen;
  levelId: string;
  levelName: string;
  levelBrief: string;
  money: number;
  budget: number;
  unlimited: boolean;
  tool: ToolId;
  roadClass: string;
  allowedClasses: string[];
  level: number; // height level -2..4
  curveMode: boolean;
  gridSnap: boolean;
  /** snap to 15° steps (world axes and the road you start from) when close */
  snapAngle: boolean;
  /** round road lengths to 5 m */
  snapLength: boolean;
  /** snap onto the extension lines of existing roads */
  snapGuides: boolean;
  running: boolean;
  speed: number;
  simTime: number;
  vehicles: number;
  stuck: number;
  removed: number;
  completed: number;
  meanTrip: number;
  fps: number;
  overlay: Overlay;
  goals: GoalView[];
  /** seconds all goals have been met continuously */
  goalHold: number;
  goalHoldTarget: number;
  won: boolean;
  showWin: boolean;
  selection: Selection | null;
  hover: string | null;
  canUndo: boolean;
  canRedo: boolean;
  toasts: Toast[];
  ghostInfo: { cost: number; length: number; valid: boolean; reason?: string; detail?: string } | null;
  laneEdit: { node: number; fromKey: string | null } | null;
  inspected: { id: number; dest: number; wait: number; reachable: boolean; eta: number; holdWhy: number } | null;
  /** revision counter bumped when world changes (UI panels re-read) */
  worldRev: number;
  tutorial: import('./level').TipStep[] | null;
  tutorialStep: number;
  muted: boolean;
  showHelp: boolean;
  showSettings: boolean;
  showReset: boolean;
  /** ready-made junction picked in the Templates tool */
  templateId: string;
  showSaves: boolean;
  showFps: boolean;
  units: 'kmh' | 'mph';
}

export const initialUI: UIState = {
  screen: 'menu',
  levelId: '',
  levelName: '',
  levelBrief: '',
  money: 0,
  budget: 0,
  unlimited: false,
  tool: 'inspect',
  roadClass: 'street',
  allowedClasses: [],
  level: 0,
  curveMode: false,
  gridSnap: false,
  snapAngle: true,
  snapLength: false,
  snapGuides: true,
  running: false,
  speed: 1,
  simTime: 0,
  vehicles: 0,
  stuck: 0,
  removed: 0,
  completed: 0,
  meanTrip: 0,
  fps: 60,
  overlay: 'none',
  goals: [],
  goalHold: 0,
  goalHoldTarget: 120,
  won: false,
  showWin: false,
  selection: null,
  hover: null,
  canUndo: false,
  canRedo: false,
  toasts: [],
  ghostInfo: null,
  laneEdit: null,
  inspected: null,
  worldRev: 0,
  tutorial: null,
  tutorialStep: 0,
  muted: false,
  showHelp: false,
  showSettings: false,
  showReset: false,
  templateId: 'diamond',
  showSaves: false,
  showFps: false,
  units: 'kmh',
};

export const uiStore = createStore<UIState>(() => ({ ...initialUI }));
export const setUI = (p: Partial<UIState>) => uiStore.setState(p);
export const getUI = () => uiStore.getState();
export function useUI<T>(sel: (s: UIState) => T): T {
  return useStore(uiStore, sel);
}

let toastId = 1;
let onToast: ((kind: Toast['kind']) => void) | null = null;
export function setToastSound(fn: (kind: Toast['kind']) => void) {
  onToast = fn;
}

export function toast(text: string, kind: Toast['kind'] = 'info', ms = 3200) {
  const t: Toast = { id: toastId++, text, kind };
  onToast?.(kind);
  setUI({ toasts: [...getUI().toasts.slice(-3), t] });
  setTimeout(() => setUI({ toasts: getUI().toasts.filter((x) => x.id !== t.id) }), ms);
}
