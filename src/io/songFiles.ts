/**
 * Load songs from user-provided files (a dropped folder / folder picker).
 * Browser-only (File API); kept out of the pure engine. Supports a single song
 * folder or a whole pack (many song subfolders): metadata + banner are parsed
 * up front; the (heavy) audio bytes are read lazily when a chart is chosen.
 */

import { parseSimfile } from '../parse/loader';
import type { Song } from '../song/song';

const AUDIO_EXT = ['.ogg', '.oga', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.opus'];

function basename(name: string): string {
  const n = name.replace(/\\/g, '/');
  return n.slice(n.lastIndexOf('/') + 1).toLowerCase();
}

function ext(name: string): string {
  const b = basename(name);
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.slice(i) : '';
}

function relPath(f: File): string {
  return f.webkitRelativePath && f.webkitRelativePath.length > 0 ? f.webkitRelativePath : f.name;
}

function dirOf(f: File): string {
  const p = relPath(f).replace(/\\/g, '/');
  return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
}

function findSimfile(files: File[]): File | undefined {
  return (
    files.find((f) => ext(f.name) === '.ssc') ??
    files.find((f) => ext(f.name) === '.sma') ??
    files.find((f) => ext(f.name) === '.sm')
  );
}

function findAudioFile(files: File[], song: Song): File | undefined {
  if (song.musicFile) {
    const want = basename(song.musicFile);
    const m = files.find((f) => basename(f.name) === want);
    if (m) return m;
  }
  return files.find((f) => AUDIO_EXT.includes(ext(f.name)));
}

function findBannerUrl(files: File[], song: Song): string | null {
  if (song.bannerFile) {
    const want = basename(song.bannerFile);
    const b = files.find((f) => basename(f.name) === want);
    if (b) return URL.createObjectURL(b);
  }
  return null;
}

// --- Drag-drop folder traversal --------------------------------------------

async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const out: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (batch.length === 0) break;
    out.push(...batch);
  }
  return out;
}

async function entryToFiles(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) =>
      (entry as FileSystemFileEntry).file(res, rej),
    );
    // Preserve the folder path so pack grouping works for dropped folders.
    try {
      Object.defineProperty(file, 'webkitRelativePath', {
        value: entry.fullPath.replace(/^\//, ''),
      });
    } catch {
      // read-only in some browsers; grouping falls back to the file name
    }
    return [file];
  }
  if (entry.isDirectory) {
    const entries = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    const nested = await Promise.all(entries.map(entryToFiles));
    return nested.flat();
  }
  return [];
}

/** Flatten a drop (files and/or dropped folders) into a flat File list. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items
    .map((it) => it.webkitGetAsEntry?.() ?? null)
    .filter((e): e is FileSystemEntry => e !== null);
  if (entries.length > 0) {
    const all = await Promise.all(entries.map(entryToFiles));
    return all.flat();
  }
  return dt.files ? Array.from(dt.files) : [];
}

// --- Library loading --------------------------------------------------------

export interface LibraryEntry {
  song: Song;
  files: File[];
  sourceName: string;
  bannerUrl: string | null;
  /** Pack (song group) this entry belongs to, when known. */
  pack?: string;
  /** Renders this entry's audio on demand (bundled starter songs). */
  synthAudio?: () => ArrayBuffer;
  /** The remembered folder source this entry came from (io/localFolder). */
  sourceId?: string;
  /** Catalog-cached display BPM ("148" / "120–160") before the simfile is parsed. */
  bpm?: string;
  /** Catalog-cached dance-single meters by slot before the simfile is parsed. */
  levels?: Array<number | null>;
  /** Song folder path for on-demand loading from its source (catalog entries). */
  lazyDir?: string;
}

/** Group files by folder and parse every song found (metadata + banner only). */
export async function loadLibraryFromFiles(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ entries: LibraryEntry[]; warnings: string[] }> {
  const warnings: string[] = [];
  const groups = new Map<string, File[]>();
  for (const f of files) {
    const dir = dirOf(f);
    const g = groups.get(dir);
    if (g) g.push(f);
    else groups.set(dir, [f]);
  }

  const entries: LibraryEntry[] = [];
  let done = 0;
  for (const [dir, groupFiles] of groups) {
    onProgress?.(++done, groups.size);
    const sim = findSimfile(groupFiles);
    if (!sim) continue;
    try {
      const song = parseSimfile(await sim.text(), sim.name);
      // Pack = the folder directly above the song folder (present when a whole
      // pack was dropped; a lone song folder has no pack context).
      const segs = dir.split('/').filter(Boolean);
      entries.push({
        song,
        files: groupFiles,
        sourceName: sim.name,
        bannerUrl: findBannerUrl(groupFiles, song),
        pack: segs.length > 1 ? segs[segs.length - 2] : undefined,
      });
    } catch (e) {
      warnings.push(`Failed to parse ${sim.name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (entries.length === 0) warnings.push('No .sm/.ssc simfiles found in the selection.');
  entries.sort((a, b) => (a.song.title || '').localeCompare(b.song.title || ''));
  return { entries, warnings };
}

/** Read (and decode-ready) the audio bytes for a library entry, or null. */
export async function readSongAudio(entry: LibraryEntry): Promise<ArrayBuffer | null> {
  if (entry.synthAudio) return entry.synthAudio();
  const f = findAudioFile(entry.files, entry.song);
  return f ? f.arrayBuffer() : null;
}

const BG_VIDEO_EXT = ['.mp4', '.webm', '.ogv', '.m4v'];
const BG_IMG_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

export function isVideoFile(name: string): boolean {
  return BG_VIDEO_EXT.includes(ext(name));
}

/** True when a filename is a browser-playable background (image or video) by extension. */
export function isPlayableBackground(name: string): boolean {
  const e = ext(name);
  return BG_VIDEO_EXT.includes(e) || BG_IMG_EXT.includes(e);
}

/** The song's background image/video File (browser-playable formats only), or null. */
export function findBackgroundFile(entry: LibraryEntry): File | null {
  const { files, song } = entry;
  let file: File | undefined;
  if (song.backgroundFile) {
    const want = basename(song.backgroundFile);
    file = files.find((f) => basename(f.name) === want);
  }
  if (!file) file = files.find((f) => /(?:-bg|background)\.[a-z0-9]+$/i.test(f.name));
  if (!file) return null;
  return isPlayableBackground(file.name) ? file : null;
}

/** Min/max BPM of a song (from its timing), for display/filtering. */
export function songBpmRange(song: Song): { min: number; max: number } {
  const bpms = song.timing.bpms.map((b) => b.bps * 60).filter((v) => v > 0);
  if (bpms.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...bpms), max: Math.max(...bpms) };
}
