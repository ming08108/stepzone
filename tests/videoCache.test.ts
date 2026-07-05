import { describe, expect, it } from 'vitest';
import { planEviction, videoCacheKey } from '../src/io/videoCache';
import {
  findBackgroundFile,
  findConvertibleBackground,
  isConvertibleVideo,
  type LibraryEntry,
} from '../src/io/songFiles';
import { parseSimfile } from '../src/parse/loader';

describe('videoCacheKey', () => {
  it('is stable and filename-safe', () => {
    const k = videoCacheKey('src-1', 'Songs/Pack/Song/bg.avi', 12345);
    expect(k).toBe(videoCacheKey('src-1', 'Songs/Pack/Song/bg.avi', 12345));
    expect(k).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when the source, path, or file size changes', () => {
    const base = videoCacheKey('src-1', 'a/bg.avi', 100);
    expect(videoCacheKey('src-2', 'a/bg.avi', 100)).not.toBe(base);
    expect(videoCacheKey('src-1', 'b/bg.avi', 100)).not.toBe(base);
    expect(videoCacheKey('src-1', 'a/bg.avi', 101)).not.toBe(base);
  });
});

describe('planEviction', () => {
  const entries = {
    old: { bytes: 400, lastUsed: 1 },
    mid: { bytes: 400, lastUsed: 2 },
    new: { bytes: 400, lastUsed: 3 },
  };

  it('evicts nothing when the incoming file fits', () => {
    expect(planEviction(entries, 100, 2000)).toEqual([]);
  });

  it('evicts least-recently-used first, only as much as needed', () => {
    // 1200 stored + 500 incoming vs cap 1300 → evicting `old` reaches 1300 exactly.
    expect(planEviction(entries, 500, 1300)).toEqual(['old']);
    // Cap 1200 needs two evictions (1700 → 1300 → 900).
    expect(planEviction(entries, 500, 1200)).toEqual(['old', 'mid']);
  });

  it('returns every key when the incoming file alone exceeds the cap', () => {
    expect(planEviction(entries, 5000, 1300)).toEqual(['old', 'mid', 'new']);
  });
});

describe('legacy background matching', () => {
  const ssc =
    `#TITLE:T;#ARTIST:A;#BPMS:0.000=120.000;#BACKGROUND:movie.avi;\n` +
    `#NOTEDATA:;#STEPSTYPE:dance-single;#DIFFICULTY:Hard;#METER:5;\n#NOTES:\n0000\n;\n`;

  function entryWith(names: string[]): LibraryEntry {
    return {
      song: parseSimfile(ssc, 't.ssc'),
      files: names.map((n) => new File(['x'], n)),
      sourceName: 't.ssc',
      bannerUrl: null,
    };
  }

  it('classifies convertible extensions', () => {
    expect(isConvertibleVideo('bg.avi')).toBe(true);
    expect(isConvertibleVideo('bg.MPG')).toBe(true);
    expect(isConvertibleVideo('bg.mp4')).toBe(false);
  });

  it('finds the simfile-named legacy video as convertible, not playable', () => {
    const e = entryWith(['movie.avi', 'song.ogg']);
    expect(findBackgroundFile(e)).toBeNull();
    expect(findConvertibleBackground(e)?.name).toBe('movie.avi');
  });

  it('falls back to a playable image when the named background is legacy-only', () => {
    const e = entryWith(['movie.avi', 'song-bg.png']);
    expect(findBackgroundFile(e)?.name).toBe('song-bg.png');
    expect(findConvertibleBackground(e)?.name).toBe('movie.avi');
  });

  it('finds an unreferenced folder movie (#BGCHANGES-style packs)', () => {
    // Real-world shape (e.g. "All Star"): #BACKGROUND names the static png,
    // the movie is only referenced by #BGCHANGES, which isn't parsed.
    const bgPngSsc = ssc.replace('#BACKGROUND:movie.avi;', '#BACKGROUND:All Star-bg.png;');
    const e: LibraryEntry = {
      song: parseSimfile(bgPngSsc, 't.ssc'),
      files: ['All Star-bg.png', 'All Star-jacket.png', 'All Star.avi', 'All Star.ogg'].map(
        (n) => new File(['x'], n),
      ),
      sourceName: 't.ssc',
      bannerUrl: null,
    };
    expect(findConvertibleBackground(e)?.name).toBe('All Star.avi');
    expect(findBackgroundFile(e)?.name).toBe('All Star-bg.png'); // static until converted
  });

  it('prefers a playable movie over the named static image', () => {
    const bgPngSsc = ssc.replace('#BACKGROUND:movie.avi;', '#BACKGROUND:song-bg.png;');
    const e: LibraryEntry = {
      song: parseSimfile(bgPngSsc, 't.ssc'),
      files: ['song-bg.png', 'movie.mp4'].map((n) => new File(['x'], n)),
      sourceName: 't.ssc',
      bannerUrl: null,
    };
    expect(findBackgroundFile(e)?.name).toBe('movie.mp4');
  });
});
