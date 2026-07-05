import { afterEach, describe, expect, it } from 'vitest';
import { addSourceFromDrop, addSourceFromPicker } from '../src/io/localFolder';
import { loadLibraryFromFiles } from '../src/io/songFiles';

/** Minimal mock File System Access handles (what showDirectoryPicker returns). */
function fileHandle(name: string, content = 'x') {
  return { kind: 'file' as const, name, getFile: async () => new File([content], name) };
}
function dirHandle(name: string, children: unknown[]) {
  return {
    kind: 'directory' as const,
    name,
    values: async function* () {
      yield* children;
    },
  };
}

const g = globalThis as { window?: unknown };

function stubPicker(root: unknown): void {
  g.window = { showDirectoryPicker: async () => root };
}

const ssc = (title: string) =>
  `#TITLE:${title};\n#ARTIST:A;\n#BPMS:0.000=120.000;\n` +
  `#NOTEDATA:;\n#STEPSTYPE:dance-single;\n#DIFFICULTY:Hard;\n#METER:5;\n` +
  `#NOTES:\n0000\n1000\n0000\n0001\n;\n`;

afterEach(() => {
  delete g.window;
});

describe('addSourceFromPicker directory walk', () => {
  it('collects song files with webkitRelativePath rooted at the picked folder', async () => {
    stubPicker(
      dirHandle('Songs', [
        dirHandle('Pack', [
          dirHandle('Song A', [
            fileHandle('a.ssc', ssc('Song A')),
            fileHandle('a.ogg'),
            fileHandle('banner.png'),
            fileHandle('notes.txt'), // junk extension — dropped
          ]),
        ]),
        dirHandle('.git', [fileHandle('config.ssc')]), // hidden — skipped
        dirHandle('__MACOSX', [fileHandle('._a.ssc')]), // metadata — skipped
      ]),
    );
    const added = await addSourceFromPicker();
    expect(added?.id).toBeTruthy();
    expect(added?.folder.name).toBe('Songs');
    const paths = added!.folder.files.map((f) => f.webkitRelativePath).sort();
    expect(paths).toEqual([
      'Songs/Pack/Song A/a.ogg',
      'Songs/Pack/Song A/a.ssc',
      'Songs/Pack/Song A/banner.png',
    ]);
  });

  it('produces files that loadLibraryFromFiles groups into pack + song', async () => {
    stubPicker(
      dirHandle('Songs', [
        dirHandle('My Pack', [
          dirHandle('One', [fileHandle('one.ssc', ssc('One')), fileHandle('one.ogg')]),
          dirHandle('Two', [fileHandle('two.ssc', ssc('Two'))]),
        ]),
      ]),
    );
    const added = await addSourceFromPicker();
    const { entries } = await loadLibraryFromFiles(added!.folder.files);
    expect(entries.map((e) => e.song.title)).toEqual(['One', 'Two']);
    expect(entries.map((e) => e.pack)).toEqual(['My Pack', 'My Pack']);
    expect(entries[0].files.some((f) => f.name === 'one.ogg')).toBe(true);
  });

  it('stops descending past the depth cap', async () => {
    // 6 levels under the root is in; 7 levels is out.
    const deep = dirHandle('d6', [fileHandle('too-deep.ssc', ssc('Deep'))]);
    let tree: ReturnType<typeof dirHandle> = deep;
    for (let i = 5; i >= 1; i--) tree = dirHandle(`d${i}`, [tree, fileHandle(`at-${i}.ssc`)]);
    stubPicker(dirHandle('root', [tree]));
    const added = await addSourceFromPicker();
    const names = added!.folder.files.map((f) => f.name);
    expect(names).toContain('at-5.ssc'); // 6 levels deep (root/d1…d5/file)
    expect(names).not.toContain('too-deep.ssc'); // 7 levels deep
  });

  it('returns null when the picker is unavailable or canceled', async () => {
    g.window = {
      showDirectoryPicker: async () => {
        throw new DOMException('user canceled', 'AbortError');
      },
    };
    expect(await addSourceFromPicker()).toBeNull();
  });
});

describe('addSourceFromDrop', () => {
  const dropOf = (items: unknown[]) => ({ items }) as unknown as DataTransfer;

  it('adopts a single dropped directory with rooted paths', async () => {
    const item = {
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: true }),
      getAsFileSystemHandle: async () =>
        dirHandle('Pack', [dirHandle('Song', [fileHandle('s.ssc', ssc('S'))])]),
    };
    const pending = addSourceFromDrop(dropOf([item]));
    expect(pending).not.toBeNull();
    const { id, folder } = await pending!;
    expect(id).toBeTruthy();
    expect(folder.name).toBe('Pack');
    expect(folder.files.map((f) => f.webkitRelativePath)).toEqual(['Pack/Song/s.ssc']);
  });

  it('declines (synchronously) drops the legacy path must handle', () => {
    const dir = {
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: true }),
      getAsFileSystemHandle: async () => null,
    };
    expect(addSourceFromDrop(dropOf([dir, dir]))).toBeNull(); // multi-folder drop
    const loose = {
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: false }),
      getAsFileSystemHandle: async () => null,
    };
    expect(addSourceFromDrop(dropOf([loose]))).toBeNull(); // loose file
    const noHandles = { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) };
    expect(addSourceFromDrop(dropOf([noHandles]))).toBeNull(); // non-Chromium
  });
});
