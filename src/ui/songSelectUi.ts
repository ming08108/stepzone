/**
 * Presentation vocabulary for the redesigned song-select screen — the ONE
 * selection treatment, the collection model, and the clear-state derivation.
 *
 * Why it exists: the old screen expressed "this is selected" three different
 * ways (pack card inset ring, song row 10% tint + 2px bar, difficulty chip
 * border) and expressed "where can I go" as a mode you enter and back out of.
 * Everything visual about focus now comes from `focusStyle()`, and every list
 * on the screen is the same thing — a filtered view of the library — described
 * by `Collection`.
 *
 * Pure: no React, no DOM, so it unit-tests in Node next to songSelectModel.
 */

import type { CSSProperties } from 'react';
import type { SongVM } from './songSelectModel';

export const AC = '#ff5d47';
export const FAV_CLR = '#ffcf3d';

/* ── the one selection treatment ─────────────────────────────────────────── */

/**
 * The single focus style, used by EVERY focusable list item on the screen
 * (rail rows, song rows, filter chips). `strong` is for the primary cursor in
 * the focused pane; the unfocused pane keeps the same shape at half strength
 * so you can still see where you left off without two cursors competing.
 */
export function focusStyle(on: boolean, strong = true): CSSProperties {
  if (!on) return { borderLeft: '3px solid transparent' };
  const a = strong ? 1 : 0.42;
  return {
    background: `linear-gradient(90deg, rgba(255,93,71,${0.26 * a}), rgba(255,93,71,${0.05 * a}))`,
    boxShadow: strong
      ? `inset 0 0 0 1px rgba(255,93,71,.55), 0 0 30px rgba(255,93,71,.15)`
      : `inset 0 0 0 1px rgba(255,93,71,.22)`,
    borderLeft: `3px solid ${strong ? AC : 'rgba(255,93,71,.45)'}`,
    color: strong ? '#fff' : '#ececec',
  };
}

/* ── clear state ─────────────────────────────────────────────────────────── */

export type ClearState = 'cleared' | 'tried' | 'never';

export const CLEAR_GLYPH: Record<ClearState, string> = {
  cleared: '✓',
  tried: '◔',
  never: '○',
};

export const CLEAR_COLOR: Record<ClearState, string> = {
  cleared: '#59f07f',
  tried: '#ffcf3d',
  never: 'rgba(236,236,236,.28)',
};

export const CLEAR_LABEL: Record<ClearState, string> = {
  cleared: 'CLEARED',
  tried: 'NOT CLEARED',
  never: 'NEVER PLAYED',
};

/**
 * Clear state for a song at a difficulty slot.
 *
 * A stored best only exists for a finished play, so a best at the slot means
 * "cleared" UNLESS the record says the play failed out. `failed` is optional
 * on purpose: records written before the field existed have no value, and an
 * old record is far more likely to be a clear than a fail — so
 * `failed !== true` reads them as cleared instead of silently demoting a whole
 * library on upgrade.
 */
export function clearState(vm: SongVM, diff: number): ClearState {
  const best = vm.bests[diff];
  if (best) return best.failed === true ? 'tried' : 'cleared';
  if (vm.plays > 0 || vm.bests.some((b) => b != null)) return 'tried';
  return 'never';
}

/* ── collections ─────────────────────────────────────────────────────────── */

export type Collection =
  | { kind: 'favorites' }
  | { kind: 'uncleared' }
  | { kind: 'unplayed' }
  | { kind: 'all' }
  | { kind: 'pack'; pack: string };

export const SMART_COLLECTIONS: ReadonlyArray<{
  kind: Exclude<Collection['kind'], 'pack'>;
  label: string;
  glyph: string;
  glyphColor: string;
}> = [
  { kind: 'favorites', label: 'Favorites', glyph: '★', glyphColor: FAV_CLR },
  { kind: 'uncleared', label: 'Not cleared', glyph: '◔', glyphColor: '#ff5c5c' },
  { kind: 'unplayed', label: 'Never played', glyph: '○', glyphColor: 'rgba(236,236,236,.4)' },
  { kind: 'all', label: 'All songs', glyph: '≡', glyphColor: 'rgba(236,236,236,.4)' },
];

export function collectionLabel(c: Collection): string {
  if (c.kind === 'pack') return c.pack;
  return SMART_COLLECTIONS.find((s) => s.kind === c.kind)?.label ?? 'All songs';
}

export function sameCollection(a: Collection, b: Collection): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'pack' || a.pack === (b as { pack: string }).pack;
}

/** How many songs each smart collection would show — the rail's count badges. */
export interface CollectionCounts {
  favorites: number;
  uncleared: number;
  unplayed: number;
  all: number;
}

/**
 * Apply a collection to an already-filtered song list. Kept separate from
 * `filterSort` so search / level range / sort stay orthogonal: a collection
 * narrows WHICH songs, the filter strip narrows WHICH of those, and neither is
 * a mode you have to leave.
 */
export function applyCollection(
  songs: readonly SongVM[],
  c: Collection,
  ctx: { favs: ReadonlySet<string>; diff: number },
): SongVM[] {
  switch (c.kind) {
    case 'all':
      return songs.slice();
    case 'pack':
      return songs.filter((s) => (s.pack || '—') === c.pack);
    case 'favorites':
      return songs.filter((s) => ctx.favs.has(s.key));
    case 'unplayed':
      return songs.filter((s) => clearState(s, ctx.diff) === 'never');
    case 'uncleared':
      return songs.filter((s) => clearState(s, ctx.diff) === 'tried');
  }
}

export function collectionCounts(
  songs: readonly SongVM[],
  ctx: { favs: ReadonlySet<string>; diff: number },
): CollectionCounts {
  let favorites = 0;
  let uncleared = 0;
  let unplayed = 0;
  for (const s of songs) {
    if (ctx.favs.has(s.key)) favorites++;
    const st = clearState(s, ctx.diff);
    if (st === 'tried') uncleared++;
    else if (st === 'never') unplayed++;
  }
  return {
    favorites,
    uncleared,
    unplayed,
    all: songs.length,
  };
}

/** Pack name + song count, A→Z, from the filtered list. */
export function packSummaries(songs: readonly SongVM[]): { pack: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of songs) {
    const p = s.pack || '—';
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([pack, count]) => ({ pack, count }));
}

/**
 * A distinctive, deterministic gradient for a pack/song with no art. Unchanged
 * from the old screen — kept here so the rail, the inspector and the row
 * placeholders all pull the same one.
 */
export function artGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (a + 42) % 360;
  return (
    `radial-gradient(135% 130% at 16% -10%, hsl(${a} 62% 34%) 0%, transparent 58%),` +
    `linear-gradient(140deg, hsl(${a} 44% 21%) 0%, hsl(${b} 50% 11%) 100%)`
  );
}
