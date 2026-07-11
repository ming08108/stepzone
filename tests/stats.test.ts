import { afterEach, describe, expect, it } from 'vitest';
import { addSongPlay, addSteps, dayKey, loadStats, recordPlayEnd } from '../src/app/stats';
import { HoldNoteScore, TapNoteScore } from '../src/notes/noteTypes';

const STORAGE_KEY = 'notefield.stats.v1';

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

function persisted(store: Map<string, string>): Record<string, unknown> {
  return JSON.parse(store.get(STORAGE_KEY)!) as Record<string, unknown>;
}

/** dayKey `daysAgo` before today (local). */
function keyDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return dayKey(d);
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('loadStats sanitizes persisted JSON', () => {
  it('returns zeroed defaults when localStorage is unavailable', () => {
    expect(loadStats()).toEqual({
      steps: 0,
      songPlays: {},
      playTimeSeconds: 0,
      songsCompleted: 0,
      songsFailed: 0,
      taps: {},
      holds: {},
      bestCombo: 0,
      dailySteps: {},
    });
  });

  it('survives corrupt JSON', () => {
    const store = stubLocalStorage();
    store.set(STORAGE_KEY, '{not valid json');
    expect(loadStats().steps).toBe(0);
  });

  it('rejects non-object JSON (number / array)', () => {
    const store = stubLocalStorage();
    store.set(STORAGE_KEY, '42');
    expect(loadStats().steps).toBe(0);
    store.set(STORAGE_KEY, '[1,2,3]');
    expect(loadStats().steps).toBe(0);
  });

  it('keeps valid fields and drops malformed ones', () => {
    const store = stubLocalStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        steps: 1234.9,
        playTimeSeconds: -5, // negative -> dropped
        songsCompleted: 3,
        songsFailed: 'nope', // wrong type -> 0
        bestCombo: 250,
        songPlays: { good: 4, bad: -1, alsoBad: 'x' },
        taps: { [TapNoteScore.W1]: 10, [TapNoteScore.Miss]: 2, notANumberKey: 5, 9.5: 1 },
        holds: { [HoldNoteScore.Held]: 7, [HoldNoteScore.LetGo]: -3 },
        dailySteps: { '2026-07-01': 40, 'bad-key': 9, '2026-07-02': -1 },
      }),
    );
    const s = loadStats();
    expect(s.steps).toBe(1234); // floored
    expect(s.playTimeSeconds).toBe(0); // negative dropped
    expect(s.songsCompleted).toBe(3);
    expect(s.songsFailed).toBe(0); // wrong type -> default
    expect(s.bestCombo).toBe(250);
    expect(s.songPlays).toEqual({ good: 4 });
    expect(s.taps).toEqual({ [TapNoteScore.W1]: 10, [TapNoteScore.Miss]: 2 });
    expect(s.holds).toEqual({ [HoldNoteScore.Held]: 7 });
    expect(s.dailySteps).toEqual({ '2026-07-01': 40 });
  });
});

describe('recordPlayEnd accumulation', () => {
  it('folds one finished play into lifetime stats', () => {
    stubLocalStorage();
    recordPlayEnd({
      seconds: 90,
      failed: false,
      counts: { [TapNoteScore.W1]: 100, [TapNoteScore.Miss]: 3 },
      holdCounts: { [HoldNoteScore.Held]: 5 },
      maxCombo: 120,
    });
    const s = loadStats();
    expect(s.playTimeSeconds).toBe(90);
    expect(s.songsCompleted).toBe(1);
    expect(s.songsFailed).toBe(0);
    expect(s.taps[TapNoteScore.W1]).toBe(100);
    expect(s.holds[HoldNoteScore.Held]).toBe(5);
    expect(s.bestCombo).toBe(120);
  });

  it('accumulates across plays and tracks the best combo / fail split', () => {
    stubLocalStorage();
    recordPlayEnd({
      seconds: 60,
      failed: false,
      counts: { [TapNoteScore.W1]: 50 },
      holdCounts: { [HoldNoteScore.Held]: 2 },
      maxCombo: 200,
    });
    recordPlayEnd({
      seconds: 30,
      failed: true,
      counts: { [TapNoteScore.W1]: 20, [TapNoteScore.W2]: 10 },
      holdCounts: { [HoldNoteScore.LetGo]: 1 },
      maxCombo: 80, // lower -> bestCombo unchanged
    });
    const s = loadStats();
    expect(s.playTimeSeconds).toBe(90);
    expect(s.songsCompleted).toBe(1);
    expect(s.songsFailed).toBe(1);
    expect(s.taps[TapNoteScore.W1]).toBe(70);
    expect(s.taps[TapNoteScore.W2]).toBe(10);
    expect(s.holds[HoldNoteScore.Held]).toBe(2);
    expect(s.holds[HoldNoteScore.LetGo]).toBe(1);
    expect(s.bestCombo).toBe(200); // kept the higher of the two
  });

  it('ignores junk in the summary (NaN seconds, non-positive counts)', () => {
    stubLocalStorage();
    recordPlayEnd({
      seconds: NaN,
      failed: false,
      counts: { [TapNoteScore.W1]: 0, [TapNoteScore.W2]: -4 },
      holdCounts: {},
      maxCombo: NaN,
    });
    const s = loadStats();
    expect(s.playTimeSeconds).toBe(0);
    expect(s.bestCombo).toBe(0);
    expect(s.taps).toEqual({});
  });
});

describe('addSteps feeds steps and dailySteps', () => {
  it('increments both the lifetime counter and today bucket', () => {
    stubLocalStorage();
    addSteps(10);
    addSteps(5.9); // floored to 5
    const s = loadStats();
    expect(s.steps).toBe(15);
    expect(s.dailySteps[dayKey()]).toBe(15);
  });

  it('ignores non-positive / non-finite counts', () => {
    stubLocalStorage();
    addSteps(0);
    addSteps(-3);
    addSteps(NaN);
    const s = loadStats();
    expect(s.steps).toBe(0);
    expect(Object.keys(s.dailySteps)).toHaveLength(0);
  });
});

describe('dailySteps pruning', () => {
  it('keeps only the 90 most recent day buckets on save', () => {
    const store = stubLocalStorage();
    // Seed 100 distinct days (100 down to 1 days ago).
    const dailySteps: Record<string, number> = {};
    for (let i = 100; i >= 1; i--) dailySteps[keyDaysAgo(i)] = i;
    store.set(STORAGE_KEY, JSON.stringify({ dailySteps }));

    // addSongPlay triggers a save, which prunes.
    addSongPlay('song');

    const s = loadStats();
    const keys = Object.keys(s.dailySteps);
    expect(keys.length).toBe(90);
    // The 10 oldest (100..91 days ago) are gone; recent ones remain.
    expect(s.dailySteps[keyDaysAgo(100)]).toBeUndefined();
    expect(s.dailySteps[keyDaysAgo(91)]).toBeUndefined();
    expect(s.dailySteps[keyDaysAgo(90)]).toBe(90);
    expect(s.dailySteps[keyDaysAgo(1)]).toBe(1);
  });

  it('adds today via addSteps then prunes to 90', () => {
    const store = stubLocalStorage();
    const dailySteps: Record<string, number> = {};
    for (let i = 95; i >= 1; i--) dailySteps[keyDaysAgo(i)] = i;
    store.set(STORAGE_KEY, JSON.stringify({ dailySteps }));

    addSteps(7); // adds today's bucket -> 96 keys, then pruned to 90

    const s = loadStats();
    expect(Object.keys(s.dailySteps).length).toBe(90);
    expect(s.dailySteps[dayKey()]).toBe(7); // today survives (most recent)
    expect(persisted(store).dailySteps).toBeDefined();
  });
});
