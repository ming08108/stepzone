/** Favorited songs, persisted to localStorage (todo #11). */

const STORAGE_KEY = 'notefield.favorites.v1';

/** A stable-ish key for a song (title + artist). */
export function songKey(title: string, artist: string): string {
  return `${title}␟${artist}`;
}

export function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

export function saveFavorites(favs: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...favs]));
  } catch {
    // ignore
  }
}
