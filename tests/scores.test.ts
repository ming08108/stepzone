import { afterEach, describe, expect, it } from 'vitest';
import {
  loadScores,
  mergeBest,
  recordPlay,
  totalStats,
  type ChartScore,
  type RecordInput,
} from '../src/app/scores';

const STORAGE_KEY = 'notefield.scores.v1';

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

const play = (over: Partial<RecordInput> = {}): RecordInput => ({
  percent: 0.9,
  grade: 'A',
  maxCombo: 100,
  counts: { 5: 50, 4: 10 },
  ...over,
});

const stored = (over: Partial<ChartScore> = {}): ChartScore => ({
  percent: 0.9,
  grade: 'A',
  maxCombo: 100,
  counts: { 5: 50, 4: 10 },
  plays: 3,
  updated: 1000,
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
});

describe('recordPlay (persistence round-trip)', () => {
  it('persists the merged best and accumulates plays across calls', () => {
    stubLocalStorage();
    const first = recordPlay('song·chart', play({ percent: 0.8, grade: 'B' }));
    expect(first.isNewRecord).toBe(true);

    const second = recordPlay('song·chart', play({ percent: 0.6, grade: 'C', maxCombo: 500 }));
    expect(second.isNewRecord).toBe(false);
    expect(second.best.percent).toBe(0.8);
    expect(second.best.grade).toBe('B');
    expect(second.best.maxCombo).toBe(500);
    expect(second.best.plays).toBe(2);

    const reloaded = loadScores();
    expect(reloaded['song·chart']?.percent).toBe(0.8);
    expect(reloaded['song·chart']?.plays).toBe(2);
    expect(totalStats()).toEqual({ plays: 2, charts: 1 });
  });

  it('still returns a merged result when localStorage is unavailable', () => {
    const { best, isNewRecord } = recordPlay('k', play());
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
        badCounts: { ...stored(), counts: { 5: 'many', 4: 10, x: 1 } },
      }),
    );
    const map = loadScores();
    expect(map.good).toEqual(stored());
    expect(map.notAnObject).toBeUndefined();
    expect(map.missingFields).toBeUndefined();
    expect(map.badTypes).toBeUndefined();
    // malformed count values/keys are dropped, valid ones kept
    expect(map.badCounts?.counts).toEqual({ 4: 10 });
  });
});
