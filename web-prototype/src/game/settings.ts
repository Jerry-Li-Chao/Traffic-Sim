// Player settings persisted in localStorage.

export interface Settings {
  volume: number;
  muted: boolean;
  shadows: boolean;
  hiDpi: boolean;
  units: 'kmh' | 'mph';
  showFps: boolean;
}

const KEY = 'flowline.settings.v1';

export const DEFAULT_SETTINGS: Settings = { volume: 0.5, muted: false, shadows: true, hiDpi: true, units: 'kmh', showFps: false };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function formatSpeed(kmh: number, units: Settings['units']) {
  return units === 'mph' ? `${Math.round(kmh / 1.609)} mph` : `${kmh} km/h`;
}
