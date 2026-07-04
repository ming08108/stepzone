/**
 * Load songs from a server, cached locally via the Cache Storage API so repeat
 * plays are instant and work offline. A song is described by a small catalog;
 * only the simfile + banner are fetched up front, and the (heavy) audio /
 * background lazily at play time. Fetched files reuse the same LibraryEntry path
 * as local folders — remote just fills `remoteDir`.
 *
 * Catalog format (JSON at any URL, e.g. https://host/pack/catalog.json):
 *   { "name": "DDR 1st Mix",
 *     "songs": [ { "dir": "Butterfly", "sm": "Butterfly.sm", "banner": "Butterfly.png" } ] }
 * `dir`/`sm`/`banner` are resolved relative to the catalog URL. The server must
 * send permissive CORS headers if it's a different origin than the app.
 */

import { parseSimfile } from '../parse/loader';
import { Song } from '../song/song';
import type { RemoteCatalog } from './catalog';
import type { LibraryEntry } from './songFiles';

const CACHE_NAME = 'notefield-songs-v1';
const BG_OK = ['.mp4', '.webm', '.ogv', '.m4v', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

/** Fetch a URL, serving from (and populating) the local cache when possible. */
export async function cachedFetch(url: string): Promise<Response> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return hit;
    const res = await fetch(url);
    if (res.ok) await cache.put(url, res.clone());
    return res;
  } catch {
    // Cache API unavailable (insecure context / private mode): fetch directly.
    return fetch(url);
  }
}

/** True once a URL is in the local cache (i.e. available offline). */
export async function isCached(url: string): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE_NAME);
    return !!(await cache.match(url));
  } catch {
    return false;
  }
}

/**
 * Load a server catalog into lightweight library entries. Only the catalog is
 * fetched (one request) — each song's simfile/banner/audio load lazily (see
 * `ensureRemoteLoaded`), so a 2000-song library appears instantly. Rows render
 * from the catalog's title/artist; charts/BPM fill in when a song is opened.
 */
export async function loadRemoteLibrary(
  catalogUrl: string,
): Promise<{ entries: LibraryEntry[]; warnings: string[]; name?: string }> {
  const warnings: string[] = [];
  const res = await cachedFetch(catalogUrl);
  if (!res.ok) throw new Error(`Catalog HTTP ${res.status} at ${catalogUrl}`);
  const cat = (await res.json()) as RemoteCatalog;
  if (!cat || !Array.isArray(cat.songs)) throw new Error('Catalog has no "songs" array.');

  const entries: LibraryEntry[] = [];
  for (const s of cat.songs) {
    if (!s || !s.sm) continue;
    // Resolve relative to the catalog's directory (URL drops the trailing
    // "catalog.json" segment); trailing slash keeps names inside the folder.
    const songDir = s.dir
      ? new URL(s.dir.replace(/\/?$/, '/'), catalogUrl).href
      : new URL('.', catalogUrl).href;
    const song = new Song();
    song.title = s.title || s.dir?.split('/').pop() || s.sm;
    song.artist = s.artist ?? '';
    entries.push({
      song, // charts empty until ensureRemoteLoaded()
      files: [],
      sourceName: s.dir ?? s.sm,
      bannerUrl: s.banner ? new URL(s.banner, songDir).href : null,
      remoteDir: songDir,
      remoteSm: s.sm,
      bpm: s.bpm,
      levels: s.levels,
    });
  }
  if (entries.length === 0) warnings.push('Catalog listed no songs.');
  return { entries, warnings, name: cat.name };
}

/** Fetch + parse a remote entry's full simfile (charts/timing). Idempotent. */
export async function ensureRemoteLoaded(entry: LibraryEntry): Promise<Song> {
  if (!entry.remoteDir || !entry.remoteSm || entry.song.charts.length > 0) return entry.song;
  const res = await cachedFetch(new URL(entry.remoteSm, entry.remoteDir).href);
  if (!res.ok) throw new Error(`Simfile HTTP ${res.status}`);
  return parseSimfile(await res.text(), entry.remoteSm);
}

/** Fetch (cached) the audio bytes for a remote entry, or null. */
export async function readRemoteAudio(entry: LibraryEntry): Promise<ArrayBuffer | null> {
  if (!entry.remoteDir || !entry.song.musicFile) return null;
  const res = await cachedFetch(new URL(entry.song.musicFile, entry.remoteDir).href);
  return res.ok ? res.arrayBuffer() : null;
}

/** Fetch (cached) the background image/video for a remote entry as a File, or null. */
export async function fetchRemoteBackground(entry: LibraryEntry): Promise<File | null> {
  const name = entry.song.backgroundFile;
  if (!entry.remoteDir || !name) return null;
  const dot = name.lastIndexOf('.');
  if (dot < 0 || !BG_OK.includes(name.slice(dot).toLowerCase())) return null;
  const res = await cachedFetch(new URL(name, entry.remoteDir).href);
  if (!res.ok) return null;
  const blob = await res.blob();
  return new File([blob], name.slice(name.replace(/\\/g, '/').lastIndexOf('/') + 1), {
    type: blob.type,
  });
}
