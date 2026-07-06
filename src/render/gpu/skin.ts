/**
 * GPU-skin contract. The WebGPU note field (gpuNoteField.ts) owns the shared
 * mechanics — scroll math, the forward-only cull cursor, the receptor/hold/
 * note/explosion loops, the three batches, and the render-pass encode — and
 * delegates every bit of ART to a GpuSkin: the arcade DDR A3 look
 * (ddrA3Skin.ts) or Simply Love / ITG (simplyLoveSkin.ts). This mirrors the
 * 2D renderer's Theme split (render/theme.ts), so the two skins draw with the
 * same pass order the canvas orchestrator used:
 *
 *   chrome → hudUnderlay → [beat lines] → receptors → holds → notes →
 *   explosions → hudOverlay
 *
 * A3 draws its gauge/panels in hudOverlay (over the arrows, which scroll in
 * under the gauge); SL draws its side panel + density graph in hudUnderlay
 * (before the notes). Both draw judgment/combo in hudOverlay.
 *
 * Skins receive a SkinCtx each call — a per-frame snapshot of the field's
 * rendering primitives and layout — so they never hold stale batch/atlas refs
 * across the atlas rebuilds (dpr / 4K changes) the field does.
 */

import type { Judge } from '../../gameplay/judge';
import type { NoteType } from '../../notes/noteTypes';
import type { RenderMeta, TapNoteStyle, Feedback } from '../theme';
import type { AtlasRect, GpuAtlas } from './atlas';
import type { GlyphBank } from './glyphs';
import type { QuadBatch } from './quads';
import type { ShapeBatch } from './shapes';

/** The field's rendering primitives + current layout, handed to skin hooks. */
export interface SkinCtx {
  /** Field-layer textured quads (background through explosions). */
  readonly batch: QuadBatch;
  /** HUD text/digits, flushed after the shape backgrounds so they sit on top. */
  readonly hud: QuadBatch;
  /** HUD background geometry drawn OVER the notes (A3 gauge/panels, SL side
   *  panel — which sits beside the field, so over is fine). */
  readonly shapes: ShapeBatch;
  /** Geometry drawn UNDER the notes (SL's field filter + density graph, which
   *  the notes scroll over). Flushed before the note batch. */
  readonly underShapes: ShapeBatch;
  readonly atlas: GpuAtlas;
  readonly glyphs: GlyphBank;
  readonly ds: number;
  /** Lane width / arrow half-extent, css px. */
  readonly colW: number;
  readonly arrowS: number;
  readonly fieldLeft: number;
  readonly receptorY: number;
  readonly numTracks: number;
  readonly width: number;
  readonly height: number;
  readonly reverse: boolean;
  readonly meta: RenderMeta;
  laneX(track: number): number;
  angle(track: number): number;
  /** A shared 4×4 white sprite (solid fills / gradient-tinted quads). */
  white(): AtlasRect | null;
}

export interface GpuSkin {
  /** Receptor distance from the field's entry edge, in design px (× ds). */
  readonly receptorOffset: number;
  /** Hit-explosion lifetime, seconds. */
  readonly explosionSeconds: number;
  /** Draw scrolling beat/measure guide lines (arcade yes, ITG no). */
  readonly beatLines: boolean;

  /** Left edge of lane 0, css px (bare = centered preview). */
  fieldLeft(bare: boolean, width: number, numTracks: number, colW: number, ds: number): number;

  /** Field backdrop (lane filter, danger wash) — drawn even in bare mode. */
  chrome(ctx: SkinCtx, judge: Judge, beatPulse: number): void;

  /** HUD drawn UNDER the notes (SL's side panel + density graph; A3: none). */
  hudUnderlay(ctx: SkinCtx, judge: Judge, progress: number, now: number, beatPulse: number): void;

  receptor(ctx: SkinCtx, track: number, pressed: boolean, beatPulse: number): void;

  hold(
    ctx: SkinCtx,
    track: number,
    top: number,
    bottom: number,
    held: boolean,
    alive: boolean,
    roll: boolean,
    beatPulse: number,
  ): void;

  /** Tap or hold head (not mine — that's mine()). */
  note(
    ctx: SkinCtx,
    track: number,
    y: number,
    quant: NoteType,
    style: TapNoteStyle,
    now: number,
    beat: number,
    beatPulse: number,
  ): void;

  mine(ctx: SkinCtx, x: number, y: number, now: number, beatPulse: number): void;

  explosion(ctx: SkinCtx, track: number, tns: number, k: number): void;

  /** HUD drawn OVER the notes: judgment + combo (both skins), and A3's
   *  gauge/panels. */
  hudOverlay(
    ctx: SkinCtx,
    judge: Judge,
    progress: number,
    fb: Feedback,
    now: number,
    beatPulse: number,
    comboPopAt: number,
  ): void;

  /** Bake every sprite variant up front (called from the field's prewarm). */
  prewarm(ctx: SkinCtx): void;

  /** Drop cached per-skin state (atlas rebuild / design-scale change). */
  clear(): void;
}
