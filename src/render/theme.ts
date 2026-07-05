/**
 * The note-field theme contract. A Theme owns everything the two looks
 * actually differ in — quantization palette, judgment tiers, field layout
 * offsets, and the drawing hooks for receptors / taps / holds / mines /
 * explosions / HUD chrome — while the orchestrator (noteField.ts) owns the
 * shared per-frame passes (background, cull cursor, holds pass, note loop,
 * receptor loop, explosion timing, combo pop-state). Hooks receive a FieldView
 * (one mutable instance the renderer updates per frame — no per-frame
 * allocation) plus the read-only Judge.
 */

import type { Judge } from '../gameplay/judge';
import type { NoteType, TapNoteScore } from '../notes/noteTypes';

/** Seconds the receptor stays lit after a press (shared by all themes). */
export const RECEPTOR_FLASH = 0.11;

export interface RenderMeta {
  title: string;
  subtitle: string;
  difficulty: string;
}

export interface Feedback {
  lastJudgment: { tns: TapNoteScore; atSeconds: number } | null;
  /** Per-column time (s) of the last press, for the receptor glow. */
  laneFlash: number[];
  /** Per-column last successful hit, for the explosion. */
  laneHit: Array<{ tns: TapNoteScore; atSeconds: number } | null>;
}

export interface JudgmentStyle {
  label: string;
  color: string;
}

/**
 * How drawTapNote should style the arrow: a plain tap, a live freeze head
 * (DDR draws them green; pinned to the receptor while engaged), or a dead
 * freeze head (grey, scrolling off after a drop/miss).
 */
export type TapNoteStyle = 'tap' | 'holdHead' | 'deadHead';

/**
 * Layout + clock state shared with every theme hook. The renderer keeps one
 * instance up to date; hooks must treat it as read-only.
 */
export interface FieldView {
  /** Canvas size in css px. */
  width: number;
  height: number;
  /** Design scale: 1 at a 720px-tall canvas (clamped for narrow canvases). */
  ds: number;
  numTracks: number;
  /** Lane width, css px. */
  colW: number;
  /** Arrow half-extent, css px. */
  arrowS: number;
  /** Left edge of lane 0, css px (the active theme's fieldLeft()). */
  fieldLeft: number;
  /** Effective receptor line, css px (already flipped under reverse). */
  receptorY: number;
  reverse: boolean;
  /** Notefield-only mode (Player Options preview): HUD hooks are skipped. */
  bare: boolean;
  nowSeconds: number;
  nowBeat: number;
  /** Sawtooth beat pulse: 1 on each beat, decaying linearly to 0. */
  beatPulse: number;
  meta: RenderMeta;
  /** Center x of a lane. */
  laneX(track: number): number;
  /** Arrow rotation for a column (radians). */
  angle(track: number): number;
}

export interface Theme {
  /** Note quantization palette, keyed by NoteType. */
  readonly quantColor: Readonly<Record<NoteType, string>>;
  /** Judgment tier labels/colors, keyed by TapNoteScore. */
  readonly judgments: Readonly<Record<number, JudgmentStyle>>;
  /** Hit-explosion lifetime in seconds. */
  readonly explosionSeconds: number;
  /** Receptor distance from the field's entry edge, in design px (x ds). */
  readonly receptorOffset: number;

  /**
   * Left edge of lane 0 for this theme's layout, css px. Called on layout
   * changes (not per frame); must not read `v.fieldLeft`/`v.receptorY`.
   */
  fieldLeft(v: FieldView): number;

  /** Field backdrop (panel/filter), drawn first — even in bare mode. */
  drawFieldChrome(ctx: CanvasRenderingContext2D, v: FieldView, judge: Judge): void;

  /**
   * HUD drawn under the notes (song panel, life, score…). Skipped when bare.
   * Gets the same feedback/combo-pop state as the overlay so a theme may draw
   * its judgment/combo beneath the arrows (DDR's ComboUnderField).
   */
  drawHudUnderlay(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    judge: Judge,
    progress: number,
    fb: Feedback,
    comboPopAt: number,
  ): void;

  drawReceptor(ctx: CanvasRenderingContext2D, v: FieldView, track: number, pressed: boolean): void;

  drawTapNote(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    track: number,
    y: number,
    quant: NoteType,
    style: TapNoteStyle,
  ): void;

  drawMine(ctx: CanvasRenderingContext2D, v: FieldView, x: number, y: number): void;

  /** `roll` lets a theme restyle roll bodies (DDR draws them purple). */
  drawHoldBody(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    track: number,
    top: number,
    bottom: number,
    held: boolean,
    alive: boolean,
    roll: boolean,
  ): void;

  /** Hit explosion over the receptor; k runs 0..1 across explosionSeconds. */
  drawExplosion(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    track: number,
    tns: TapNoteScore,
    k: number,
  ): void;

  /**
   * HUD drawn over the notes (judgment/combo, and any chrome the theme stacks
   * on top). Skipped when bare. `comboPopAt` is the renderer-tracked time of
   * the last combo increment, for the pop animation.
   */
  drawHudOverlay(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    judge: Judge,
    progress: number,
    fb: Feedback,
    comboPopAt: number,
  ): void;
}
