/**
 * The library store's core invariant: every object URL it mints (entry
 * banners, pack art) is reclaimed when the owning content leaves the library.
 * These run the real parse path (loadLibraryFromFiles) with URL.create/revoke
 * stubbed, so the lifecycle is observable. The store is a module singleton —
 * each test uses its own source ids / pack names.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addFiles, libraryState, packArtUrl, subscribeLibrary } from '../src/ui/libraryStore';

/** A File with a folder path, like a directory pick / dropped folder provides. */
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

const minted: string[] = [];
const revoked: string[] = [];
let seq = 0;

beforeEach(() => {
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

describe('libraryStore', () => {
  it('loads parsed entries into the store and notifies subscribers', async () => {
    let notified = 0;
    const unsub = subscribeLibrary(() => notified++);
    await addFiles([fileAt('T1 Pack/T1 Song/song.ssc', ssc('T1 Song'))]);
    unsub();
    expect(notified).toBeGreaterThan(0);
    const titles = libraryState().entries.map((e) => e.song.title);
    expect(titles).toContain('T1 Song');
    expect(libraryState().loading).toBeNull();
  });

  it("replaces a source's entries on re-add and revokes the dropped banner URLs", async () => {
    const withBanner = (song: string) => [
      fileAt(`T2 Pack/${song}/song.ssc`, ssc(song, 'banner.png')),
      fileAt(`T2 Pack/${song}/banner.png`, 'img'),
    ];
    await addFiles(withBanner('T2 First'), 't2-src');
    const first = libraryState().entries.find((e) => e.song.title === 'T2 First');
    expect(first?.bannerUrl).toBeTruthy();

    await addFiles(withBanner('T2 Second'), 't2-src');
    const titles = libraryState().entries.map((e) => e.song.title);
    expect(titles).toContain('T2 Second');
    expect(titles).not.toContain('T2 First'); // same source id → replaced
    expect(revoked).toContain(first!.bannerUrl); // and its banner reclaimed
  });

  it('replaces (and revokes) cached pack art when a fresh scan carries new art', async () => {
    const scan = () => [
      fileAt('T3 Pack/T3 Song/song.ssc', ssc('T3 Song')),
      fileAt('T3 Pack/banner.png', 'img'), // pack-root image → pack art
    ];
    await addFiles(scan());
    const firstUrl = packArtUrl('T3 Pack');
    expect(firstUrl).toBeTruthy();

    await addFiles(scan()); // a rescan-shaped second load of the same pack
    const secondUrl = packArtUrl('T3 Pack');
    expect(secondUrl).toBeTruthy();
    expect(secondUrl).not.toBe(firstUrl); // fresh scan wins…
    expect(revoked).toContain(firstUrl); // …and the stale URL is reclaimed
  });

  it("sweeps a pack's art when its last entries leave the library", async () => {
    await addFiles(
      [fileAt('T4 Pack/T4 Song/song.ssc', ssc('T4 Song')), fileAt('T4 Pack/banner.png', 'img')],
      't4-src',
    );
    const artUrl = packArtUrl('T4 Pack');
    expect(artUrl).toBeTruthy();

    // The source's next scan has a different pack: T4 Pack's entries all drop.
    await addFiles([fileAt('T4 Other/T4 Song B/song.ssc', ssc('T4 Song B'))], 't4-src');
    expect(packArtUrl('T4 Pack')).toBeUndefined();
    expect(revoked).toContain(artUrl);
  });
});
