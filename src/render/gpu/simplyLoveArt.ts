/**
 * Simply Love (ITGmania) procedural art — the 'itg' noteSkin's palette, cel
 * noteskin geometry, and the exported paint functions the WebGPU field bakes
 * into its atlas (render/gpu/simplyLoveSkin.ts). The canvas Theme class that
 * once drove these was removed — both skins render on WebGPU now.
 */

import { NoteType, TapNoteScore } from '../../notes/noteTypes';
import type { JudgmentStyle } from '../types';

// ITG note quantization palette (classic StepMania/ITG noteskin colors).
export const ITG_QUANT_COLOR: Record<NoteType, string> = {
  [NoteType.N4TH]: '#ff2f2f',
  [NoteType.N8TH]: '#3d7bff',
  [NoteType.N12TH]: '#c44cff',
  [NoteType.N16TH]: '#41d94b',
  [NoteType.N24TH]: '#ff5fdd',
  [NoteType.N32ND]: '#ffa93d',
  [NoteType.N48TH]: '#3df0ff',
  [NoteType.N64TH]: '#9aa0a8',
  [NoteType.N192ND]: '#9aa0a8',
};

// ITG judgment tiers: title-case labels in the SL.JudgmentColors["ITG"] set.
export const ITG_JUDGMENT: Record<number, JudgmentStyle> = {
  [TapNoteScore.W1]: { label: 'Fantastic', color: '#21cce8' },
  [TapNoteScore.W2]: { label: 'Excellent', color: '#e29c18' },
  [TapNoteScore.W3]: { label: 'Great', color: '#66c955' },
  [TapNoteScore.W4]: { label: 'Decent', color: '#b45cff' },
  [TapNoteScore.W5]: { label: 'Way Off', color: '#c9855e' },
  [TapNoteScore.Miss]: { label: 'Miss', color: '#ff3030' },
  [TapNoteScore.HitMine]: { label: 'Mine!', color: '#ff3030' },
};

export const ITG_EXPLOSION = 0.22; // seconds for the cel-style hit explosion bloom
export const SL_JUDGMENT_LIFE = 0.9; // SL judgment tween: pop 0.1s, hold ~0.67s, shrink 0.2s

// Simply Love palette bits used by the ITG-style HUD.
export const SL_ACCENT = '#ff5d47'; // SL.Colors[1] — the signature coral
export const SL_GRAPH_BG = '#1e282f'; // density-graph backing (SL UpperNPSGraph quad)
export const SL_GRAPH_LO = '#00adc0'; // histogram base color (SL-Histogram "blue")
export const SL_GRAPH_HI = '#8200a1'; // histogram peak color (SL-Histogram "purple")
// SL full-combo pulse pairs (Player combo.lua): all-Fantastic blue,
// all-Excellent gold, all-Great green; anything less is plain white.
export const SL_COMBO_W1: readonly [string, string] = ['#c8ffff', '#6bf0ff'];
export const SL_COMBO_W2: readonly [string, string] = ['#fdffc9', '#fddb85'];
export const SL_COMBO_W3: readonly [string, string] = ['#c9ffc9', '#94fec1'];

/**
 * ITG "cel" noteskin arrow geometry, traced from the noteskin's tap-note mesh
 * ("_down tap note model.txt"): three concentric rings — the notched-chevron
 * silhouette, the bevel band, and the flat front face — normalized to a
 * half-extent of 1 (model units / 32), tip up.
 */
export type CelRing = ReadonlyArray<readonly [number, number]>;
export const CEL_OUTLINE: CelRing = [
  [0, -0.971],
  [1.002, 0.031],
  [0.594, 0.44],
  [0.344, 0.19],
  [0.344, 0.938],
  [-0.344, 0.938],
  [-0.344, 0.19],
  [-0.594, 0.44],
  [-1.002, 0.031],
];
export const CEL_BEVEL: CelRing = [
  [0, -0.883],
  [0.914, 0.031],
  [0.594, 0.351],
  [0.281, 0.039],
  [0.281, 0.875],
  [-0.281, 0.875],
  [-0.281, 0.039],
  [-0.594, 0.351],
  [-0.914, 0.031],
];
export const CEL_FACE: CelRing = [
  [0, -0.75],
  [0.781, 0.031],
  [0.594, 0.219],
  [0.188, -0.188],
  [0.188, 0.781],
  [-0.188, 0.781],
  [-0.188, -0.188],
  [-0.594, 0.219],
  [-0.781, 0.031],
];

export function traceCel(ctx: CanvasRenderingContext2D, s: number, ring: CelRing): void {
  ctx.beginPath();
  ctx.moveTo(ring[0][0] * s, ring[0][1] * s);
  for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0] * s, ring[i][1] * s);
  ctx.closePath();
}

/** Linear blend between two #rrggbb colors, t in [0,1]. */
export function lerpHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => {
    const va = (pa >> shift) & 255;
    const vb = (pb >> shift) & 255;
    return Math.round(va + (vb - va) * t);
  };
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

export function font(ds: number, w: number, px: number): string {
  return `${w} ${px * ds}px "Space Grotesk", system-ui, sans-serif`;
}

/**
 * Cel receptor inner drawing (the cel silhouette + bevel + face + inset stem
 * panel), traced at the origin; the caller sets up translate/rotate/scale and
 * restores. `val` is the neutral grey level (pressed → 246), `pressed` is part
 * of the shared art-code contract (the press scale is applied by the caller).
 */
export function paintCelReceptor(
  c: CanvasRenderingContext2D,
  s: number,
  ds: number,
  val: number,
  pressed: boolean,
): void {
  void pressed;
  const grey = (n: number) => {
    const c = Math.max(0, Math.min(255, Math.round(n)));
    return `rgb(${c},${c},${Math.min(255, c + 4)})`;
  };
  traceCel(c, s, CEL_OUTLINE);
  c.fillStyle = '#0d0e12';
  c.fill();
  c.lineJoin = 'round';
  c.lineWidth = 2.5 * ds;
  c.strokeStyle = '#0d0e12';
  c.stroke();
  traceCel(c, s, CEL_BEVEL);
  const g = c.createLinearGradient(0, -s, 0, s);
  g.addColorStop(0, grey(val + 58));
  g.addColorStop(1, grey(val - 30));
  c.fillStyle = g;
  c.fill();
  traceCel(c, s, CEL_FACE);
  c.fillStyle = grey(val);
  c.fill();
  // Inset stem panel (the "Go" stripe housing) with its divider notch.
  c.clip();
  c.fillStyle = grey(val + 34);
  c.fillRect(-0.12 * s, -0.1 * s, 0.24 * s, 0.84 * s);
  c.fillStyle = 'rgba(0,0,0,0.28)';
  c.fillRect(-0.12 * s, 0.22 * s, 0.24 * s, 1.5 * ds);
}

/**
 * Cel tap-note base (silhouette rim, silver bevel band, quantization face with
 * the cel shade, and the hairline stem seam), traced at the origin. The caller
 * sets up translate/rotate, draws the animated center stripe over this, and
 * restores. `faceColor` is `dead ? '#7c8087' : quantColor[quant]`; `dead` is
 * part of the shared art-code contract (the stripe animation is caller-owned).
 */
export function paintCelTapBase(
  c: CanvasRenderingContext2D,
  s: number,
  ds: number,
  faceColor: string,
  dead: boolean,
): void {
  void dead;
  // Silhouette / dark rim, stroked over itself to soften the corners.
  traceCel(c, s, CEL_OUTLINE);
  c.fillStyle = '#0d0e12';
  c.fill();
  c.lineJoin = 'round';
  c.lineWidth = 2.5 * ds;
  c.strokeStyle = '#0d0e12';
  c.stroke();
  // Silver bevel band between rim and face, lit from the tip side.
  traceCel(c, s, CEL_BEVEL);
  let g = c.createLinearGradient(0, -s, 0, s);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(1, 'rgba(170,177,187,0.95)');
  c.fillStyle = g;
  c.fill();
  // Flat quantization-colored face with a subtle two-tone cel shade
  // (desaturated grey for a dead freeze head).
  traceCel(c, s, CEL_FACE);
  c.fillStyle = faceColor;
  c.fill();
  g = c.createLinearGradient(0, -s, 0, s);
  g.addColorStop(0, 'rgba(255,255,255,0.32)');
  g.addColorStop(0.45, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.2)');
  c.fillStyle = g;
  c.fill();
  // Hairline seam where the stem tucks into the chevron V.
  c.lineWidth = 1.5 * ds;
  c.strokeStyle = 'rgba(0,0,0,0.3)';
  c.stroke();
}

/**
 * Cel mine shell: the dark metal orb with three rotating shell plates, traced
 * at the origin. The caller sets up translate/rotate, draws the red core over
 * this, and restores.
 */
export function paintCelMineBody(c: CanvasRenderingContext2D, r: number, ds: number): void {
  const body = c.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.15, 0, 0, r);
  body.addColorStop(0, '#4c5058');
  body.addColorStop(0.7, '#26282e');
  body.addColorStop(1, '#101114');
  c.fillStyle = body;
  c.strokeStyle = '#0c0d10';
  c.lineWidth = 2.5 * ds;
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.strokeStyle = '#b4b8c0';
  c.lineWidth = r * 0.3;
  for (let i = 0; i < 3; i++) {
    const a0 = (i / 3) * Math.PI * 2;
    c.beginPath();
    c.arc(0, 0, r * 0.68, a0 + 0.35, a0 + (Math.PI * 2) / 3 - 0.35);
    c.stroke();
  }
}

/**
 * Cel hit-explosion bloom: the arrow silhouette in the judgment color with a
 * white-hot core, in 'lighter' composite, traced at the origin. The caller
 * sets up translate/rotate/scale and restores. `fade` (= 1 - k) is kept as a
 * param because canvas globalAlpha is absolute (not multiplicative) and the
 * shadow blur also scales by it, so folding it out would break parity.
 */
export function paintCelExplosion(
  c: CanvasRenderingContext2D,
  s: number,
  ds: number,
  color: string,
  bright: boolean,
  fade: number,
): void {
  c.globalCompositeOperation = 'lighter';
  c.shadowColor = color;
  c.shadowBlur = (bright ? 30 : 20) * ds * fade;
  traceCel(c, s, CEL_OUTLINE);
  c.fillStyle = color;
  c.globalAlpha = 0.5 * fade;
  c.fill();
  c.shadowBlur = 0;
  traceCel(c, s * 0.88, CEL_OUTLINE);
  c.fillStyle = '#ffffff';
  c.globalAlpha = (bright ? 0.8 : 0.55) * fade;
  c.fill();
}
