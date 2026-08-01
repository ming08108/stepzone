import { afterEach, describe, expect, it } from 'vitest';
import {
  chartKey,
  loadScores,
  mergeBest,
  recordPlay,
  totalStats,
  type ChartScore,
  type RecordInput,
} from '../src/app/scores';
import { Song } from '../src/song/song';
import { Steps } from '../src/song/steps';
import { Difficulty } from '../src/song/difficulty';

const STORAGE_KEY = 'notefield.scores.v2';

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

function mkSong(title = 'Song', artist = 'Artist', subtitle = ''): Song {
  const s = new Song();
  s.title = title;
  s.artist = artist;
  s.subtitle = subtitle;
  return s;
}

function mkChart(notes = '1000\n0100\n0010\n0001', diff = Difficulty.Hard, meter = 9): Steps {
  const c = new Steps();
  c.stepsType = 'dance-single';
  c.difficulty = diff;
  c.meter = meter;
  c.noteDataString = notes;
  return c;
}

const play = (over: Partial<RecordInput> = {}): RecordInput => ({
  percent: 0.9,
  grade: 'A',
  maxCombo: 100,
  counts: { 5: 50, 4: 10 },
  failed: false,
  ...over,
});

const stored = (over: Partial<ChartScore> = {}): ChartScore => ({
  percent: 0.9,
  grade: 'A',
  maxCombo: 100,
  counts: { 5: 50, 4: 10 },
  failed: false,
  plays: 3,
  updated: 1000,
  title: 'Song',
  artist: 'Artist',
  difficulty: Difficulty.Hard,
  meter: 9,
  ...over,
});

describe('mergeBest (pure best-merge policy, review #4)', () => {
  it('first play is always a new record and starts plays at 1', () => {
    const { best, isNewRecord } = mergeBest(undefined, play(), 42);
    expect(isNewRecord).toBe(true);
    expect(best.percent).toBe(0.9);
    expect(best.grade).toBe('A');
    expect(best.maxCombo).toBe(100);
    expect(best.counts).toEqual({ 5: 50, 4: 10 });
    expect(best.plays).toBe(1);
    expect(best.updated).toBe(42);
  });

  it('a strictly better percent is a NEW RECORD: grade + counts follow it', () => {
    const prev = stored({ percent: 0.8, grade: 'B', counts: { 5: 40 } });
    const r = play({ percent: 0.95, grade: 'S', counts: { 5: 60 } });
    const { best, isNewRecord } = mergeBest(prev, r);
    expect(isNewRecord).toBe(true);
    expect(best.percent).toBe(0.95);
    expect(best.grade).toBe('S');
    expect(best.counts).toEqual({ 5: 60 });
    expect(best.plays).toBe(4);
  });

  it('a worse percent keeps the stored percent, grade, and counts', () => {
    const prev = stored({ percent: 0.95, grade: 'S', counts: { 5: 60 } });
    const r = play({ percent: 0.7, grade: 'C', counts: { 5: 20 } });
    const { best, isNewRecord } = mergeBest(prev, r);
    expect(isNewRecord).toBe(false);
    expect(best.percent).toBe(0.95);
    expect(best.grade).toBe('S');
    expect(best.counts).toEqual({ 5: 60 });
    expect(best.plays).toBe(4);
  });

  it('a tied percent is NOT a new record and keeps the stored grade/counts', () => {
    const prev = stored({ percent: 0.9, grade: 'A+', counts: { 5: 55 } });
    const r = play({ percent: 0.9, grade: 'A', counts: { 5: 50 } });
    const { best, isNewRecord } = mergeBest(prev, r);
    expect(isNewRecord).toBe(false);
    expect(best.grade).toBe('A+');
    expect(best.counts).toEqual({ 5: 55 });
  });

  it('maxCombo merges as an independent best (higher combo on a worse play sticks)', () => {
    const prev = stored({ percent: 0.95, maxCombo: 120 });
    const r = play({ percent: 0.5, maxCombo: 300 });
    const { best, isNewRecord } = mergeBest(prev, r);
    expect(isNewRecord).toBe(false);
    expect(best.maxCombo).toBe(300); // best combo kept...
    expect(best.percent).toBe(0.95); // ...while percent stays the stored best
  });

  it('always increments plays and stamps updated', () => {
    const { best } = mergeBest(stored({ plays: 7 }), play({ percent: 0 }), 123456);
    expect(best.plays).toBe(8);
    expect(best.updated).toBe(123456);
  });

  it('failed follows the better percent, like grade', () => {
    // A failed run with a higher percent replaces a clear: the record is a fail.
    const up = mergeBest(
      stored({ percent: 0.8, failed: false }),
      play({ percent: 0.9, failed: true }),
    );
    expect(up.best.failed).toBe(true);
    // A worse failed run does not taint a stored clear.
    const down = mergeBest(
      stored({ percent: 0.9, failed: false }),
      play({ percent: 0.5, failed: true }),
    );
    expect(down.best.failed).toBe(false);
  });
});

describe('recordPlay (persistence round-trip)', () => {
  it('persists the merged best and accumulates plays across calls', () => {
    stubLocalStorage();
    const song = mkSong();
    const chart = mkChart();
    const first = recordPlay(song, chart, play({ percent: 0.8, grade: 'B' }));
    expect(first.isNewRecord).toBe(true);

    const second = recordPlay(song, chart, play({ percent: 0.6, grade: 'C', maxCombo: 500 }));
    expect(second.isNewRecord).toBe(false);
    expect(second.best.percent).toBe(0.8);
    expect(second.best.grade).toBe('B');
    expect(second.best.maxCombo).toBe(500);
    expect(second.best.plays).toBe(2);

    const key = chartKey(song, chart);
    const reloaded = loadScores();
    expect(reloaded[key]?.percent).toBe(0.8);
    expect(reloaded[key]?.plays).toBe(2);
    expect(totalStats()).toEqual({ plays: 2, charts: 1 });
  });

  it('keys by chart content: a retitled song keeps its record, labels refresh', () => {
    stubLocalStorage();
    const chart = mkChart();
    recordPlay(mkSong('Old Title'), chart, play({ percent: 0.8 }));
    const after = recordPlay(
      mkSong('New Title', 'Artist', '[RESYNC]'),
      chart,
      play({ percent: 0.7 }),
    );
    expect(after.best.plays).toBe(2); // same record continued...
    expect(after.best.percent).toBe(0.8);
    expect(after.best.title).toBe('New Title [RESYNC]'); // ...under the fresh labels
    expect(Object.keys(loadScores())).toHaveLength(1);
  });

  it('stores the song/chart labels the UI groups by', () => {
    stubLocalStorage();
    const song = mkSong('Bills', 'Lunchmoney Lewis', '[HELLRAZOR SYNC VER.]');
    const chart = mkChart('1000\n0001', Difficulty.Challenge, 12);
    recordPlay(song, chart, play());
    const rec = loadScores()[chartKey(song, chart)];
    expect(rec?.title).toBe('Bills [HELLRAZOR SYNC VER.]');
    expect(rec?.artist).toBe('Lunchmoney Lewis');
    expect(rec?.difficulty).toBe(Difficulty.Challenge);
    expect(rec?.meter).toBe(12);
  });

  it('different note content records separately', () => {
    stubLocalStorage();
    const song = mkSong();
    recordPlay(song, mkChart('1000\n0100'), play());
    recordPlay(song, mkChart('0010\n0001'), play());
    expect(totalStats()).toEqual({ plays: 2, charts: 2 });
  });

  it('still returns a merged result when localStorage is unavailable', () => {
    const { best, isNewRecord } = recordPlay(mkSong(), mkChart(), play());
    expect(isNewRecord).toBe(true);
    expect(best.plays).toBe(1);
  });
});

describe('loadScores validates persisted JSON (review #13)', () => {
  it('returns {} for corrupt or non-object JSON', () => {
    const store = stubLocalStorage();
    store.set(STORAGE_KEY, '{oops');
    expect(loadScores()).toEqual({});
    store.set(STORAGE_KEY, '[1,2]');
    expect(loadScores()).toEqual({});
  });

  it('filters malformed entries but keeps well-formed ones', () => {
    const store = stubLocalStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        good: stored(),
        notAnObject: 5,
        missingFields: { percent: 0.5 },
        badTypes: { ...stored(), percent: 'high' },
        missingLabels: { ...stored(), title: undefined },
        badCounts: { ...stored(), counts: { 5: 'many', 4: 10, x: 1 } },
      }),
    );
    const map = loadScores();
    expect(map.good).toEqual(stored());
    expect(map.notAnObject).toBeUndefined();
    expect(map.missingFields).toBeUndefined();
    expect(map.badTypes).toBeUndefined();
    expect(map.missingLabels).toBeUndefined();
    // malformed count values/keys are dropped, valid ones kept
    expect(map.badCounts?.counts).toEqual({ 4: 10 });
  });
});
