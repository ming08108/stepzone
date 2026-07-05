/**
 * OPFS cache for converted background videos (see io/bgVideo.ts). Browsers give
 * the whole origin ONE storage quota and evict it all-or-nothing under disk
 * pressure, so this cache manages itself: an index tracks size + last use, a
 * hard cap keeps growth bounded (LRU-evicting our own files first), and a
 * QuotaExceededError degrades to "not cached" — never to a broken library.
 * Everything is best-effort: no OPFS (or a full disk) just means backgrounds
 * stay static.
 */

const DIR_NAME = 'bg-videos';
const INDEX_NAME = 'index.json';

/** Cache cap. Converted 480p VP8 backgrounds run ~3–8 MB each. */
export const VIDEO_CACHE_CAP_BYTES = 2 * 1024 ** 3; // 2 GiB

interface IndexEntry {
  bytes: number;
  lastUsed: number;
  /** Stored filename (extension varies: remuxed mp4 vs transcoded webm). */
  name?: string;
}

/** Stored filename for an entry (older indexes predate `name`). */
function fileNameOf(key: string, e?: IndexEntry): string {
  return e?.name ?? `${key}.webm`;
}

interface CacheIndex {
  v: 1;
  entries: Record<string, IndexEntry>;
}

/**
 * Stable, filename-safe cache key for a background video: identity is the
 * source + path + size, so a re-encoded/replaced file on disk gets a new key.
 * (Two independent FNV-1a passes → 64 bits; collisions are lost-cache, not
 * corruption.)
 */
export function videoCacheKey(
  sourceId: string | undefined,
  relPath: string,
  bytes: number,
): string {
  const s = `${sourceId ?? 'adhoc'}:${relPath}:${bytes}`;
  return fnv1a(s, 0x811c9dc5) + fnv1a(s, 0x01234567);
}

function fnv1a(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Which keys to evict (least-recently-used first) so `incomingBytes` fits
 * under `cap` alongside what stays. Pure, for tests. If the incoming file
 * alone exceeds the cap, every key is returned and the caller should skip
 * caching it.
 */
export function planEviction(
  entries: Record<string, IndexEntry>,
  incomingBytes: number,
  cap: number,
): string[] {
  const keys = Object.keys(entries).sort((a, b) => entries[a].lastUsed - entries[b].lastUsed);
  let total = keys.reduce((n, k) => n + entries[k].bytes, 0) + incomingBytes;
  const evict: string[] = [];
  for (const k of keys) {
    if (total <= cap) break;
    evict.push(k);
    total -= entries[k].bytes;
  }
  return evict;
}

// --- OPFS plumbing (all failures degrade to null/no-op) -------------------------

async function cacheDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIR_NAME, { create: true });
  } catch {
    return null; // OPFS unavailable (old browser, some private modes)
  }
}

async function readIndex(dir: FileSystemDirectoryHandle): Promise<CacheIndex> {
  try {
    const fh = await dir.getFileHandle(INDEX_NAME);
    const idx = JSON.parse(await (await fh.getFile()).text()) as CacheIndex;
    if (idx && idx.v === 1 && idx.entries) return idx;
  } catch {
    /* missing/corrupt index — start fresh (files without entries get evicted) */
  }
  return { v: 1, entries: {} };
}

async function writeIndex(dir: FileSystemDirectoryHandle, idx: CacheIndex): Promise<void> {
  await writeFile(dir, INDEX_NAME, new TextEncoder().encode(JSON.stringify(idx)));
}

async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: Uint8Array,
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    // Copy: guarantees a plain-ArrayBuffer-backed view (ffmpeg.wasm output may
    // be typed over ArrayBufferLike), and these writes are rare one-time events.
    await w.write(new Uint8Array(data));
  } catch (err) {
    await w.abort().catch(() => {});
    throw err;
  }
  await w.close();
}

async function deleteEntry(
  dir: FileSystemDirectoryHandle,
  key: string,
  e?: IndexEntry,
): Promise<void> {
  try {
    await dir.removeEntry(fileNameOf(key, e));
  } catch {
    /* already gone */
  }
}

// --- Public API -----------------------------------------------------------------

/** The cached converted video, or null. Touches its LRU timestamp. */
export async function getCachedVideo(key: string): Promise<File | null> {
  const dir = await cacheDir();
  if (!dir) return null;
  try {
    const idx = await readIndex(dir);
    const fh = await dir.getFileHandle(fileNameOf(key, idx.entries[key]));
    const file = await fh.getFile();
    // Best-effort LRU touch; a failed index write never blocks playback.
    try {
      if (idx.entries[key]) {
        idx.entries[key].lastUsed = Date.now();
        await writeIndex(dir, idx);
      }
    } catch {
      /* index update is advisory */
    }
    return file;
  } catch {
    return null;
  }
}

/**
 * Store a converted video, LRU-evicting as needed to stay under the cap. On a
 * QuotaExceededError (disk genuinely full), evicts everything else and retries
 * once. False = not cached (playback can still use the bytes in memory).
 */
export async function putCachedVideo(
  key: string,
  data: Uint8Array,
  ext: 'mp4' | 'webm' = 'webm',
): Promise<boolean> {
  if (data.byteLength > VIDEO_CACHE_CAP_BYTES) return false;
  const dir = await cacheDir();
  if (!dir) return false;
  const name = `${key}.${ext}`;
  try {
    const idx = await readIndex(dir);
    for (const k of planEviction(idx.entries, data.byteLength, VIDEO_CACHE_CAP_BYTES)) {
      await deleteEntry(dir, k, idx.entries[k]);
      delete idx.entries[k];
    }
    try {
      await writeFile(dir, name, data);
    } catch (err) {
      if ((err as DOMException)?.name !== 'QuotaExceededError') return false;
      // Disk full below our cap: our other videos are the only ballast we
      // control — drop them all and try once more.
      for (const k of Object.keys(idx.entries)) {
        await deleteEntry(dir, k, idx.entries[k]);
        delete idx.entries[k];
      }
      await writeFile(dir, name, data);
    }
    idx.entries[key] = { bytes: data.byteLength, lastUsed: Date.now(), name };
    await writeIndex(dir, idx);
    return true;
  } catch {
    return false;
  }
}

/** Total size/count of cached videos, for the UI. */
export async function videoCacheStats(): Promise<{ bytes: number; count: number }> {
  const dir = await cacheDir();
  if (!dir) return { bytes: 0, count: 0 };
  const idx = await readIndex(dir);
  const keys = Object.keys(idx.entries);
  return { bytes: keys.reduce((n, k) => n + idx.entries[k].bytes, 0), count: keys.length };
}

/** Drop every converted video (they're re-derivable from the sources). */
export async function clearVideoCache(): Promise<void> {
  const dir = await cacheDir();
  if (!dir) return;
  const idx = await readIndex(dir);
  for (const k of Object.keys(idx.entries)) await deleteEntry(dir, k, idx.entries[k]);
  try {
    await writeIndex(dir, { v: 1, entries: {} });
  } catch {
    /* best effort */
  }
}
