import { describe, expect, it } from 'vitest';
import { loadLibraryFromFiles, pickPackImage } from '../src/io/songFiles';

/** A File with a folder path, like a directory pick / dropped folder provides. */
function fileAt(path: string, content: string): File {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const f = new File([content], name);
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}

const ssc = (title: string) =>
  `#TITLE:${title};\n#ARTIST:A;\n#BPMS:0.000=120.000;\n` +
  `#NOTEDATA:;\n#STEPSTYPE:dance-single;\n#DIFFICULTY:Hard;\n#METER:5;\n` +
  `#NOTES:\n0000\n1000\n0000\n0001\n;\n`;

describe('loadLibraryFromFiles (pack grouping, todo #12)', () => {
  it('parses each song folder in a pack into a separate entry', async () => {
    const files = [
      fileAt('Pack/Song One/one.ssc', ssc('Song One')),
      fileAt('Pack/Song One/one.ogg', 'fake-audio'),
      fileAt('Pack/Song Two/two.ssc', ssc('Song Two')),
      fileAt('Pack/readme.txt', 'not a song'),
    ];
    const { entries } = await loadLibraryFromFiles(files);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.song.title)).toEqual(['Song One', 'Song Two']); // sorted
    expect(entries[0].song.charts[0].stepsType).toBe('dance-single');
    expect(entries[0].files.some((f) => f.name === 'one.ogg')).toBe(true);
  });

  it('warns when no simfiles are present', async () => {
    const { entries, warnings } = await loadLibraryFromFiles([fileAt('x/readme.txt', 'hi')]);
    expect(entries).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  // Drop / <input webkitdirectory> don't pre-filter AppleDouble twins; a
  // ._one.ssc resource fork (binary, ext .ssc) must not shadow the real one.ssc.
  it('ignores AppleDouble/hidden files so the real simfile still parses', async () => {
    const files = [
      fileAt('Pack/Song One/._one.ssc', 'AppleDouble binary junk'),
      fileAt('Pack/Song One/one.ssc', ssc('Song One')),
      fileAt('Pack/Song One/._one.ogg', 'junk'),
      fileAt('Pack/Song One/one.ogg', 'fake-audio'),
    ];
    const { entries, warnings } = await loadLibraryFromFiles(files);
    expect(entries).toHaveLength(1);
    expect(entries[0].song.title).toBe('Song One');
    expect(entries[0].files.some((f) => f.name.startsWith('.'))).toBe(false);
    expect(warnings).toHaveLength(0);
  });
});

describe('pickPackImage', () => {
  const img = (name: string) => new File(['x'], name);

  // The "[22] DDR A" pack ships a real banner next to a macOS AppleDouble twin
  // (._…png) that sorts first; the resource fork isn't a decodable image.
  it('skips ._ AppleDouble images and picks the real banner', () => {
    const pick = pickPackImage([
      img('._DanceDanceRevolution A (AC) (BETA).png'),
      img('DanceDanceRevolution A (AC) (International).png'),
    ]);
    expect(pick?.name).toBe('DanceDanceRevolution A (AC) (International).png');
  });

  it('returns null when only hidden/junk files are present', () => {
    expect(pickPackImage([img('._banner.png'), img('.DS_Store')])).toBeNull();
  });

  it('prefers a background, then a banner, then any real image', () => {
    expect(pickPackImage([img('a.png'), img('pack-bg.png')])?.name).toBe('pack-bg.png');
    expect(pickPackImage([img('a.png'), img('banner.jpg')])?.name).toBe('banner.jpg');
    expect(pickPackImage([img('only.png')])?.name).toBe('only.png');
  });
});
