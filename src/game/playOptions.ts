/**
 * Shared play-option vocabulary: the union types (with runtime const arrays
 * for validating persisted JSON) and the base option shape used by both the
 * persisted user Settings (src/app/settings.ts) and the engine's per-session
 * SessionConfig (src/game/session.ts). One definition, so the two can't drift.
 */

import type { Turn } from '../notes/transforms';

export { TURNS } from '../notes/transforms';
export type { Turn } from '../notes/transforms';

/** 'C' = constant (CMod), 'X' = BPM multiple (XMod), 'M' = max-BPM (MMod). */
export const SCROLL_MODES = ['C', 'X', 'M'] as const;
export type ScrollMode = (typeof SCROLL_MODES)[number];

/**
 * A practice-loop section, in beats (one measure = 4 beats). Chosen per play on
 * the Player Options screen and carried on the PlayRequest / SessionConfig —
 * intentionally NOT part of PlayOptions, so it never persists into Settings.
 */
export interface PracticeSection {
  /** First beat of the loop (inclusive). */
  startBeat: number;
  /** Beat the loop ends on (exclusive — notes here belong to the next measure). */
  endBeat: number;
}

/**
 * Practice-loop window padding (seconds): how much music plays before the
 * section on every pass, and how far past it before wrapping (so edge hits
 * still judge). ONE pair shared by gameplay (game/session.ts) and both Player
 * Options previews (audio + note field), so they all wrap the same window.
 */
export const PRACTICE_LEAD_SECONDS = 1.5;
export const PRACTICE_TAIL_SECONDS = 0.5;

/** Song background visibility during play. */
export const BG_MODES = ['off', 'dim', 'full'] as const;
export type BgMode = (typeof BG_MODES)[number];

/** Note field renderer style: 'arcade' (DDR A3) or 'itg' (Simply Love). */
export const NOTE_SKINS = ['arcade', 'itg'] as const;
export type NoteSkin = (typeof NOTE_SKINS)[number];

/**
 * Options that shape a play session. `Settings` extends this (adding the
 * persistence-only fields `bindings` and `webgpu`), and `SessionConfig` in
 * src/game/session.ts is exactly this shape — field-by-field mapping:
 *
 * | PlayOptions field | SessionConfig field | Settings field  |
 * |-------------------|---------------------|-----------------|
 * | scrollMode        | scrollMode          | scrollMode      |
 * | scrollValue       | scrollValue         | scrollValue     |
 * | musicRate         | musicRate           | musicRate       |
 * | audioOffsetMs     | audioOffsetMs       | audioOffsetMs   |
 * | visualOffsetMs    | visualOffsetMs      | visualOffsetMs  |
 * | turn              | turn                | turn            |
 * | reverse           | reverse             | reverse         |
 * | bgMode            | bgMode              | bgMode          |
 * | noteSkin          | noteSkin            | noteSkin        |
 */
export interface PlayOptions {
  /** 'C' = constant (CMod), 'X' = BPM multiple (XMod), 'M' = max-BPM (MMod). */
  scrollMode: ScrollMode;
  /** CMod/MMod: a target BPM (e.g. 550). XMod: a multiplier (e.g. 2.0). */
  scrollValue: number;
  /** Music playback rate (1 = normal; 0.75 = practice slow). */
  musicRate: number;
  /** Manual audio-sync offset in ms (positive = judge notes later). */
  audioOffsetMs: number;
  /** Visual-only offset in ms (shifts arrows, not judgment). */
  visualOffsetMs: number;
  /** Column-remap play modifier (mirror/left/right/shuffle). */
  turn: Turn;
  /** Reverse (downscroll): receptors at the bottom. */
  reverse: boolean;
  /** Song background visibility during play. */
  bgMode: BgMode;
  /** Note field renderer style. */
  noteSkin: NoteSkin;
}

export const DEFAULT_PLAY_OPTIONS: PlayOptions = {
  scrollMode: 'C',
  scrollValue: 550,
  musicRate: 1,
  audioOffsetMs: 0,
  visualOffsetMs: 0,
  turn: 'none',
  reverse: false,
  bgMode: 'dim',
  noteSkin: 'arcade',
};
