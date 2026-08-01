/**
 * Field metrics for the DOM HUD.
 *
 * The HUD has to sit against the note field, and the field's position is
 * derived inside the renderer (gpuNoteField.computeMetrics + GpuSkin.fieldLeft).
 * Rather than let the two drift, this mirrors that math exactly — same
 * DESIGN_SIZE / MIN_DESIGN_SCALE / LANE_W, same `receptorOffset`, same
 * `fieldLeft` formula — and is the single place the HUD asks "where is the
 * field?".
 *
 * If the renderer's layout ever changes, the fieldMetrics test fails, which is
 * the point.
 */
import { DESIGN_SIZE, LANE_W, MIN_DESIGN_SCALE } from '../../render/fieldConfig';
import type { NoteSkin } from '../../game/playOptions';

/** GpuSkin.receptorOffset per skin (ddrA3Skin RECEPTOR_OFFSET / simplyLoveSkin). */
const RECEPTOR_OFFSET: Record<NoteSkin, number> = { arcade: 118, itg: 78 };

export interface FieldMetrics {
  /** Design scale — 1 at a 720px-tall canvas. */
  ds: number;
  /** Mock-to-runtime factor: the HUD is authored at ds 1.5 (1920×1080). */
  k: number;
  colW: number;
  fieldLeft: number;
  fieldWidth: number;
  fieldRight: number;
  /** Receptor centre line, in css px from the top. */
  receptorY: number;
}

export function fieldMetrics(
  width: number,
  height: number,
  numTracks: number,
  skin: NoteSkin,
  reverse: boolean,
): FieldMetrics {
  const ds = Math.max(MIN_DESIGN_SCALE, Math.min(height / DESIGN_SIZE, width / DESIGN_SIZE));
  const colW = LANE_W * ds;
  const fieldWidth = numTracks * colW;
  // ddrA3Skin.fieldLeft / simplyLoveSkin.fieldLeft (non-bare).
  const fieldLeft =
    skin === 'arcade' ? Math.max(24 * ds, 0.22 * width - fieldWidth / 2) : (width - fieldWidth) / 2;
  const off = RECEPTOR_OFFSET[skin] * ds;
  return {
    ds,
    k: ds / 1.5,
    colW,
    fieldLeft,
    fieldWidth,
    fieldRight: fieldLeft + fieldWidth,
    receptorY: reverse ? height - off : off,
  };
}
