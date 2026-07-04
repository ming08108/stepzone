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
import type { LibraryEntry } from './songFiles';

const CACHE_NAME = 'notefield-songs-v1';
const BG_OK = ['.mp4', '.webm', '.ogv', '.m4v', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

export interface RemoteSong {
  dir?: string;
  sm: string;
  title?: string;
  artist?: string;
  banner?: string;
}
export interface RemoteCatalog {
  name?: string;
  songs: RemoteSong[];
}

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

/** Load a server catalog into library entries (simfile + banner only). */
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
    try {
      // Resolve relative to the catalog's directory (URL replaces the
      // trailing "catalog.json" segment); ensure a trailing slash so the
      // simfile/audio names resolve inside the song folder.
      const songDir = s.dir
        ? new URL(s.dir.replace(/\/?$/, '/'), catalogUrl).href
        : new URL('.', catalogUrl).href;
      const simUrl = new URL(s.sm, songDir).href;
      const simRes = await cachedFetch(simUrl);
      if (!simRes.ok) {
        warnings.push(`${s.sm}: HTTP ${simRes.status}`);
        continue;
      }
      const song = parseSimfile(await simRes.text(), s.sm);
      let bannerUrl: string | null = null;
      const bannerName = s.banner ?? song.bannerFile;
      if (bannerName) {
        try {
          const b = await cachedFetch(new URL(bannerName, songDir).href);
          if (b.ok) bannerUrl = URL.createObjectURL(await b.blob());
        } catch {
          // banner is optional
        }
      }
      entries.push({ song, files: [], sourceName: s.dir ?? s.sm, bannerUrl, remoteDir: songDir });
    } catch (e) {
      warnings.push(`${s.sm}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (entries.length === 0 && warnings.length === 0) warnings.push('Catalog listed no songs.');
  return { entries, warnings, name: cat.name };
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
