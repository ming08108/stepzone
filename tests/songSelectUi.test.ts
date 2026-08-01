/**
 * The song-select presentation vocabulary is deliberately pure (no React, no
 * DOM) — pin the clear-state derivation and the collection model, which drive
 * the ✓/◔/○ glyphs and the rail counts.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCollection,
  clearState,
  collectionCounts,
  packSummaries,
  sameCollection,
} from '../src/ui/songSelectUi';
import type { SongVM } from '../src/ui/songSelectModel';

const vm = (over: Partial<SongVM>): SongVM => ({
  entry: {} as SongVM['entry'],
  key: 'k',
  title: 'T',
  artist: 'A',
  pack: 'P',
  bpm: '150',
  bpmSort: 150,
  levels: [1, null, 5, null, 9],
  bests: [null, null, null, null, null],
  plays: 0,
  ...over,
});

describe('clearState', () => {
  it('a stored non-failed best at the slot is cleared', () => {
    const s = vm({ bests: [null, null, { percent: 0.6, grade: 'B', failed: false }, null, null] });
    expect(clearState(s, 2)).toBe('cleared');
  });
  it('a stored FAILED best at the slot is tried, not cleared', () => {
    const s = vm({ bests: [null, null, { percent: 0.9, grade: 'F', failed: true }, null, null] });
    expect(clearState(s, 2)).toBe('tried');
  });
  it('legacy records without the failed field read as cleared', () => {
    const s = vm({ bests: [null, null, { percent: 0.9, grade: 'A' }, null, null] });
    expect(clearState(s, 2)).toBe('cleared');
  });
  it('song-level history without a slot best is tried; no history is never', () => {
    expect(clearState(vm({ plays: 3 }), 2)).toBe('tried');
    expect(clearState(vm({}), 2)).toBe('never');
  });
});

describe('collections', () => {
  const songs = [
    vm({ key: 'a', pack: 'P1' }),
    vm({
      key: 'b',
      pack: 'P2',
      bests: [null, null, { percent: 0.5, grade: 'C', failed: false }, null, null],
    }),
    vm({ key: 'c', pack: '' }),
  ];
  const ctx = {
    favs: new Set(['a']),
    diff: 2,
  };

  it('applyCollection filters each kind consistently with collectionCounts', () => {
    const counts = collectionCounts(songs, ctx);
    expect(applyCollection(songs, { kind: 'all' }, ctx)).toHaveLength(counts.all);
    expect(applyCollection(songs, { kind: 'favorites' }, ctx)).toHaveLength(counts.favorites);
    expect(applyCollection(songs, { kind: 'uncleared' }, ctx)).toHaveLength(counts.uncleared);
    expect(applyCollection(songs, { kind: 'unplayed' }, ctx)).toHaveLength(counts.unplayed);
  });

  it('packless songs group under the — pack everywhere', () => {
    // localeCompare puts the em-dash before letters — deterministic is what matters.
    expect(packSummaries(songs).map((p) => p.pack)).toEqual(['—', 'P1', 'P2']);
    expect(applyCollection(songs, { kind: 'pack', pack: '—' }, ctx).map((s) => s.key)).toEqual([
      'c',
    ]);
  });

  it('sameCollection compares packs by name', () => {
    expect(sameCollection({ kind: 'pack', pack: 'X' }, { kind: 'pack', pack: 'X' })).toBe(true);
    expect(sameCollection({ kind: 'pack', pack: 'X' }, { kind: 'pack', pack: 'Y' })).toBe(false);
    expect(sameCollection({ kind: 'all' }, { kind: 'pack', pack: 'X' })).toBe(false);
  });
});
