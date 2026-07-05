/**
 * Pure note-field math, extracted from the renderer so it is unit-testable
 * (tests/scroll.test.ts): scroll position (yOf) for the C/X/M modes with
 * reverse, appearance-mod alpha (hidden/sudden), the cull predicates, the
 * forward-only visible-window cursor, and the narrow read-only view of Judge
 * note state that the renderer is allowed to see. No canvas dependencies.
 */

import type { Appearance, ScrollMode } from '../game/playOptions';
import type { ActiveNote } from '../gameplay/judge';
import { HoldNoteScore, noteRowToBeat, TapNoteType } from '../notes/noteTypes';

/** Base pixels per beat (ITG ARROW_SPACING). */
export const SPACING = 64;

/** Px beyond the field before a note is culled. */
export const DRAW_CULL = 100;

/** Shared fallback when a chart has no positive BPM to size MMod against. */
export const FALLBACK_MAX_BPM = 200;

/** Peak BPM of a chart (drives MMod), with the shared fallback. */
export function songMaxBpm(bpms: ReadonlyArray<{ bps: number }>): number {
  let max = 0;
  for (const b of bpms) max = Math.max(max, b.bps * 60);
  return max > 0 ? max : FALLBACK_MAX_BPM;
}

/**
 * Everything the scroll math needs, in one plain mutable object. The renderer
 * owns a single instance and updates it per frame / on resize; tests build
 * literals. `receptorY` is the effective receptor line (reverse applied).
 */
export interface ScrollState {
  /** C = constant px/sec, X = px/beat x multiplier, M = X scaled to peak BPM. */
  mode: ScrollMode;
  value: number;
  songMaxBpm: number;
  reverse: boolean;
  appearance: Appearance;
  /** Effective receptor line in css px (already flipped under reverse). */
  receptorY: number;
  /** Canvas height in css px. */
  height: number;
  nowSeconds: number;
  nowBeat: number;
}

/** Y position of a (time, beat) event under the current scroll state. */
export function yOf(s: ScrollState, timeSeconds: number, beatValue: number): number {
  const dir = s.reverse ? -1 : 1;
  if (s.mode === 'C') {
    const pxPerSec = (s.value / 60) * SPACING;
    return s.receptorY + dir * (timeSeconds - s.nowSeconds) * pxPerSec;
  }
  // X: multiplier is value. M: multiplier fits the peak BPM to the target.
  const mult = s.mode === 'M' ? s.value / s.songMaxBpm : s.value;
  return s.receptorY + dir * (beatValue - s.nowBeat) * SPACING * mult;
}

/** Alpha for hidden/sudden mods: 0 at the receptor (hidden) or far away (sudden). */
export function appearanceAlpha(s: ScrollState, y: number): number {
  if (s.appearance === 'visible') return 1;
  const p = Math.abs(y - s.receptorY) / Math.max(1, s.height);
  const step = (a: number, b: number, x: number) => Math.max(0, Math.min(1, (x - a) / (b - a)));
  return s.appearance === 'hidden' ? step(0.12, 0.4, p) : 1 - step(0.5, 0.78, p);
}

/** Has this y scrolled off the exit side of the field? */
export function passed(s: ScrollState, y: number): boolean {
  return s.reverse ? y > s.height + DRAW_CULL : y < -DRAW_CULL;
}

/** Is this y not yet on screen (still approaching)? */
export function notYet(s: ScrollState, y: number): boolean {
  return s.reverse ? y < -DRAW_CULL : y > s.height + DRAW_CULL;
}

/** Y of the note's last visible extent (a hold lives until its tail passes). */
export function noteEndY(s: ScrollState, n: ActiveNote): number {
  return n.note.type === TapNoteType.HoldHead
    ? yOf(s, n.tailTime, noteRowToBeat(n.tailRow))
    : yOf(s, n.time, n.beat);
}

/**
 * Advance the visible-window cursor past notes whose whole extent has scrolled
 * off the exit side. Notes are time-sorted and scroll is monotonic within a
 * play, so the cursor only moves forward — drawing stays O(visible).
 */
export function advanceCursor(s: ScrollState, notes: readonly ActiveNote[], from: number): number {
  let i = from;
  while (i < notes.length && passed(s, noteEndY(s, notes[i]))) i++;
  return i;
}

// --- Narrow read-only view of Judge note state (review finding #22) ---------
// The renderer never mutates the Judge; these helpers are the ONE place it
// reads the Judge's per-note mutable fields (hidden/tns/holdResolved/
// holdInitiated/holdLife/hns), so themes stay ignorant of the gameplay model.

/** Should the note loop draw this note (tap/mine)? Hold heads have their own
 *  lifecycle — see holdHeadState. */
export function shouldDrawNote(n: ActiveNote): boolean {
  return (
    !n.hidden && n.note.type !== TapNoteType.AutoKeysound && n.note.type !== TapNoteType.HoldHead
  );
}

/**
 * Freeze-head lifecycle for the note pass, matching DDR/StepMania:
 * - approach: scrolls toward the receptor (even after an early head hit).
 * - engaged:  hit and in progress — the head sits pinned ON the receptor.
 * - dropped:  scored LetGo/Missed — head + body grey out and scroll off.
 * - gone:     completed (Held) — nothing left to draw.
 */
export type HoldHeadState = 'approach' | 'engaged' | 'dropped' | 'gone';

export function holdHeadState(n: ActiveNote, nowSeconds: number): HoldHeadState {
  if (n.holdResolved) return n.hns === HoldNoteScore.Held ? 'gone' : 'dropped';
  if (n.holdInitiated && nowSeconds >= n.time) return 'engaged';
  return 'approach';
}

/** Should the holds pass draw this note's hold body? Live holds always;
 *  dropped/missed holds stay visible (grey) until they scroll off; completed
 *  (Held) holds vanish. */
export function shouldDrawHoldBody(n: ActiveNote): boolean {
  return n.note.type === TapNoteType.HoldHead && (!n.holdResolved || n.hns !== HoldNoteScore.Held);
}

/** Is the hold currently engaged (head hit, head time reached, not scored)?
 *  Engaged holds pin to the receptor; once scored they scroll normally. */
export function holdIsHeld(n: ActiveNote, nowSeconds: number): boolean {
  return n.holdInitiated && !n.holdResolved && nowSeconds >= n.time;
}

/** Is the hold still alive (not yet scored dead, with life remaining)? */
export function holdIsAlive(n: ActiveNote): boolean {
  return !n.holdResolved && (!n.holdInitiated || n.holdLife > 0);
}
