/**
 * User settings (persisted to localStorage): scroll, speed, offsets, key binds.
 * Pure data + load/save; the React layer wraps this in a context.
 */

import type { Turn } from '../notes/transforms';

export type ScrollMode = 'C' | 'X' | 'M';

export interface Settings {
  /** 'C' = constant (CMod), 'X' = BPM multiple (XMod), 'M' = max-BPM (MMod). */
  scrollMode: ScrollMode;
  /** CMod/MMod: a target BPM (e.g. 550). XMod: a multiplier (e.g. 2.0). */
  scrollValue: number;
  /** Music playback rate (1 = normal; 0.75 = practice slow). */
  musicRate: number;
  /** Manual audio-sync offset in ms (positive = judge notes later). */
  audioOffsetMs: number;
  /** Visual-only offset in ms (shifts arrows, not judgment). */
  visualOffsetMs: number;
  /** KeyboardEvent.code -> dance-single column (0..3). */
  keybindings: Record<string, number>;
  /** Column-remap play modifier (mirror/left/right/shuffle). */
  turn: Turn;
  /** Reverse (downscroll): receptors at the bottom. */
  reverse: boolean;
  /** Appearance mod. */
  appearance: 'visible' | 'hidden' | 'sudden';
  /** Use the experimental WebGPU renderer (falls back to Canvas). */
  webgpu: boolean;
  /** Song background visibility during play. */
  bgMode: 'off' | 'dim' | 'full';
}

export const DEFAULT_KEYBINDINGS: Record<string, number> = {
  ArrowLeft: 0,
  ArrowDown: 1,
  ArrowUp: 2,
  ArrowRight: 3,
  KeyD: 0,
  KeyF: 1,
  KeyJ: 2,
  KeyK: 3,
};

export const DEFAULT_SETTINGS: Settings = {
  scrollMode: 'C',
  scrollValue: 550,
  musicRate: 1,
  audioOffsetMs: 0,
  visualOffsetMs: 0,
  keybindings: { ...DEFAULT_KEYBINDINGS },
  turn: 'none',
  reverse: false,
  appearance: 'visible',
  webgpu: true,
  bgMode: 'dim',
};

const STORAGE_KEY = 'notefield.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, keybindings: { ...DEFAULT_KEYBINDINGS } };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      keybindings: { ...DEFAULT_KEYBINDINGS, ...(parsed.keybindings ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS, keybindings: { ...DEFAULT_KEYBINDINGS } };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore (private mode / quota)
  }
}

/** Clamp a settings object to sane ranges. */
export function normalizeSettings(s: Settings): Settings {
  const clamp = (v: number, lo: number, hi: number, dflt: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  return {
    ...s,
    scrollValue:
      s.scrollMode === 'X' ? clamp(s.scrollValue, 0.25, 8, 2) : clamp(s.scrollValue, 50, 2000, 550), // C and M are target BPMs
    musicRate: clamp(s.musicRate, 0.25, 2, 1),
    audioOffsetMs: clamp(s.audioOffsetMs, -300, 300, 0),
    visualOffsetMs: clamp(s.visualOffsetMs, -300, 300, 0),
  };
}
