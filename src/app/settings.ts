/**
 * User settings (persisted to localStorage): scroll, speed, offsets, and ALL
 * input binds (keyboard + gamepad, one `bindings` model — see input/controls.ts).
 * Pure data + load/save; the React layer wraps this in a context. Loading is
 * the single sanitization point: persisted JSON is untrusted, so unions are
 * checked against runtime const arrays, numbers clamped, and malformed
 * bindings dropped before anything sees the result. loadSettings also performs
 * the one-time migrations from the pre-unification stores (the code->column
 * `keybindings` field, the separate notefield.gamepadBindings.v1 key, and
 * PlayerOptions' old per-play `stepline.options` key) and writes back, so the
 * next load is native.
 */

import {
  APPEARANCES,
  BG_MODES,
  DEFAULT_PLAY_OPTIONS,
  NOTE_SKINS,
  SCROLL_MODES,
  TURNS,
  type PlayOptions,
} from '../game/playOptions';
import {
  COLUMN_ROLES,
  CONTROL_ROLES,
  defaultBindings,
  isControlRole,
  type Bindings,
  type ControlRole,
} from '../input/controls';
import { isRecord, loadJson, removeJson, saveJson } from './storage';

export type { ScrollMode } from '../game/playOptions';
export type { Bindings } from '../input/controls';

/** Play options plus the persistence-only extras (input binds, renderer flag). */
export interface Settings extends PlayOptions {
  /** All input binds: keyboard code -> role, gamepad role -> button override. */
  bindings: Bindings;
  /** Use the experimental WebGPU renderer (falls back to Canvas). */
  webgpu: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_PLAY_OPTIONS,
  bindings: defaultBindings(),
  webgpu: true,
};

const STORAGE_KEY = 'notefield.settings.v1';
/** Pre-unification gamepad-binding store; migrated into `bindings` then removed. */
const LEGACY_GAMEPAD_KEY = 'notefield.gamepadBindings.v1';
/** PlayerOptions' pre-unification per-play store; mapped onto scroll/bg then removed. */
const LEGACY_PLAYER_OPTIONS_KEY = 'stepline.options';

const pick = <T>(v: unknown, allowed: readonly T[], dflt: T): T =>
  allowed.includes(v as T) ? (v as T) : dflt;
const num = (v: unknown, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : dflt;
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);

/** Well-formed persisted code->role entries; empty (or absent) falls back to defaults. */
function sanitizeKeyboardBindings(v: unknown): Record<string, ControlRole> {
  const out: Record<string, ControlRole> = {};
  if (isRecord(v)) {
    for (const [code, role] of Object.entries(v)) {
      if (isControlRole(role)) out[code] = role;
    }
  }
  // An empty map would make the app unnavigable — treat it as "use defaults".
  return Object.keys(out).length > 0 ? out : defaultBindings().keyboard;
}

/** Known roles bound to sane button indices; anything else dropped. */
function sanitizeGamepadBindings(v: unknown): Partial<Record<ControlRole, number>> {
  const out: Partial<Record<ControlRole, number>> = {};
  if (isRecord(v)) {
    for (const role of CONTROL_ROLES) {
      const b = v[role];
      if (typeof b === 'number' && Number.isInteger(b) && b >= 0) out[role] = b;
    }
  }
  return out;
}

/** Old keyboard model (code -> column 0..3) -> code -> role, over the defaults. */
function migrateLegacyKeybindings(v: Record<string, unknown>): Record<string, ControlRole> {
  const out = defaultBindings().keyboard;
  for (const [code, col] of Object.entries(v)) {
    if (typeof col === 'number' && Number.isInteger(col) && col >= 0 && col < COLUMN_ROLES.length) {
      out[code] = COLUMN_ROLES[col];
    }
  }
  return out;
}

/**
 * Resolve the bindings for a parsed settings object. Native `bindings` wins;
 * otherwise migrate the two pre-unification stores (old `keybindings` field +
 * the separate gamepad-bindings key). `migrated` tells loadSettings to write
 * back (and delete the legacy key) so the next load is native.
 */
function sanitizeBindings(p: Record<string, unknown>): { bindings: Bindings; migrated: boolean } {
  if (isRecord(p.bindings)) {
    return {
      bindings: {
        keyboard: sanitizeKeyboardBindings(p.bindings.keyboard),
        gamepad: sanitizeGamepadBindings(p.bindings.gamepad),
      },
      migrated: false,
    };
  }
  const legacyKeys = isRecord(p.keybindings) ? p.keybindings : null;
  const legacyPad = loadJson<unknown>(LEGACY_GAMEPAD_KEY);
  return {
    bindings: {
      keyboard: legacyKeys ? migrateLegacyKeybindings(legacyKeys) : defaultBindings().keyboard,
      gamepad: sanitizeGamepadBindings(legacyPad),
    },
    migrated: legacyKeys != null || legacyPad != null,
  };
}

/** Coerce untrusted parsed JSON into a well-formed Settings (field by field). */
function sanitizeSettings(v: unknown): { settings: Settings; migrated: boolean } {
  const p = isRecord(v) ? v : {};
  const d = DEFAULT_SETTINGS;
  const { bindings, migrated } = sanitizeBindings(p);
  return {
    migrated,
    settings: {
      scrollMode: pick(p.scrollMode, SCROLL_MODES, d.scrollMode),
      scrollValue: num(p.scrollValue, d.scrollValue),
      musicRate: num(p.musicRate, d.musicRate),
      audioOffsetMs: num(p.audioOffsetMs, d.audioOffsetMs),
      visualOffsetMs: num(p.visualOffsetMs, d.visualOffsetMs),
      bindings,
      turn: pick(p.turn, TURNS, d.turn),
      reverse: bool(p.reverse, d.reverse),
      appearance: pick(p.appearance, APPEARANCES, d.appearance),
      webgpu: bool(p.webgpu, d.webgpu),
      bgMode: pick(p.bgMode, BG_MODES, d.bgMode),
      noteSkin: pick(p.noteSkin, NOTE_SKINS, d.noteSkin),
    },
  };
}

/**
 * One-time migration from PlayerOptions' old `stepline.options` store
 * ({scrollType, cmod, xmod, bg}). That store used to overwrite these settings
 * fields on every START, so when present its values are what the user last
 * played with — map them over the parsed settings with the old loadOpts
 * semantics (missing fields take its defaults; `speed` is the pre-rename xmod
 * field; bg is an index into off/dim/full, out-of-range left alone rather
 * than persisting the old `bgMode: undefined` write). Returns true when the
 * key held data, so loadSettings writes back and removes it.
 */
function migrateLegacyPlayerOptions(s: Settings): boolean {
  const o = loadJson<unknown>(LEGACY_PLAYER_OPTIONS_KEY);
  if (o == null) return false;
  if (isRecord(o)) {
    const mode = o.scrollType === 'X' ? ('X' as const) : ('C' as const);
    s.scrollMode = mode;
    s.scrollValue = mode === 'C' ? num(o.cmod, 500) : num(o.xmod, num(o.speed, 2));
    const bg = typeof o.bg === 'number' && Number.isFinite(o.bg) ? o.bg | 0 : 0;
    if (BG_MODES[bg]) s.bgMode = BG_MODES[bg];
  }
  return true;
}

/** Load, validate, and clamp persisted settings (always returns a sane object). */
export function loadSettings(): Settings {
  const { settings, migrated } = sanitizeSettings(loadJson<unknown>(STORAGE_KEY));
  const migratedOpts = migrateLegacyPlayerOptions(settings);
  const out = normalizeSettings(settings);
  if (migrated || migratedOpts) {
    // One-time: persist the unified shape and drop the orphaned legacy stores.
    saveSettings(out);
    removeJson(LEGACY_GAMEPAD_KEY);
    removeJson(LEGACY_PLAYER_OPTIONS_KEY);
  }
  return out;
}

export function saveSettings(s: Settings): void {
  saveJson(STORAGE_KEY, s);
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
