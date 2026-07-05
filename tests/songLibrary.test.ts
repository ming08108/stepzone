import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  parseRange,
  pickSimfile,
  safePath,
  scanCatalog,
  SIMFILE_PREFERENCE,
} from '../scripts/songLibrary.ts';
import { loadLibraryFromFiles } from '../src/io/songFiles';

// ---------------------------------------------------------------------------
// safePath (code-review finding #4: traversal edges)
// ---------------------------------------------------------------------------

describe('safePath', () => {
  const root = resolve('/srv/songs');

  /**
   * True if a non-null result points outside `root` (the real security bar:
   * the resolved path must stay lexically inside the root). A drive-letter
   * component like `C:` may survive as a literal (nonexistent) folder name
   * inside the root — that 404s at stat time, which is safe.
   */
  const escapesRoot = (p: string | null): boolean => {
    if (p === null) return false; // rejected — safe
    return !(p === root || p.startsWith(root + sep));
  };

  it('resolves plain song paths inside the root', () => {
    expect(safePath(root, '/Pack/Song/song.sm')).toBe(join(root, 'Pack', 'Song', 'song.sm'));
    expect(safePath(root, '/banner.png')).toBe(join(root, 'banner.png'));
  });

  it('decodes percent-encoded characters in normal paths', () => {
    expect(safePath(root, '/Pack/My%20Song/song.sm')).toBe(
      join(root, 'Pack', 'My Song', 'song.sm'),
    );
  });

  it('rejects plain .. traversal', () => {
    expect(safePath(root, '/..')).toBeNull();
    expect(safePath(root, '/../secret')).toBeNull();
    expect(safePath(root, '/Pack/../../secret')).toBeNull();
  });

  it('allows .. that stays inside the root after normalization', () => {
    expect(safePath(root, '/Pack/../Other/song.sm')).toBe(join(root, 'Other', 'song.sm'));
  });

  it('rejects percent-encoded .. traversal (%2e%2e, %2f)', () => {
    expect(safePath(root, '/%2e%2e/secret')).toBeNull();
    expect(safePath(root, '/%2e%2e%2fsecret')).toBeNull();
    expect(safePath(root, '/Pack/%2E%2E/%2E%2E/secret')).toBeNull();
  });

  it('never escapes the root for absolute-path and backslash tricks', () => {
    const attacks = [
      '/C:/Windows/win.ini',
      '/C:%5CWindows%5Cwin.ini',
      '//etc/passwd',
      '/%2e%2e%5csecret', // ..\secret
      '/..%5C..%5Csecret', // ..\..\secret
      '/Pack%5C..%5C..%5Csecret',
      '/\\..\\..\\secret',
    ];
    for (const attack of attacks) {
      expect(escapesRoot(safePath(root, attack)), `escaped via ${attack}`).toBe(false);
    }
  });

  it('rejects backslash .. traversal on Windows', () => {
    if (process.platform !== 'win32') return; // '\' is a filename char on POSIX
    expect(safePath(root, '/..%5C..%5Csecret')).toBeNull();
    expect(safePath(root, '/Pack/..%5C..%5Csecret')).toBeNull();
  });

  it('rejects malformed percent-encoding instead of throwing', () => {
    expect(safePath(root, '/%zz')).toBeNull();
    expect(safePath(root, '/song%')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Range header parsing (code-review finding #4: range edges)
// ---------------------------------------------------------------------------

describe('parseRange', () => {
  const SIZE = 1000;

  it('serves the whole file when there is no Range header', () => {
    expect(parseRange(undefined, SIZE)).toBeNull();
  });

  it('parses start-end ranges', () => {
    expect(parseRange('bytes=0-99', SIZE)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=200-200', SIZE)).toEqual({ start: 200, end: 200 });
    expect(parseRange('bytes=0-999', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('parses open-ended (start-only) ranges to the end of file', () => {
    expect(parseRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=999-', SIZE)).toEqual({ start: 999, end: 999 });
  });

  it('serves suffix ranges as 0-N (documented long-standing behavior, not RFC last-N)', () => {
    expect(parseRange('bytes=-500', SIZE)).toEqual({ start: 0, end: 500 });
    expect(parseRange('bytes=-', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('flags out-of-bounds and inverted ranges as unsatisfiable (416)', () => {
    expect(parseRange('bytes=0-1000', SIZE)).toBe('unsatisfiable'); // end past EOF
    expect(parseRange('bytes=1000-', SIZE)).toBe('unsatisfiable'); // start past EOF
    expect(parseRange('bytes=500-100', SIZE)).toBe('unsatisfiable'); // inverted
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable'); // empty file
  });

  it('ignores malformed Range headers (falls back to a 200 full response)', () => {
    expect(parseRange('bytes=', SIZE)).toBeNull();
    expect(parseRange('bytes=abc', SIZE)).toBeNull();
    expect(parseRange('chars=0-100', SIZE)).toBeNull();
    expect(parseRange('garbage', SIZE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Simfile preference: catalog scanner vs browser loader (finding #9)
// ---------------------------------------------------------------------------

/** A File with a folder path, like a directory pick / dropped folder provides. */
function fileAt(path: string, content: string): File {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const f = new File([content], name);
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}

const SM_TEXT =
  '#TITLE:T;\n#ARTIST:A;\n#BPMS:0.000=120.000;\n' +
  '#NOTES:\n dance-single:\n :\n Hard:\n 5:\n :\n0000\n1000\n0000\n0001\n;\n';
const SSC_TEXT =
  '#TITLE:T;\n#ARTIST:A;\n#BPMS:0.000=120.000;\n' +
  '#NOTEDATA:;\n#STEPSTYPE:dance-single;\n#DIFFICULTY:Hard;\n#METER:5;\n' +
  '#NOTES:\n0000\n1000\n0000\n0001\n;\n';

const contentFor = (name: string): string => (name.endsWith('.ssc') ? SSC_TEXT : SM_TEXT);

describe('simfile preference (ssc > sma > sm) matches src/io/songFiles.ts', () => {
  // scripts/songLibrary.ts and src/io/songFiles.ts each pick "the" simfile of
  // a song folder. If their preference orders ever drift, the catalog and the
  // drag-drop loader would open different charts for the same folder.
  const cases: Array<{ names: string[]; expected: string }> = [
    { names: ['song.sm', 'song.sma', 'song.ssc'], expected: 'song.ssc' },
    { names: ['song.sm', 'song.sma'], expected: 'song.sma' },
    { names: ['song.sm'], expected: 'song.sm' },
    { names: ['a.sma', 'b.ssc', 'c.sm'], expected: 'b.ssc' },
  ];

  it.each(cases)('both pick $expected from $names', async ({ names, expected }) => {
    // Catalog side (scripts/songLibrary.ts).
    expect(pickSimfile(names)).toBe(expected);

    // Browser side (src/io/songFiles.ts findSimfile, via loadLibraryFromFiles).
    const files = names.map((n) => fileAt(`Song/${n}`, contentFor(n)));
    const { entries } = await loadLibraryFromFiles(files);
    expect(entries).toHaveLength(1);
    expect(entries[0].sourceName).toBe(expected);
  });

  it('preference order constant is ssc, sma, sm', () => {
    expect(SIMFILE_PREFERENCE).toEqual(['.ssc', '.sma', '.sm']);
  });
});

// ---------------------------------------------------------------------------
// scanCatalog: shared difficulty slots + missing-root warning (findings #9/#37)
// ---------------------------------------------------------------------------

describe('scanCatalog', () => {
  const tmpRoots: string[] = [];
  afterAll(() => {
    for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  });

  const makeRoot = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'notefield-songs-'));
    tmpRoots.push(dir);
    return dir;
  };

  it('maps difficulty names through the shared alias table (novice -> Beginner slot, edit folds into Challenge slot)', () => {
    const root = makeRoot();
    const songDir = join(root, 'Pack', 'Song');
    mkdirSync(songDir, { recursive: true });
    const chart = (diff: string, meter: number) =>
      `#NOTES:\n dance-single:\n :\n ${diff}:\n ${meter}:\n :\n0000\n;\n`;
    writeFileSync(
      join(songDir, 'song.sm'),
      '#TITLE:Slots;\n#ARTIST:A;\n#BPMS:0.000=150.000;\n' +
        chart('Novice', 2) +
        chart('Expert', 11) +
        chart('Edit', 13),
    );

    const cat = scanCatalog(root);
    expect(cat.count).toBe(1);
    // Slot 4 is Challenge (holds Expert/Challenge and folded-in Edit charts).
    expect(cat.songs[0].levels).toEqual([2, null, null, null, 13]);
    expect(cat.songs[0].pack).toBe('Pack');
  });

  it('warns once (not per scan) for a missing root and returns an empty catalog', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ghost = join(tmpdir(), `notefield-missing-${Date.now()}-${Math.random()}`);
      const first = scanCatalog(ghost);
      const second = scanCatalog(ghost);
      expect(first.count).toBe(0);
      expect(second.count).toBe(0);
      const hits = warn.mock.calls.filter((args) => String(args[0]).includes(ghost));
      expect(hits).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
