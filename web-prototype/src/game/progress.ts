// Campaign progress + autosaves, kept in localStorage (best effort: storage may be unavailable).
import type { WorldData } from '../world/World';

const KEY = 'flowline.progress.v1';
const SAVE_PREFIX = 'flowline.save.v1.';

export interface Progress {
  /** level id -> best stars */
  completed: Record<string, number>;
  lastLevel?: string;
}

export interface SaveGame {
  levelId: string;
  world: WorldData;
  money: number;
  savedAt: number;
  name?: string;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: progress just isn't persisted */
  }
}

export function loadProgress(): Progress {
  return read<Progress>(KEY, { completed: {} });
}

export function markCompleted(levelId: string, stars: number) {
  const p = loadProgress();
  p.completed[levelId] = Math.max(p.completed[levelId] ?? 0, stars);
  write(KEY, p);
}

export function setLastLevel(levelId: string) {
  const p = loadProgress();
  p.lastLevel = levelId;
  write(KEY, p);
}

export function autosave(save: SaveGame) {
  write(SAVE_PREFIX + save.levelId, save);
}

export function loadAutosave(levelId: string): SaveGame | null {
  return read<SaveGame | null>(SAVE_PREFIX + levelId, null);
}

export function clearAutosave(levelId: string) {
  try {
    localStorage.removeItem(SAVE_PREFIX + levelId);
  } catch {
    /* ignore */
  }
}

/** Named sandbox save slots. */
export function listSlots(): SaveGame[] {
  const out: SaveGame[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(SAVE_PREFIX + 'slot:')) {
        const s = read<SaveGame | null>(k, null);
        if (s) out.push(s);
      }
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export function saveSlot(name: string, save: Omit<SaveGame, 'name' | 'savedAt'>) {
  write(SAVE_PREFIX + 'slot:' + name, { ...save, name, savedAt: Date.now() });
}

export function deleteSlot(name: string) {
  try {
    localStorage.removeItem(SAVE_PREFIX + 'slot:' + name);
  } catch {
    /* ignore */
  }
}
