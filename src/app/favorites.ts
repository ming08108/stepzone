/** Favorited songs, persisted to localStorage (todo #11). */

import { loadJson, saveJson } from './storage';

const STORAGE_KEY = 'notefield.favorites.v1';

/** A stable-ish key for a song (title + artist). */
export function songKey(title: string, artist: string): string {
  return `${title}␟${artist}`;
}

export function loadFavorites(): Set<string> {
  const parsed = loadJson<unknown>(STORAGE_KEY);
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter((v): v is string => typeof v === 'string'));
}

export function saveFavorites(favs: Set<string>): void {
  saveJson(STORAGE_KEY, [...favs]);
}
