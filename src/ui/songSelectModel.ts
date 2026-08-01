/**
 * Pure view-model logic for the song-select screen — no React, no DOM, so it is
 * unit-testable in Node. The SongSelect component owns state, effects, and
 * layout; everything here is a deterministic transform over library entries,
 * scores, and stats: building the per-row view models, bucketing best scores by
 * difficulty slot, filtering/sorting the list, and the virtualization window.
 */

import type { ChartScore } from '../app/scores';
import { songKey } from '../app/favorites';
import { difficultyToString } from '../song/difficulty';
import { Song } from '../song/song';
import { songBpmRange, type LibraryEntry } from '../io/songFiles';
import type { CatalogSong } from '../io/localFolder';
import { bestChartsPerSlot, difficultySlot } from './difficultyUi';

export const SORTS = ['title', 'artist', 'pack', 'bpm', 'level', 'best', 'plays'] as const;
export type Sort = (typeof SORTS)[number];

/** Best recorded score per difficulty slot (aligned with the 5 slot names). */
export type SlotBest = { percent: number; grade: string; failed?: boolean } | null;
export type Bests = ReadonlyArray<SlotBest>;

export const NO_BESTS: Bests = [null, null, null, null, null];

export interface SongVM {
  entry: LibraryEntry;
  /** Favorites/stats key (app/favorites songKey). */
  key: string;
  title: string;
  artist: string;
  pack: string;
  bpm: string;
  bpmSort: number;
  levels: Array<number | null>;
  /** Best recorded score per difficulty slot, aligned with levels (app/scores). */
  bests: Bests;
  /** Times a play of this song was started (app/stats). */
  plays: number;
}

export function deriveLevels(song: Song): Array<number | null> {
  return bestChartsPerSlot(song).map((c) => c?.meter ?? null);
}

export function bpmText(entry: LibraryEntry): { text: string; sort: number } {
  // Catalog entries carry a display string until their simfile is parsed.
  if (entry.bpm && entry.song.charts.length === 0) {
    const nums = entry.bpm.split('–').map(Number);
    return { text: entry.bpm, sort: nums[nums.length - 1] || 0 };
  }
  const r = songBpmRange(entry.song);
  if (r.max <= 0) return { text: '—', sort: 0 };
  const lo = Math.round(r.min);
  const hi = Math.round(r.max);
  return { text: lo === hi ? String(hi) : `${lo}–${hi}`, sort: hi };
}

/** The song folder (webkitRelativePath dir) an entry's files live in. */
export function entryDir(e: LibraryEntry): string {
  const p = e.files[0]?.webkitRelativePath ?? '';
  return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
}

/** A lightweight row from a cached catalog — real files load on demand. */
export function entryFromCatalog(sourceId: string, c: CatalogSong): LibraryEntry {
  const song = new Song();
  song.title = c.title;
  song.artist = c.artist;
  return {
    song, // charts empty until the simfile is read (see ensureLoaded)
    files: [],
    sourceName: c.dir.split('/').pop() ?? c.title,
    bannerUrl: null,
    pack: c.pack,
    sourceId,
    bpm: c.bpm,
    levels: c.levels,
    lazyDir: c.dir,
  };
}

export function initials(title: string): string {
  return title
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * Bucket saved scores into best-per-difficulty-slot, keyed by song. Records are
 * keyed by chart content hash; the song/difficulty labels stored on each record
 * say where it displays, so we bucket like the difficulty-chip stack.
 */
export function buildBestsBySong(scores: Record<string, ChartScore>): Map<string, Bests> {
  const m = new Map<string, SlotBest[]>();
  for (const s of Object.values(scores)) {
    const sk = songKey(s.title, s.artist);
    const slot = difficultySlot(difficultyToString(s.difficulty));
    const slots = m.get(sk) ?? [null, null, null, null, null];
    const prev = slots[slot];
    if (!prev || s.percent > prev.percent) {
      slots[slot] = { percent: s.percent, grade: s.grade, failed: s.failed };
    }
    m.set(sk, slots);
  }
  return m;
}

/** Build the per-row view models from library entries + scores/plays. */
export function toSongVMs(
  entries: readonly LibraryEntry[],
  bestsBySong: Map<string, Bests>,
  songPlays: Record<string, number>,
): SongVM[] {
  return entries.map((e) => {
    const b = bpmText(e);
    const title = e.song.displayFullTitle || e.sourceName;
    const key = songKey(title, e.song.artist);
    return {
      entry: e,
      key,
      title,
      artist: e.song.artist,
      pack: e.pack ?? '',
      bpm: b.text,
      bpmSort: b.sort,
      // Catalog rows carry cached levels until their simfile is parsed.
      levels: e.levels && e.song.charts.length === 0 ? e.levels : deriveLevels(e.song),
      bests: bestsBySong.get(key) ?? NO_BESTS,
      plays: songPlays[key] ?? 0,
    };
  });
}

export interface FilterSortOpts {
  search: string;
  minLv: number;
  maxLv: number;
  favOnly: boolean;
  favs: ReadonlySet<string>;
  sort: Sort;
  /** Selected difficulty slot — drives level/best sort keys. */
  diff: number;
}

/** Filter by search/level/favorites, then sort by the active column. */
export function filterSort(songs: readonly SongVM[], o: FilterSortOpts): SongVM[] {
  const q = o.search.trim().toLowerCase();
  const rows = songs.filter(
    (s) =>
      (!o.favOnly || o.favs.has(s.key)) &&
      (!q ||
        s.title.toLowerCase().includes(q) ||
        s.artist.toLowerCase().includes(q) ||
        s.pack.toLowerCase().includes(q)) &&
      s.levels.some((lv) => lv != null && lv >= o.minLv && lv <= o.maxLv),
  );
  const key: (s: SongVM) => string | number =
    o.sort === 'artist'
      ? (s) => s.artist.toLowerCase()
      : o.sort === 'pack'
        ? // Group by pack (pack-less entries last), titles A–Z inside a pack.
          // (\uffff sorts packless after every pack; \u0000 separates the keys)
          (s) => `${s.pack ? s.pack.toLowerCase() : '\uffff'}\u0000${s.title.toLowerCase()}`
        : o.sort === 'bpm'
          ? (s) => s.bpmSort
          : o.sort === 'level'
            ? (s) => s.levels[o.diff] ?? 99
            : o.sort === 'best'
              ? // Highest score at the selected difficulty first;
                // never-played songs sort last.
                (s) => -(s.bests[o.diff]?.percent ?? -1)
              : o.sort === 'plays'
                ? (s) => -s.plays // most played first
                : (s) => s.title.toLowerCase();
  return rows.slice().sort((x, y) => {
    const a = key(x);
    const b = key(y);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export interface VirtualWindow {
  /** Pixel offset of the row strip (centers the selection, clamped at ends). */
  off: number;
  /** First/last row indices to render (with a small overscan). */
  first: number;
  last: number;
  topFade: boolean;
  botFade: boolean;
}

/** Virtualized list window: center the selection, clamp at the ends. */
export function virtualWindow(
  total: number,
  viewH: number,
  sel: number,
  rowH: number,
): VirtualWindow {
  const off = Math.max(
    Math.min(viewH - total * rowH, 0),
    Math.min(0, viewH / 2 - (sel + 0.5) * rowH),
  );
  const first = Math.max(0, Math.floor(-off / rowH) - 4);
  const last = Math.min(total, Math.ceil((-off + viewH) / rowH) + 4);
  return { off, first, last, topFade: off < 0, botFade: off + total * rowH > viewH };
}
