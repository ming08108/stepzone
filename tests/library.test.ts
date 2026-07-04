import { describe, expect, it } from 'vitest';
import { loadLibraryFromFiles } from '../src/io/songFiles';

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
});
