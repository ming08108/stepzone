/**
 * Shared difficulty presentation for the UI screens: the five BEGINNER…EXPERT
 * slots (SongSelect's chip stack and level columns), the name→slot mapping
 * (Edit and anything unrecognized land on Expert), the slot color palette,
 * and the best-chart-per-slot picker that the song list, chip stack, and
 * Player Options all derive from. One copy, so the screens can't drift.
 */

import { difficultyToString } from '../song/difficulty';
import type { Song } from '../song/song';
import type { Steps } from '../song/steps';

export const DIFF_SLOT_NAMES = ['BEGINNER', 'EASY', 'MEDIUM', 'HARD', 'EXPERT'] as const;
export const DIFF_SLOT_COLORS = ['#37d5ff', '#ffcf3d', '#ff5c5c', '#59f07f', '#c86bff'] as const;

/** UI slot for a difficulty name; Edit (and anything unknown) → Expert. */
export function difficultySlot(name: string): number {
  const i = ['Beginner', 'Easy', 'Medium', 'Hard', 'Challenge'].indexOf(name);
  return i >= 0 ? i : 4;
}

/** Display color for a chart's difficulty name (the slot palette). */
export function difficultyColor(name: string): string {
  return DIFF_SLOT_COLORS[difficultySlot(name)];
}

/**
 * The playable chart per slot: dance-single charts when the song has any
 * (else everything), keeping the highest meter where a slot has several.
 */
export function bestChartsPerSlot(song: Song): Array<Steps | null> {
  const singles = song.charts.filter((c) => c.stepsType === 'dance-single');
  const use = singles.length ? singles : song.charts;
  const slots: Array<Steps | null> = [null, null, null, null, null];
  for (const c of use) {
    const s = difficultySlot(difficultyToString(c.difficulty));
    const prev = slots[s];
    if (!prev || c.meter > prev.meter) slots[s] = c;
  }
  return slots;
}
