/**
 * Note-field configuration + shared design grid. The per-frame renderer now
 * lives entirely on the WebGPU field (render/gpu/gpuNoteField.ts) — both skins
 * (arcade DDR A3, ITG Simply Love) render there via GpuSkin. This module keeps
 * the config shape and the design-grid constants both the field and the layout
 * math derive from, so nothing drifts. Defaults derive from DEFAULT_PLAY_OPTIONS.
 */

import type { PlayOptions } from '../game/playOptions';
import type { RenderMeta } from './types';

export type { Feedback, RenderMeta } from './types';

// Design grid: the playfield is authored on a 720px-tall reference layout and
// scaled by ds = min(height, width) / 720. Height sets the scale; the width
// term only clamps it so the field never overruns a narrow canvas; the floor
// keeps tiny canvases legible. (Shared: the WebGPU field uses the same grid.)
export const DESIGN_SIZE = 720;
export const MIN_DESIGN_SCALE = 0.5;
/** Lane width in design px. */
export const LANE_W = 88;
/** Arrow half-extent in design px (an 80px arrow). */
export const ARROW_HALF = 40;

/**
 * Renderer configuration: the render subset of the shared PlayOptions plus
 * renderer-only knobs. Defaults derive from DEFAULT_PLAY_OPTIONS — one source
 * of truth for noteSkin/scroll fallbacks (review finding #24).
 */
export interface NoteFieldConfig extends Pick<
  PlayOptions,
  'scrollMode' | 'scrollValue' | 'reverse' | 'noteSkin'
> {
  /** Peak BPM of the chart (drives MMod); see songMaxBpm() in render/scroll.ts. */
  songMaxBpm: number;
  /** Dark-overlay alpha on the background media (0 = full brightness, 1 = black). */
  bgDim: number;
  /** With no bg media, clear to transparent so a layer behind shows. */
  transparentBg: boolean;
  /** Draw only the notefield (receptors + notes), no HUD — the Options preview. */
  bare: boolean;
  /** Per-column arrow rotation (radians); see render/columns.ts. */
  columnAngles: readonly number[];
  meta: RenderMeta;
}
