import { describe, expect, it } from 'vitest';
import { loadLibraryFromFiles, type LibraryEntry } from '../src/io/songFiles';
import { Difficulty } from '../src/song/difficulty';
import { songKey } from '../src/app/favorites';
import type { ChartScore } from '../src/app/scores';
import {
  bpmText,
  buildBestsBySong,
  deriveLevels,
  entryDir,
  entryFromCatalog,
  filterSort,
  initials,
  toSongVMs,
  virtualWindow,
  type SongVM,
} from '../src/ui/songSelectModel';

/** A File with a folder path, like a directory pick / dropped folder provides. */
function fileAt(path: string, content: string): File {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const f = new File([content], name);
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}

const ssc = (title: string, bpm: string, meter: number, diff = 'Hard') =>
  `#TITLE:${title};\n#ARTIST:Artist ${title};\n#BPMS:${bpm};\n` +
  `#NOTEDATA:;\n#STEPSTYPE:dance-single;\n#DIFFICULTY:${diff};\n#METER:${meter};\n` +
  `#NOTES:\n0000\n1000\n0000\n0001\n;\n`;

async function loadOne(text: string): Promise<LibraryEntry> {
  const { entries } = await loadLibraryFromFiles([fileAt('Pack/Song/x.ssc', text)]);
  return entries[0];
}

/** A bare SongVM for filter/sort tests — only the fields those functions read. */
function vm(p: Partial<SongVM> & { title: string }): SongVM {
  return {
    entry: {} as LibraryEntry,
    key: p.key ?? p.title,
    title: p.title,
    artist: p.artist ?? '',
    pack: p.pack ?? '',
    bpm: p.bpm ?? '',
    bpmSort: p.bpmSort ?? 0,
    levels: p.levels ?? [null, null, 5, null, null],
    bests: p.bests ?? [null, null, null, null, null],
    plays: p.plays ?? 0,
  };
}

describe('bpmText', () => {
  it('renders a single BPM from the parsed song', async () => {
    const e = await loadOne(ssc('A', '0.000=150.000', 8));
    expect(bpmText(e)).toEqual({ text: '150', sort: 150 });
  });

  it('renders a range when the song changes BPM', async () => {
    const e = await loadOne(ssc('A', '0.000=120.000,16.000=240.000', 8));
    expect(bpmText(e)).toEqual({ text: '120–240', sort: 240 });
  });

  it('uses the catalog display string before the simfile is parsed', () => {
    const e = entryFromCatalog('src1', {
      dir: 'Pack/Song',
      title: 'T',
      artist: 'Ar',
      pack: 'Pack',
      bpm: '90–160',
      levels: [null, null, null, null, 12],
    });
    expect(bpmText(e)).toEqual({ text: '90–160', sort: 160 });
  });
});

describe('deriveLevels', () => {
  it('reads the dance-single meter into its difficulty slot', async () => {
    const e = await loadOne(ssc('A', '0.000=120.000', 7, 'Medium'));
    // Medium is slot 2; others empty.
    expect(deriveLevels(e.song)).toEqual([null, null, 7, null, null]);
  });
});

describe('entryFromCatalog / entryDir / initials', () => {
  it('builds a file-less entry from a catalog row', () => {
    const e = entryFromCatalog('srcX', {
      dir: 'Cool Pack/My Song',
      title: 'My Song',
      artist: 'Someone',
      pack: 'Cool Pack',
      bpm: '128',
      levels: [1, null, null, null, null],
    });
    expect(e.files).toHaveLength(0);
    expect(e.song.title).toBe('My Song');
    expect(e.song.artist).toBe('Someone');
    expect(e.sourceId).toBe('srcX');
    expect(e.lazyDir).toBe('Cool Pack/My Song');
    expect(e.sourceName).toBe('My Song');
  });

  it('derives the song folder from the first file path', async () => {
    const e = await loadOne(ssc('A', '0.000=120.000', 5));
    expect(entryDir(e)).toBe('Pack/Song');
  });

  it('takes up to two leading initials, uppercased', () => {
    expect(initials('Butterfly')).toBe('B');
    expect(initials('max 300')).toBe('M3');
    expect(initials('a b c d')).toBe('AB');
  });
});

describe('buildBestsBySong', () => {
  const score = (over: Partial<ChartScore>): ChartScore => ({
    percent: 0,
    grade: 'C',
    maxCombo: 0,
    counts: {},
    failed: false,
    plays: 1,
    updated: 0,
    title: 'T',
    artist: 'Ar',
    difficulty: Difficulty.Hard,
    meter: 8,
    ...over,
  });

  it('buckets by song + difficulty slot, keeping the highest percent', () => {
    const m = buildBestsBySong({
      a: score({ percent: 0.8, grade: 'A', difficulty: Difficulty.Hard }),
      b: score({ percent: 0.95, grade: 'S', difficulty: Difficulty.Hard }),
      c: score({ percent: 0.6, grade: 'B', difficulty: Difficulty.Beginner }),
    });
    const slots = m.get(songKey('T', 'Ar'))!;
    expect(slots[3]).toEqual({ percent: 0.95, grade: 'S', failed: false }); // Hard = slot 3, best kept
    expect(slots[0]).toEqual({ percent: 0.6, grade: 'B', failed: false }); // Beginner = slot 0
    expect(slots[2]).toBeNull();
  });
});

describe('toSongVMs', () => {
  it('joins entries with their best scores and play counts', () => {
    const entry = entryFromCatalog('s', {
      dir: 'P/S',
      title: 'Song',
      artist: 'Band',
      pack: 'P',
      bpm: '140',
      levels: [null, null, null, 9, null],
    });
    const key = songKey('Song', 'Band');
    const bests = new Map([[key, [null, null, null, { percent: 0.9, grade: 'A' }, null]]]);
    const vms = toSongVMs([entry], bests, { [key]: 3 });
    expect(vms).toHaveLength(1);
    expect(vms[0].title).toBe('Song');
    expect(vms[0].levels).toEqual([null, null, null, 9, null]); // cached catalog levels
    expect(vms[0].bests[3]).toEqual({ percent: 0.9, grade: 'A' });
    expect(vms[0].plays).toBe(3);
  });
});

describe('filterSort', () => {
  const base = {
    search: '',
    minLv: 1,
    maxLv: 20,
    favOnly: false,
    favs: new Set<string>(),
    sort: 'title' as const,
    diff: 2,
  };
  const rows = [
    vm({ title: 'Beta', artist: 'Zed', pack: 'PackB', levels: [null, null, 4, null, null] }),
    vm({ title: 'Alpha', artist: 'Yan', pack: 'PackA', levels: [null, null, 9, null, null] }),
    vm({ title: 'Gamma', artist: 'Xam', pack: '', levels: [null, null, 15, null, null] }),
  ];

  it('sorts by title A–Z', () => {
    expect(filterSort(rows, base).map((s) => s.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('groups by pack with pack-less entries last', () => {
    const out = filterSort(rows, { ...base, sort: 'pack' });
    expect(out.map((s) => s.title)).toEqual(['Alpha', 'Beta', 'Gamma']); // PackA, PackB, then packless
  });

  it('filters by search across title/artist/pack', () => {
    expect(filterSort(rows, { ...base, search: 'zed' }).map((s) => s.title)).toEqual(['Beta']);
    expect(filterSort(rows, { ...base, search: 'packa' }).map((s) => s.title)).toEqual(['Alpha']);
  });

  it('filters by the level range at any slot', () => {
    expect(filterSort(rows, { ...base, minLv: 10 }).map((s) => s.title)).toEqual(['Gamma']);
  });

  it('shows only favorites when favOnly is set', () => {
    const favs = new Set(['Alpha']);
    expect(filterSort(rows, { ...base, favOnly: true, favs }).map((s) => s.title)).toEqual([
      'Alpha',
    ]);
  });

  it('sorts by level at the selected difficulty', () => {
    const out = filterSort(rows, { ...base, sort: 'level', diff: 2 });
    expect(out.map((s) => s.levels[2])).toEqual([4, 9, 15]);
  });
});

describe('virtualWindow', () => {
  it('centers the selection away from the ends', () => {
    const w = virtualWindow(100, 440, 50, 44);
    // 50 rows above the selection, centered: off pulls the strip up.
    expect(w.off).toBeLessThan(0);
    expect(w.first).toBeLessThan(50);
    expect(w.last).toBeGreaterThan(50);
    expect(w.topFade).toBe(true);
    expect(w.botFade).toBe(true);
  });

  it('clamps at the top (no negative offset, no top fade)', () => {
    const w = virtualWindow(100, 440, 0, 44);
    expect(w.off).toBe(0);
    expect(w.first).toBe(0);
    expect(w.topFade).toBe(false);
    expect(w.botFade).toBe(true);
  });

  it('does not scroll when everything fits', () => {
    const w = virtualWindow(3, 440, 1, 44);
    expect(w.off).toBe(0);
    expect(w.first).toBe(0);
    expect(w.last).toBe(3);
    expect(w.topFade).toBe(false);
    expect(w.botFade).toBe(false);
  });
});
