import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, normalizeSettings } from '../src/app/settings';
import { DEFAULT_KEYBOARD_BINDINGS } from '../src/input/controls';

describe('normalizeSettings (todo #15)', () => {
  it('clamps out-of-range values', () => {
    const s = normalizeSettings({
      ...DEFAULT_SETTINGS,
      musicRate: 99,
      audioOffsetMs: 9999,
      visualOffsetMs: -9999,
      scrollMode: 'C',
      scrollValue: 1e9,
    });
    expect(s.musicRate).toBeLessThanOrEqual(2);
    expect(s.audioOffsetMs).toBeLessThanOrEqual(300);
    expect(s.visualOffsetMs).toBeGreaterThanOrEqual(-300);
    expect(s.scrollValue).toBeLessThanOrEqual(2000);
  });

  it('falls back to a default for NaN', () => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, musicRate: NaN }).musicRate).toBe(1);
  });

  it('uses the X-mod range when scrollMode is X', () => {
    const s = normalizeSettings({ ...DEFAULT_SETTINGS, scrollMode: 'X', scrollValue: 50 });
    expect(s.scrollValue).toBeLessThanOrEqual(8);
  });
});

// --- load-time sanitization (review #13) ------------------------------------

const STORAGE_KEY = 'notefield.settings.v1';

function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
    configurable: true,
    writable: true,
  });
  return store;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('loadSettings validates persisted JSON (review #13)', () => {
  it('returns defaults when localStorage is unavailable (node env)', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when nothing is stored', () => {
    stubLocalStorage();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('survives corrupt JSON', () => {
    const store = stubLocalStorage();
    store.set(STORAGE_KEY, '{not valid json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('rejects non-object JSON (number / array)', () => {
    const store = stubLocalStorage();
    store.set(STORAGE_KEY, '42');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    store.set(STORAGE_KEY, '[1,2,3]');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('replaces invalid union values with defaults', () => {
    const store = stubLocalStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        scrollMode: 'Z',
        turn: 'spin',
        bgMode: 'strobe',
        noteSkin: 7,
      }),
    );
    const s = loadSettings();
    expect(s.scrollMode).toBe(DEFAULT_SETTINGS.scrollMode);
    expect(s.turn).toBe(DEFAULT_SETTINGS.turn);
    expect(s.bgMode).toBe(DEFAULT_SETTINGS.bgMode);
    expect(s.noteSkin).toBe(DEFAULT_SETTINGS.noteSkin);
  });

  it('clamps out-of-range numbers at load time', () => {
    const store = stubLocalStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({ musicRate: 99, audioOffsetMs: -99999, scrollValue: 1e9 }),
    );
    const s = loadSettings();
    expect(s.musicRate).toBe(2);
    expect(s.audioOffsetMs).toBe(-300);
    expect(s.scrollValue).toBe(2000);
  });

  it('clamps scrollValue with the X-mod range when scrollMode is X', () => {
    const store = stubLocalStorage();
    store.set(STORAGE_KEY, JSON.stringify({ scrollMode: 'X', scrollValue: 50 }));
    expect(loadSettings().scrollValue).toBeLessThanOrEqual(8);
  });

  it('replaces wrong-typed numbers, booleans and unions with defaults', () => {
    const store = stubLocalStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({ musicRate: 'fast', scrollValue: null, reverse: 'yes', bgMode: 'vivid' }),
    );
    const s = loadSettings();
    expect(s.musicRate).toBe(DEFAULT_SETTINGS.musicRate);
    expect(s.scrollValue).toBe(DEFAULT_SETTINGS.scrollValue);
    expect(s.reverse).toBe(DEFAULT_SETTINGS.reverse);
    expect(s.bgMode).toBe(DEFAULT_SETTINGS.bgMode);
  });

  it('filters malformed bindings entries, keeps valid ones', () => {
    const store = stubLocalStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        bindings: {
          keyboard: { KeyQ: 'up', KeyW: 'sideways', KeyE: 3, ArrowLeft: 'right' },
          gamepad: { up: 7, down: -1, left: 1.5, confirm: 'x', warp: 2 },
        },
      }),
    );
    const s = loadSettings();
    expect(s.bindings.keyboard.KeyQ).toBe('up'); // valid extra binding kept
    expect(s.bindings.keyboard.KeyW).toBeUndefined(); // not a role
    expect(s.bindings.keyboard.KeyE).toBeUndefined(); // not a string
    expect(s.bindings.keyboard.ArrowLeft).toBe('right'); // valid override kept as-is
    expect(s.bindings.keyboard.KeyD).toBeUndefined(); // persisted map is authoritative
    expect(s.bindings.gamepad.up).toBe(7); // valid button kept
    expect(s.bindings.gamepad.down).toBeUndefined(); // negative index dropped
    expect(s.bindings.gamepad.left).toBeUndefined(); // not an integer
    expect(s.bindings.gamepad.confirm).toBeUndefined(); // not a number
    expect('warp' in s.bindings.gamepad).toBe(false); // unknown role dropped
  });

  it('falls back to default keyboard bindings when the persisted map is empty', () => {
    const store = stubLocalStorage();
    store.set(STORAGE_KEY, JSON.stringify({ bindings: { keyboard: {}, gamepad: {} } }));
    expect(loadSettings().bindings.keyboard).toEqual(DEFAULT_KEYBOARD_BINDINGS);
  });

  it('keeps well-formed persisted values as-is', () => {
    const store = stubLocalStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        scrollMode: 'X',
        scrollValue: 2.5,
        musicRate: 0.75,
        turn: 'mirror',
        reverse: true,
        bgMode: 'off',
        noteSkin: 'arcade',
      }),
    );
    const s = loadSettings();
    expect(s.scrollMode).toBe('X');
    expect(s.scrollValue).toBe(2.5);
    expect(s.musicRate).toBe(0.75);
    expect(s.turn).toBe('mirror');
    expect(s.reverse).toBe(true);
    expect(s.bgMode).toBe('off');
    expect(s.noteSkin).toBe('arcade');
  });
});

// --- one-time migration from the pre-unification stores ----------------------

const LEGACY_GAMEPAD_KEY = 'notefield.gamepadBindings.v1';

describe('loadSettings migrates the old split binding stores', () => {
  it('converts old code->column keybindings to code->role over the defaults', () => {
    const store = stubLocalStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({ keybindings: { KeyQ: 2, ArrowLeft: 3, KeyW: 9, KeyE: 'x' } }),
    );
    const s = loadSettings();
    expect(s.bindings.keyboard.KeyQ).toBe('up'); // column 2 = Up
    expect(s.bindings.keyboard.ArrowLeft).toBe('right'); // user override survives
    expect(s.bindings.keyboard.KeyW).toBeUndefined(); // column out of range dropped
    expect(s.bindings.keyboard.KeyE).toBeUndefined(); // not a number dropped
    expect(s.bindings.keyboard.KeyD).toBe('left'); // defaults still present
    expect(s.bindings.keyboard.Enter).toBe('confirm'); // new menu roles gained
    expect(s.bindings.keyboard.Escape).toBe('back');
  });

  it('absorbs the old gamepad-bindings store and deletes it', () => {
    const store = stubLocalStorage();
    store.set(STORAGE_KEY, JSON.stringify({ keybindings: {} }));
    store.set(LEGACY_GAMEPAD_KEY, JSON.stringify({ up: 7, back: 5, bogus: 1, down: -2 }));
    const s = loadSettings();
    expect(s.bindings.gamepad).toEqual({ up: 7, back: 5 });
    expect(store.has(LEGACY_GAMEPAD_KEY)).toBe(false); // legacy store removed
  });

  it('writes the unified shape back so the next load is native', () => {
    const store = stubLocalStorage();
    store.set(STORAGE_KEY, JSON.stringify({ keybindings: { KeyQ: 0 } }));
    store.set(LEGACY_GAMEPAD_KEY, JSON.stringify({ confirm: 4 }));
    loadSettings();
    const persisted = JSON.parse(store.get(STORAGE_KEY)!) as Record<string, unknown>;
    expect(persisted.bindings).toEqual(
      expect.objectContaining({
        keyboard: expect.objectContaining({ KeyQ: 'left' }),
        gamepad: { confirm: 4 },
      }),
    );
    expect('keybindings' in persisted).toBe(false); // old field gone
    // Second load takes the native path and agrees.
    const again = loadSettings();
    expect(again.bindings.keyboard.KeyQ).toBe('left');
    expect(again.bindings.gamepad.confirm).toBe(4);
  });

  it('does not write back on a fresh install (nothing to migrate)', () => {
    const store = stubLocalStorage();
    const s = loadSettings();
    expect(s.bindings.keyboard).toEqual(DEFAULT_KEYBOARD_BINDINGS);
    expect(s.bindings.gamepad).toEqual({});
    expect(store.has(STORAGE_KEY)).toBe(false);
  });
});

// --- one-time migration from PlayerOptions' stepline.options store (review #2)

const LEGACY_OPTS_KEY = 'stepline.options';

describe('loadSettings migrates the old stepline.options store (review #2)', () => {
  it('maps a CMod store onto scrollMode/scrollValue/bgMode, removes the key, writes back', () => {
    const store = stubLocalStorage();
    store.set(LEGACY_OPTS_KEY, JSON.stringify({ scrollType: 'C', cmod: 450, xmod: 3, bg: 0 }));
    const s = loadSettings();
    expect(s.scrollMode).toBe('C');
    expect(s.scrollValue).toBe(450);
    expect(s.bgMode).toBe('off');
    expect(store.has(LEGACY_OPTS_KEY)).toBe(false); // legacy store removed
    // Written back in the unified shape so the next load is native.
    const persisted = JSON.parse(store.get(STORAGE_KEY)!) as Record<string, unknown>;
    expect(persisted.scrollValue).toBe(450);
    expect(persisted.bgMode).toBe('off');
  });

  it('maps an XMod store, honoring the pre-rename `speed` field as an xmod fallback', () => {
    const store = stubLocalStorage();
    store.set(LEGACY_OPTS_KEY, JSON.stringify({ scrollType: 'X', cmod: 450, xmod: 3.5, bg: 2 }));
    let s = loadSettings();
    expect(s.scrollMode).toBe('X');
    expect(s.scrollValue).toBe(3.5); // xmod, not cmod
    expect(s.bgMode).toBe('full');

    store.delete(STORAGE_KEY);
    store.set(LEGACY_OPTS_KEY, JSON.stringify({ scrollType: 'X', speed: 1.5 }));
    s = loadSettings();
    expect(s.scrollValue).toBe(1.5);
  });

  it('overrides the settings store (the per-play store used to win on every START)', () => {
    const store = stubLocalStorage();
    store.set(STORAGE_KEY, JSON.stringify({ scrollMode: 'X', scrollValue: 4, bgMode: 'full' }));
    store.set(LEGACY_OPTS_KEY, JSON.stringify({ scrollType: 'C', cmod: 600, bg: 1 }));
    const s = loadSettings();
    expect(s.scrollMode).toBe('C');
    expect(s.scrollValue).toBe(600);
    expect(s.bgMode).toBe('dim');
  });

  it('clamps drifted legacy values through normalizeSettings', () => {
    const store = stubLocalStorage();
    store.set(LEGACY_OPTS_KEY, JSON.stringify({ scrollType: 'C', cmod: 999999 }));
    expect(loadSettings().scrollValue).toBe(2000);
  });

  it('an out-of-range bg index no longer poisons bgMode (old `bgMode: undefined` write)', () => {
    const store = stubLocalStorage();
    store.set(LEGACY_OPTS_KEY, JSON.stringify({ scrollType: 'C', cmod: 500, bg: 7 }));
    expect(loadSettings().bgMode).toBe(DEFAULT_SETTINGS.bgMode);
  });

  it('discards a non-object legacy value but still removes the key', () => {
    const store = stubLocalStorage();
    store.set(LEGACY_OPTS_KEY, '42');
    const s = loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(store.has(LEGACY_OPTS_KEY)).toBe(false);
  });
});
