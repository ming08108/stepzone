/**
 * Song/chart resolution for versus rooms (ui/versusResolve): any-hash song
 * matching against the local library, and resolving a rival's exact pick.
 */
import { describe, expect, it } from 'vitest';
import { chartKey } from '../src/app/scores';
import type { LibraryEntry } from '../src/io/songFiles';
import {
  chartForPick,
  findSongByAnyHash,
  pickOf,
  unopenedTitleMatches,
} from '../src/ui/versusResolve';
import type { VersusSongRef } from '../src/net/versus';
import { Difficulty } from '../src/song/difficulty';
import { Song } from '../src/song/song';
import { Steps } from '../src/song/steps';

function mkChart(notes: string, diff = Difficulty.Hard, meter = 9): Steps {
  const c = new Steps();
  c.stepsType = 'dance-single';
  c.difficulty = diff;
  c.meter = meter;
  c.noteDataString = notes;
  return c;
}

function mkSong(title: string, charts: Steps[]): Song {
  const s = new Song();
  s.title = title;
  s.artist = 'A';
  s.charts = charts;
  return s;
}

const entry = (song: Song): LibraryEntry => ({ song }) as LibraryEntry;

describe('versus song resolution', () => {
  const easy = mkChart('1000\n0100\n0010\n0001', Difficulty.Easy, 3);
  const hard = mkChart('1010\n0101\n1010\n0101', Difficulty.Hard, 9);
  const song = mkSong('Target', [easy, hard]);
  const other = mkSong('Other', [mkChart('0001\n0010\n0100\n1000', Difficulty.Medium, 5)]);

  it('finds the local song by ANY advertised hash', () => {
    const entries = [entry(other), entry(song)];
    // The room advertises both charts; matching just the hard one suffices.
    const found = findSongByAnyHash(entries, [pickOf(song, hard)]);
    expect(found?.entry.song.title).toBe('Target');
    expect(found?.chart).toBe(hard); // the match doubles as the default pick
  });

  it('misses when no hash matches and skips chartless (lazy) entries', () => {
    const lazy = entry(mkSong('Lazy', []));
    expect(findSongByAnyHash([lazy, entry(other)], [pickOf(song, easy)])).toBeNull();
  });

  it('resolves a pick to the exact local chart, or null', () => {
    expect(chartForPick(song, pickOf(song, easy))).toBe(easy);
    expect(chartForPick(other, pickOf(song, easy))).toBeNull();
  });

  it('pickOf round-trips through chartKey', () => {
    expect(pickOf(song, easy).chartHash).toBe(chartKey(song, easy));
    expect(pickOf(song, easy).meter).toBe(3);
  });

  it('finds unopened catalog rows to load before a transfer (owned-but-unparsed song)', () => {
    const ref = { title: 'Target', artist: 'A', charts: [pickOf(song, hard)] } as VersusSongRef;
    const lazyTarget = { song: mkSong('Target', []), lazyDir: 'Pack/Target' } as LibraryEntry;
    const lazyOther = { song: mkSong('Other', []), lazyDir: 'Pack/Other' } as LibraryEntry;
    const loadedTarget = { song, lazyDir: 'Pack/Target' } as LibraryEntry; // already parsed
    const matches = unopenedTitleMatches([lazyTarget, lazyOther, loadedTarget, entry(other)], ref);
    // Only the unparsed, title-matching row is worth loading + re-hashing.
    expect(matches).toEqual([lazyTarget]);
    // Case-insensitive title match, but a non-catalog (no lazyDir) row is skipped.
    expect(unopenedTitleMatches([entry(mkSong('Target', []))], ref)).toEqual([]);
  });
});
