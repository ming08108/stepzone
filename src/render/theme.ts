/**
 * Shared note-field render types. The per-frame renderer lives on the WebGPU
 * field (render/gpu/), which owns its own skin contract (render/gpu/skin.ts);
 * these are the presentation types both the field and the gameplay session
 * pass around — feedback, judgment styling, and note/meta descriptors.
 */

import type { TapNoteScore } from '../notes/noteTypes';

/** Seconds the receptor stays lit after a press. */
export const RECEPTOR_FLASH = 0.11;

export interface RenderMeta {
  title: string;
  subtitle: string;
  difficulty: string;
}

export interface Feedback {
  /** `white`: a W1 inside the FA+ window — rendered white by the ITG skin. */
  lastJudgment: { tns: TapNoteScore; atSeconds: number; white?: boolean } | null;
  /** Per-column time (s) of the last press, for the receptor glow. */
  laneFlash: number[];
  /** Per-column last successful hit, for the explosion. */
  laneHit: Array<{ tns: TapNoteScore; atSeconds: number; white?: boolean } | null>;
}

export interface JudgmentStyle {
  label: string;
  color: string;
}

/**
 * How a tap arrow is styled: a plain tap, a live freeze head (DDR draws them
 * green; pinned to the receptor while engaged), or a dead freeze head (grey,
 * scrolling off after a drop/miss).
 */
export type TapNoteStyle = 'tap' | 'holdHead' | 'deadHead';
