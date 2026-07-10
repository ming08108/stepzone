/**
 * Lifecycle paths of the library store that need the io layer under control:
 * ensureLoaded's mid-parse revoke, addFiles' removed/disabled/unknown discard
 * decisions, and requestPackArt's failure/liveness/dedup rules. The io module
 * is mocked per test; the parse path (loadLibraryFromFiles) is real. Separate
 * file from libraryStore.test.ts so that one keeps exercising the unmocked io
 * fallbacks — and because the store singleton is fresh per test file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/io/localFolder', () => ({
  addSourceFromDrop: vi.fn(() => null),
  addSourceFromPicker: vi.fn(async () => null),
  ensureSourcePermission: vi.fn(async () => false),
  grantPendingSources: vi.fn(async () => ({ granted: [], pendingNames: [] })),
  listSources: vi.fn(async () => []),
  loadCatalog: vi.fn(async () => null),
  readSongFolder: vi.fn(async () => null),
  readSource: vi.fn(async () => null),
  removeSource: vi.fn(async () => {}),
  restoreSources: vi.fn(async () => ({ granted: [], pendingNames: [] })),
  saveCatalog: vi.fn(async () => {}),
  setSourceEnabled: vi.fn(async () => {}),
  sourceState: vi.fn(async () => 'enabled'),
  supportsFolderPicker: vi.fn(() => false),
}));

import * as io from '../src/io/localFolder';
import {
  addFiles,
  ensureLoaded,
  forgetSource,
  libraryState,
  loadSource,
  packArtUrl,
  requestPackArt,
} from '../src/ui/libraryStore';

function fileAt(path: string, content: string): File {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const f = new File([content], name);
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}

const ssc = (title: string, banner?: string) =>
  `#TITLE:${title};\n#ARTIST:A;\n#BPMS:0.000=120.000;\n` +
  (banner ? `#BANNER:${banner};\n` : '') +
  `#NOTEDATA:;\n#STEPSTYPE:dance-single;\n#DIFFICULTY:Hard;\n#METER:5;\n` +
  `#NOTES:\n0000\n1000\n0000\n0001\n;\n`;

/** One song folder whose entry mints a banner URL when parsed. */
const songWithBanner = (pack: string, song: string) => [
  fileAt(`${pack}/${song}/song.ssc`, ssc(song, 'banner.png')),
  fileAt(`${pack}/${song}/banner.png`, 'img'),
];

const minted: string[] = [];
const revoked: string[] = [];
let seq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  minted.length = 0;
  revoked.length = 0;
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:test-${seq++}-${(blob as File).name ?? 'blob'}`;
    minted.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
});

describe('ensureLoaded', () => {
  it('revokes the banner of a load whose entry left the library mid-parse', async () => {
    vi.mocked(io.loadCatalog).mockResolvedValueOnce([
      { dir: 'Root/E1 Pack/E1 Song', title: 'E1 Song', artist: 'A', pack: 'E1 Pack' },
    ]);
    await loadSource('e1-src');
    const entry = libraryState().entries.find((e) => e.sourceId === 'e1-src')!;
    expect(entry.lazyDir).toBeTruthy();

    // Hold the folder read open while the source is forgotten under it.
    let release!: (files: File[]) => void;
    vi.mocked(io.readSongFolder).mockReturnValueOnce(
      new Promise((res) => {
        release = res;
      }),
    );
    const pending = ensureLoaded(entry);
    await forgetSource({ id: 'e1-src', name: 'E1', enabled: true, permission: 'granted' });
    expect(libraryState().entries.includes(entry)).toBe(false);

    release(songWithBanner('E1 Pack', 'E1 Song'));
    const result = await pending;
    expect(result).toBe(entry); // un-merged: the library moved on
    const banner = minted.find((u) => u.includes('banner.png'));
    expect(banner).toBeTruthy(); // the dead parse did mint one…
    expect(revoked).toContain(banner); // …and it was reclaimed
  });

  it('shares one parse between concurrent callers (single banner mint)', async () => {
    vi.mocked(io.loadCatalog).mockResolvedValueOnce([
      { dir: 'Root/E2 Pack/E2 Song', title: 'E2 Song', artist: 'A', pack: 'E2 Pack' },
    ]);
    await loadSource('e2-src');
    const entry = libraryState().entries.find((e) => e.sourceId === 'e2-src')!;

    const reads = vi.mocked(io.readSongFolder).mock.calls.length;
    vi.mocked(io.readSongFolder).mockResolvedValueOnce(songWithBanner('E2 Pack', 'E2 Song'));
    const [a, b] = await Promise.all([ensureLoaded(entry), ensureLoaded(entry)]);
    expect(a).toBe(b); // one shared load
    expect(a.song.charts.length).toBeGreaterThan(0);
    expect(vi.mocked(io.readSongFolder).mock.calls.length).toBe(reads + 1);
    expect(minted.filter((u) => u.includes('banner.png'))).toHaveLength(1);
  });
});

describe('addFiles removed/disabled re-check', () => {
  it('discards everything for a source removed mid-scan — no entries, no catalog, URLs reclaimed', async () => {
    vi.mocked(io.sourceState).mockResolvedValueOnce('removed');
    await addFiles(songWithBanner('R1 Pack', 'R1 Song'), 'r1-src', true);
    expect(libraryState().entries.some((e) => e.sourceId === 'r1-src')).toBe(false);
    expect(io.saveCatalog).not.toHaveBeenCalled();
    const banner = minted.find((u) => u.includes('banner.png'));
    expect(revoked).toContain(banner);
  });

  it('keeps the catalog but not the entries for a source disabled mid-scan', async () => {
    vi.mocked(io.sourceState).mockResolvedValueOnce('disabled');
    await addFiles(songWithBanner('D1 Pack', 'D1 Song'), 'd1-src', true);
    expect(libraryState().entries.some((e) => e.sourceId === 'd1-src')).toBe(false);
    expect(io.saveCatalog).toHaveBeenCalledWith(
      'd1-src',
      expect.arrayContaining([expect.objectContaining({ title: 'D1 Song' })]),
    );
    const banner = minted.find((u) => u.includes('banner.png'));
    expect(revoked).toContain(banner);
  });

  it("fails open on 'unknown' (source list unreadable): the scan is kept", async () => {
    vi.mocked(io.sourceState).mockResolvedValueOnce('unknown');
    await addFiles(songWithBanner('U1 Pack', 'U1 Song'), 'u1-src', true);
    expect(libraryState().entries.some((e) => e.sourceId === 'u1-src')).toBe(true);
    expect(io.saveCatalog).toHaveBeenCalled();
  });
});

describe('requestPackArt', () => {
  it('leaves a failed read unresolved (not "known none") so a later walk can retry', async () => {
    await addFiles([fileAt('P1 Pack/P1 Song/song.ssc', ssc('P1 Song'))]); // pack goes live
    vi.mocked(io.readSongFolder).mockResolvedValueOnce(null);
    await requestPackArt('P1 Pack', 'p1-src', 'Root/P1 Pack');
    expect(packArtUrl('P1 Pack')).toBeUndefined();

    // Retry succeeds; a concurrent second request shares the walk.
    const reads = vi.mocked(io.readSongFolder).mock.calls.length;
    let release!: (files: File[]) => void;
    vi.mocked(io.readSongFolder).mockReturnValueOnce(
      new Promise((res) => {
        release = res;
      }),
    );
    const walk = requestPackArt('P1 Pack', 'p1-src', 'Root/P1 Pack');
    const dedup = requestPackArt('P1 Pack', 'p1-src', 'Root/P1 Pack');
    release([fileAt('P1 Pack/banner.png', 'img')]);
    await Promise.all([walk, dedup]);
    expect(packArtUrl('P1 Pack')).toBeTruthy();
    expect(vi.mocked(io.readSongFolder).mock.calls.length).toBe(reads + 1);
  });

  it('does not cache art for a pack that is no longer live', async () => {
    vi.mocked(io.readSongFolder).mockResolvedValueOnce([fileAt('Ghost Pack/banner.png', 'img')]);
    const mintsBefore = minted.length;
    await requestPackArt('Ghost Pack', 'g1-src', 'Root/Ghost Pack');
    expect(packArtUrl('Ghost Pack')).toBeUndefined();
    expect(minted.length).toBe(mintsBefore); // never minted, so nothing to leak
  });
});
