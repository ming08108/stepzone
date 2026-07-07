/**
 * DDR A3 procedural art — the palettes, geometry, and canvas paint functions
 * behind the 'arcade' noteSkin, matched by eye against direct-capture
 * gameplay frames and the sprite metrics of the Curilang DDR-A3-THEME /
 * Schneider HD noteskin recreations (drawn 100% in code, no assets).
 *
 * This module no longer renders frames itself: the WebGPU note field
 * (render/gpu/gpuNoteField.ts) bakes these painters into its texture atlas
 * once and draws everything as instanced quads. The old per-frame canvas
 * theme (DdrA3Theme) was removed once the GPU field benchmarked and verified
 * ahead of it — see docs/RENDER-PERF.md.
 *
 * The A3 look, for reference:
 *
 * - "NOTE" noteskin arrows with the real DDR silhouette (broad chevron head,
 *   shaft with a tapered tail, swallow-tail notch): a quantization-colored
 *   band (4th red / 8th blue / 12th green / 16th yellow) around a near-black
 *   hollow, with the pale two-piece "tube" (capsule + pencil) inside the
 *   shaft. Freeze heads are green.
 * - Step Zone receptors: the same silhouette as hollow charcoal arrows with
 *   silver-white piping that brightens on the beat and blooms white on a
 *   press.
 * - Left-aligned single-player field (DDR P1 position, ~22% screen center);
 *   centered in the bare Options preview.
 * - Dance gauge: gold-cab industrial frame over the lane, split into big
 *   chevron-pill segments — flowing green stream, scrolling rainbow when
 *   full, pulsing red in danger (plus yellow neon DANGER ropes + red wash).
 * - Judgment + combo over the field (like the cab): Title Case rounded
 *   lettering ("Marvelous!!!", "Perfect!!", …) with the squash-in pop and
 *   the Marvelous white shimmer; big tier-tinted combo numerals with the
 *   lowercase "combo" word on the baseline.
 * - Freeze bodies: green/yellow stream, white chevrons, grey rails, rounded
 *   tail cap and cylindrical shading (grey when dropped, purple for rolls),
 *   beat-shimmering while engaged.
 * - Gold-cab black panels: song title/artist bottom-center; the two-row
 *   difficulty + 7-digit money-score panel (dimmed leading zeros) sits
 *   bottom-left under the field, like A3's P1 ScoreFrame.
 */

import { NoteType, TapNoteScore } from '../../notes/noteTypes';
import type { JudgmentStyle } from '../types';
import { OUTLINE_INK, roundFont, squareFont } from './text';

// --- Palette -----------------------------------------------------------------

export const GOLD_LIGHT = '#f6dc5a'; // gold-cab trim highlight
export const GOLD_MID = '#c9a227';
export const GOLD_DARK = '#6e5310';
export const PANEL_BG = 'rgba(0,0,0,0.86)';

// A3 difficulty colors (Scripts/02 Colors.lua) — yes, Difficult=red, Expert=green.
export const DIFF_COLOR: ReadonlyArray<readonly [string, string]> = [
  ['BEGINNER', '#1ed6ff'],
  ['EASY', '#ffaa19'],
  ['BASIC', '#ffaa19'],
  ['MEDIUM', '#ff1e3c'],
  ['DIFFICULT', '#ff1e3c'],
  ['HARD', '#32eb19'],
  ['EXPERT', '#32eb19'],
  ['CHALLENGE', '#eb1eff'],
  ['EDIT', '#afafaf'],
];

// DDR A3 judgment tiers (Title Case, per the Judgment 1x5 sprite). W5 has no
// A3 window — it gets the legacy DDR "Boo"; a stepped-on mine reads as N.G.
export const A3_JUDGMENT: Record<number, JudgmentStyle> = {
  [TapNoteScore.W1]: { label: 'Marvelous!!!', color: '#f2f2f6' },
  [TapNoteScore.W2]: { label: 'Perfect!!', color: '#ffd500' },
  [TapNoteScore.W3]: { label: 'Great!', color: '#1fb92c' },
  [TapNoteScore.W4]: { label: 'Good', color: '#2f7bff' },
  [TapNoteScore.W5]: { label: 'Boo', color: '#a24dff' },
  [TapNoteScore.Miss]: { label: 'Miss...', color: '#e01818' },
  [TapNoteScore.HitMine]: { label: 'N.G.', color: '#e01818' },
};

// Judgment text: core gradient [top, bottom] and outer glow per tier.
export const JUDGMENT_INK: Record<number, readonly [string, string, string]> = {
  [TapNoteScore.W1]: ['#ffffff', '#dcdce6', 'rgba(255,255,255,0.9)'],
  [TapNoteScore.W2]: ['#fff7ae', '#ffcf00', 'rgba(255,214,0,0.85)'],
  [TapNoteScore.W3]: ['#c2ffb4', '#0f9f1f', 'rgba(40,220,60,0.8)'],
  [TapNoteScore.W4]: ['#cfe6ff', '#2f7bff', 'rgba(70,140,255,0.8)'],
  [TapNoteScore.W5]: ['#e2c6ff', '#8630e0', 'rgba(160,80,255,0.8)'],
  [TapNoteScore.Miss]: ['#ff9c9c', '#d80f0f', 'rgba(230,30,30,0.8)'],
  [TapNoteScore.HitMine]: ['#ff9c9c', '#d80f0f', 'rgba(230,30,30,0.8)'],
};

export const JUDGMENT_LIFE = 0.47; // squash-in 0.036s, hold ~0.43s, vanish (no fade)
export const A3_EXPLOSION = 0.26; // step-zone flare lifetime

// "NOTE" skin band gradients per quantization: [tail(pale), core, tip].
export type BandColors = readonly [string, string, string];
const NOTE_RED: BandColors = ['#ff9fb2', '#ff1233', '#cf0424'];
const NOTE_BLUE: BandColors = ['#9fb4ff', '#2a41f0', '#1322cf'];
export const NOTE_GREEN: BandColors = ['#a8ffb0', '#15cf34', '#08a828'];
const NOTE_YELLOW: BandColors = ['#c9b833', '#ffe80a', '#ac9712'];
// Dead freeze head (dropped/missed): desaturated to match the grey hold body.
export const NOTE_GREY: BandColors = ['#c6c8cc', '#8f9296', '#63666b'];
export const TUBE_GREY = '#dfe0e3';
export const QUANT_BAND: Record<NoteType, BandColors> = {
  [NoteType.N4TH]: NOTE_RED,
  [NoteType.N8TH]: NOTE_BLUE,
  [NoteType.N12TH]: NOTE_GREEN,
  [NoteType.N16TH]: NOTE_YELLOW,
  [NoteType.N24TH]: NOTE_GREEN,
  [NoteType.N32ND]: NOTE_GREEN,
  [NoteType.N48TH]: NOTE_GREEN,
  [NoteType.N64TH]: NOTE_GREEN,
  [NoteType.N192ND]: NOTE_GREEN,
};
// Pale "tube" (capsule + pencil) tint per quantization.
export const QUANT_TUBE: Record<NoteType, string> = {
  [NoteType.N4TH]: '#ffccd4',
  [NoteType.N8TH]: '#c8d4ff',
  [NoteType.N12TH]: '#c6ffcc',
  [NoteType.N16TH]: '#fff7c0',
  [NoteType.N24TH]: '#c6ffcc',
  [NoteType.N32ND]: '#c6ffcc',
  [NoteType.N48TH]: '#c6ffcc',
  [NoteType.N64TH]: '#c6ffcc',
  [NoteType.N192ND]: '#c6ffcc',
};

// Combo numeral tint pairs [top, bottom] by the current judgment tier.
export const COMBO_TINT: Record<number, readonly [string, string]> = {
  [TapNoteScore.W1]: ['#ffffff', '#f2ecc0'],
  [TapNoteScore.W2]: ['#fff29a', '#ffd400'],
  [TapNoteScore.W3]: ['#c9ffc0', '#26c92e'],
  [TapNoteScore.W4]: ['#cfe4ff', '#3d86ff'],
};
export const COMBO_PLAIN: readonly [string, string] = ['#ffffff', '#dfe0e4'];

// Freeze-body palettes: [stream light, stream core, rail, outline, chevron].
export interface HoldSkin {
  light: string;
  core: string;
  rail: string;
  outline: string;
  chevron: string;
}
export const HOLD_GREEN: HoldSkin = {
  light: '#a8d83e',
  core: '#22cf52',
  rail: 'rgba(110,113,118,0.9)',
  outline: 'rgba(6,44,16,0.85)',
  chevron: 'rgba(250,250,250,0.92)',
};
export const HOLD_PURPLE: HoldSkin = {
  light: '#c78dff',
  core: '#9243ea',
  rail: 'rgba(110,113,118,0.9)',
  outline: 'rgba(40,8,70,0.85)',
  chevron: 'rgba(250,250,250,0.92)',
};
export const HOLD_GREY: HoldSkin = {
  light: '#a9abaf',
  core: '#8f9296',
  rail: 'rgba(96,99,104,0.9)',
  outline: 'rgba(24,26,30,0.7)',
  chevron: 'rgba(228,229,232,0.9)',
};

// --- The DDR arrow geometry ----------------------------------------------------
// Vertices transcribed from the DDR "NORMAL" tap-note model (60x60 units,
// here normalized to half-extent 1, base arrow pointing UP): a broad chevron
// head over a shaft that tapers at the tail, with the swallow-tail notch cut
// between the wings and the shaft.

export type Pts = ReadonlyArray<readonly [number, number]>;

/** Outer silhouette. */
export const ARROW_OUTER: Pts = [
  [0.067, 1],
  [0.333, 0.733],
  [0.333, 0.133],
  [0.6, 0.4],
  [0.8, 0.4],
  [1, 0.2],
  [1, 0],
  [0, -1],
  [-1, 0],
  [-1, 0.2],
  [-0.8, 0.4],
  [-0.6, 0.4],
  [-0.333, 0.133],
  [-0.333, 0.733],
  [-0.067, 1],
];

/** The hollow between the chevron band and the shaft (near-black interior). */
const ARROW_HOLLOW: Pts = [
  [0, -0.717],
  [0.767, 0.05],
  [0.767, 0.133],
  [0.733, 0.167],
  [0.65, 0.167],
  [0.333, 0.05],
  [0.267, 0],
  [0.283, -0.2],
  [0.183, -0.2],
  [0.05, -0.333],
  [0, -0.3],
  [-0.05, -0.333],
  [-0.183, -0.2],
  [-0.283, -0.2],
  [-0.267, 0],
  [-0.333, 0.05],
  [-0.65, 0.167],
  [-0.733, 0.167],
  [-0.767, 0.133],
  [-0.767, 0.05],
];

/** Tube piece 1: the capsule on the tail side of the shaft. */
const ARROW_CAPSULE: Pts = [
  [-0.05, 0.7],
  [0.05, 0.7],
  [0.133, 0.617],
  [0.133, 0.3],
  [0, 0.167],
  [-0.133, 0.3],
  [-0.133, 0.617],
];

/** Tube piece 2: the pencil pointing at the tip, chevron-notched at its tail. */
const ARROW_PENCIL: Pts = [
  [-0.133, 0.217],
  [-0.133, -0.167],
  [0, -0.3],
  [0.133, -0.167],
  [0.133, 0.217],
  [0, 0.083],
];

export function tracePoly(ctx: CanvasRenderingContext2D, pts: Pts, s: number): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * s, pts[0][1] * s);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * s, pts[i][1] * s);
  ctx.closePath();
}

// --- Text measurement -----------------------------------------------------------

// --- Art painters (shared with the WebGPU renderer's sprite baker) -------------

/** Step Zone receptor at origin. `f` is the beat brightness (0..1). */
export function paintReceptor(
  ctx: CanvasRenderingContext2D,
  s: number,
  ds: number,
  f: number,
  pressed: boolean,
): void {
  ctx.lineJoin = 'round';
  if (pressed) {
    // White bloom: the whole zone lights up, silhouette kept crisp.
    tracePoly(ctx, ARROW_OUTER, s);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(255,255,255,0.7)';
    ctx.shadowBlur = 5 * ds;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(10,11,14,0.8)';
    ctx.lineWidth = 2 * ds;
    ctx.stroke();
    ctx.fillStyle = '#d4d6dd';
    tracePoly(ctx, ARROW_HOLLOW, s);
    ctx.fill();
    return;
  }
  const band = Math.round(50 + 46 * f);
  const pipe = Math.round(200 + 55 * f);
  // Charcoal band, lit slightly from the tip side.
  const bg = ctx.createLinearGradient(0, -s, 0, s);
  bg.addColorStop(0, `rgb(${band + 22},${band + 24},${band + 28})`);
  bg.addColorStop(1, `rgb(${band - 8},${band - 6},${band - 2})`);
  tracePoly(ctx, ARROW_OUTER, s);
  ctx.fillStyle = bg;
  ctx.fill();
  // Outer piping.
  ctx.strokeStyle = `rgb(${pipe},${pipe},${pipe + 4})`;
  ctx.lineWidth = 2.5 * ds;
  ctx.stroke();
  // Hollow interior + inner piping.
  tracePoly(ctx, ARROW_HOLLOW, s);
  ctx.fillStyle = 'rgba(8,9,12,0.85)';
  ctx.fill();
  ctx.lineWidth = 2 * ds;
  ctx.stroke();
  // Tube pieces, readable mid-grey against the hollow.
  ctx.fillStyle = 'rgb(56,58,64)';
  ctx.strokeStyle = `rgba(${pipe},${pipe},${pipe + 4},0.6)`;
  ctx.lineWidth = 1.4 * ds;
  tracePoly(ctx, ARROW_CAPSULE, s);
  ctx.fill();
  ctx.stroke();
  tracePoly(ctx, ARROW_PENCIL, s);
  ctx.fill();
  ctx.stroke();
}

/** "NOTE" skin arrow at origin (pointing up). */
export function paintNote(
  ctx: CanvasRenderingContext2D,
  s: number,
  ds: number,
  band: BandColors,
  tube: string,
): void {
  ctx.lineJoin = 'round';
  // Colored band over the whole silhouette (tail = pale, tip = deep),
  // ringed by the black rim. Soft drop shadow seats it on the field.
  const g = ctx.createLinearGradient(0, s, 0, -s);
  g.addColorStop(0, band[0]);
  g.addColorStop(0.34, band[1]);
  g.addColorStop(1, band[2]);
  tracePoly(ctx, ARROW_OUTER, s);
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 5 * ds;
  ctx.shadowOffsetY = 2 * ds;
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = OUTLINE_INK;
  ctx.lineWidth = 3 * ds;
  ctx.stroke();
  // Near-black hollow.
  tracePoly(ctx, ARROW_HOLLOW, s);
  ctx.fillStyle = OUTLINE_INK;
  ctx.fill();
  // Pale tube.
  ctx.fillStyle = tube;
  tracePoly(ctx, ARROW_CAPSULE, s);
  ctx.fill();
  tracePoly(ctx, ARROW_PENCIL, s);
  ctx.fill();
}

/** Shock-arrow orb: radial-gradient body with the baked cyan rim glow. */
export function paintMineOrb(c: CanvasRenderingContext2D, r: number, ds: number): void {
  const body = c.createRadialGradient(-r * 0.25, -r * 0.25, r * 0.1, 0, 0, r);
  body.addColorStop(0, '#274051');
  body.addColorStop(0.7, '#101c26');
  body.addColorStop(1, '#060a0e');
  c.fillStyle = body;
  c.strokeStyle = 'rgba(0,192,240,0.85)';
  c.lineWidth = 2.5 * ds;
  c.shadowColor = 'rgba(0,192,240,0.7)';
  c.shadowBlur = 9 * ds;
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.fill();
  c.stroke();
}

/** Three lightning arcs orbiting the mine core (caller applies the spin). */
export function paintMineArcs(c: CanvasRenderingContext2D, r: number, ds: number): void {
  c.strokeStyle = '#9fe8ff';
  c.lineWidth = 2 * ds;
  for (let i = 0; i < 3; i++) {
    c.rotate((Math.PI * 2) / 3);
    c.beginPath();
    c.moveTo(r * 0.15, 0);
    c.lineTo(r * 0.45, -r * 0.18);
    c.lineTo(r * 0.62, r * 0.1);
    c.lineTo(r * 0.88, -r * 0.08);
    c.stroke();
  }
}

/** Explosion arrow ghost: white silhouette with a baked soft glow. */
export function paintBoom(c: CanvasRenderingContext2D, s: number, ds: number): void {
  c.lineJoin = 'round';
  c.shadowColor = '#ffffff';
  c.shadowBlur = 14 * ds;
  tracePoly(c, ARROW_OUTER, s);
  c.fillStyle = '#ffffff';
  c.fill();
}

/** One repeating freeze-body tile: white chevron + grey rails. */
export function paintHoldTile(
  c: CanvasRenderingContext2D,
  w: number,
  period: number,
  ds: number,
  skin: HoldSkin,
): void {
  const chevW = w * 0.8;
  const thick = 4.5 * ds;
  const drop = 10 * ds;
  c.fillStyle = skin.chevron;
  c.beginPath();
  c.moveTo(w / 2 - chevW / 2, 3 * ds);
  c.lineTo(w / 2, 3 * ds + drop);
  c.lineTo(w / 2 + chevW / 2, 3 * ds);
  c.lineTo(w / 2 + chevW / 2, 3 * ds + thick);
  c.lineTo(w / 2, 3 * ds + drop + thick);
  c.lineTo(w / 2 - chevW / 2, 3 * ds + thick);
  c.closePath();
  c.fill();
  c.fillStyle = skin.rail;
  c.fillRect(0, 0, 2 * ds, period);
  c.fillRect(w - 2 * ds, 0, 2 * ds, period);
}

/** Trace the gauge's chevron-pill segments into a path (local coords with
 *  the origin at the frame's top-left track corner). */
export function traceSegments(path: CanvasPath, tw: number, gh: number, ds: number): void {
  const segs = 8;
  const tip = 8 * ds;
  const segGap = 4 * ds;
  const segW = (tw - segGap * (segs - 1)) / segs;
  const ym = gh / 2;
  for (let i = 0; i < segs; i++) {
    const x0 = i * (segW + segGap);
    path.moveTo(x0 + tip, 2 * ds);
    path.lineTo(x0 + segW, 2 * ds);
    path.lineTo(x0 + segW + tip, ym);
    path.lineTo(x0 + segW, gh - 2 * ds);
    path.lineTo(x0 + tip, gh - 2 * ds);
    path.lineTo(x0, ym);
    path.closePath();
  }
}

/** Gold frame + caps + empty backing (segment-shaped) in local coords,
 *  origin at (gx-4ds, gy-4ds). */
export function paintGaugeChrome(
  c: CanvasRenderingContext2D,
  gw: number,
  gh: number,
  ds: number,
  capL: number,
  capR: number,
): void {
  const o = 4 * ds; // frame margin inside the sprite
  c.save();
  c.translate(o, o);
  // Outer hairline + gold frame plate.
  c.strokeStyle = 'rgba(150,120,30,0.6)';
  c.lineWidth = 1;
  c.strokeRect(-3.5 * ds, -3.5 * ds, gw + 7 * ds, gh + 7 * ds);
  const frame = c.createLinearGradient(0, -2 * ds, 0, gh + 2 * ds);
  frame.addColorStop(0, GOLD_LIGHT);
  frame.addColorStop(0.45, GOLD_MID);
  frame.addColorStop(0.55, '#8a6d14');
  frame.addColorStop(1, GOLD_DARK);
  c.fillStyle = frame;
  c.fillRect(-2 * ds, -2 * ds, gw + 4 * ds, gh + 4 * ds);
  // Machined end caps: grooved plate left, chevron point right.
  c.strokeStyle = 'rgba(40,30,4,0.8)';
  c.lineWidth = 1.6 * ds;
  c.beginPath();
  c.moveTo(6 * ds, 0);
  c.lineTo(12 * ds, gh);
  c.moveTo(12 * ds, 0);
  c.lineTo(18 * ds, gh);
  c.stroke();
  // Track.
  const tw = gw - capL - capR;
  c.fillStyle = '#0c0d10';
  c.fillRect(capL - 2 * ds, 0, tw + 4 * ds, gh);
  // Right cap chevron groove.
  c.beginPath();
  c.moveTo(gw - 10 * ds, 2 * ds);
  c.lineTo(gw - 4 * ds, gh / 2);
  c.lineTo(gw - 10 * ds, gh - 2 * ds);
  c.stroke();
  // Empty backing inside the segments.
  c.translate(capL, 0);
  c.beginPath();
  traceSegments(c, tw, gh, ds);
  c.clip();
  c.fillStyle = '#232429';
  c.fillRect(0, 0, tw + 8 * ds, gh);
  c.restore();
}

/** Gold chevron dividers between segments (drawn over the fill). */
export function paintGaugeDividers(
  c: CanvasRenderingContext2D,
  tw: number,
  gh: number,
  ds: number,
): void {
  const segs = 8;
  const tip = 8 * ds;
  const segGap = 4 * ds;
  const segW = (tw - segGap * (segs - 1)) / segs;
  const divGrad = c.createLinearGradient(0, 0, 0, gh);
  divGrad.addColorStop(0, GOLD_LIGHT);
  divGrad.addColorStop(1, GOLD_DARK);
  c.strokeStyle = divGrad;
  c.lineWidth = 2.6 * ds;
  c.beginPath();
  for (let i = 1; i < segs; i++) {
    const x0 = i * (segW + segGap) - segGap / 2;
    c.moveTo(x0 - tip / 2, 1 * ds);
    c.lineTo(x0 + tip / 2, gh / 2);
    c.lineTo(x0 - tip / 2, gh - 1 * ds);
  }
  c.stroke();
}

/** Song title/artist panel content (black band + lettering). */
export function paintSongPanel(
  c: CanvasRenderingContext2D,
  pw: number,
  ph: number,
  ds: number,
  title: string,
  subtitle: string,
  /** Fill the black panel band. The GPU field draws it as geometry and passes
   *  false so only the (bake-once) title/artist text lands in the sprite. */
  bg = true,
): void {
  if (bg) {
    c.fillStyle = PANEL_BG;
    c.fillRect(0, 0, pw, ph);
  }
  c.textAlign = 'center';
  c.fillStyle = '#f4f4f6';
  c.font = squareFont(700, 19 * ds);
  c.fillText(title || 'stepzone', pw / 2, 23 * ds, pw - 24 * ds);
  if (subtitle) {
    c.fillStyle = '#c9cacd';
    c.font = squareFont(600, 13 * ds);
    c.fillText(subtitle, pw / 2, 41 * ds, pw - 24 * ds);
  }
}

/** Difficulty label ("EXPERT 16": tier-coloured name + white meter), drawn at
 *  the score row's native position in a `pw`-wide sprite. Constant per session,
 *  so the GPU field bakes it once and draws the geometry frame separately. */
export function paintDifficulty(
  c: CanvasRenderingContext2D,
  diff: string,
  ds: number,
  pw: number,
): void {
  let dc = GOLD_LIGHT;
  for (const [name, color] of DIFF_COLOR) {
    if (diff.includes(name)) {
      dc = color;
      break;
    }
  }
  const meter = /^(.*?)\s*(\d+)$/.exec(diff);
  c.textAlign = 'left';
  c.font = squareFont(700, 13 * ds);
  if (meter) {
    c.fillStyle = dc;
    c.fillText(meter[1], 16 * ds, 16 * ds, pw * 0.5);
    c.fillStyle = '#f2f2f4';
    c.fillText(
      meter[2],
      16 * ds + Math.min(pw * 0.5, c.measureText(meter[1]).width) + 6 * ds,
      16 * ds,
    );
  } else {
    c.fillStyle = dc;
    c.fillText(diff, 16 * ds, 16 * ds, pw * 0.62);
  }
}

/** Grade ("AA") drawn left-aligned at (`pad`, 16.5ds); the GPU field bakes one
 *  sprite per grade value and right-aligns it, so a grade change swaps sprites
 *  instead of re-baking the whole score frame. */
export function paintGrade(
  c: CanvasRenderingContext2D,
  grade: string,
  ds: number,
  pad: number,
): void {
  c.textAlign = 'left';
  c.fillStyle = '#ffd83c';
  c.font = roundFont(14 * ds);
  c.fillText(grade, pad, 16.5 * ds);
}

/** Paint the judgment lettering with baked glow/rims at a left baseline. */
export function paintJudgment(
  c: CanvasRenderingContext2D,
  label: string,
  ink: readonly [string, string, string],
  px: number,
  ds: number,
  pad: number,
  shine: boolean,
): void {
  c.translate(pad, pad + px * 0.78);
  c.textAlign = 'left';
  c.lineJoin = 'round';
  c.font = roundFont(px);
  if (shine) {
    c.fillStyle = '#ffffff';
    c.fillText(label, 0, 0);
    return;
  }
  // Colored glow + fat white rim.
  c.shadowColor = ink[2];
  c.shadowBlur = 9 * ds;
  c.strokeStyle = '#ffffff';
  c.lineWidth = 7.5 * ds;
  c.strokeText(label, 0, 0);
  c.shadowColor = 'transparent';
  c.shadowBlur = 0;
  // Dark line between rim and core.
  c.strokeStyle = 'rgba(14,14,20,0.95)';
  c.lineWidth = 3.4 * ds;
  c.strokeText(label, 0, 0);
  // Core gradient.
  const g = c.createLinearGradient(0, -px * 0.78, 0, px * 0.12);
  g.addColorStop(0, ink[0]);
  g.addColorStop(1, ink[1]);
  c.fillStyle = g;
  c.fillText(label, 0, 0);
}

/** Paint the combo block (number + lowercase word on a shared baseline)
 *  with the join point at (joinOff, baseY). */
export function paintCombo(
  c: CanvasRenderingContext2D,
  count: string,
  tint: readonly [string, string],
  px: number,
  ds: number,
  joinOff: number,
  baseY: number,
): void {
  c.lineJoin = 'round';
  // Number: right-aligned against the join, condensed tall digits like the
  // A3 combo numerals.
  c.save();
  c.translate(joinOff, baseY);
  c.scale(0.84, 1);
  c.textAlign = 'right';
  c.font = roundFont(px);
  c.strokeStyle = '#ffffff';
  c.lineWidth = px * 0.13;
  c.strokeText(count, 0, 0);
  c.strokeStyle = OUTLINE_INK;
  c.lineWidth = px * 0.075;
  c.strokeText(count, 0, 0);
  const g = c.createLinearGradient(0, -px * 0.9, 0, 0);
  g.addColorStop(0, tint[0]);
  g.addColorStop(1, tint[1]);
  c.fillStyle = g;
  c.fillText(count, 0, 0);
  c.restore();
  // Lowercase "combo", fixed size, sharing the baseline.
  const wpx = px * 0.42;
  c.translate(joinOff + 6 * ds, baseY);
  c.textAlign = 'left';
  c.font = roundFont(wpx);
  c.strokeStyle = '#ffffff';
  c.lineWidth = wpx * 0.15;
  c.strokeText('combo', 0, 0);
  c.strokeStyle = OUTLINE_INK;
  c.lineWidth = wpx * 0.085;
  c.strokeText('combo', 0, 0);
  const g2 = c.createLinearGradient(0, -wpx, 0, 0);
  g2.addColorStop(0, tint[0]);
  g2.addColorStop(1, tint[1]);
  c.fillStyle = g2;
  c.fillText('combo', 0, 0);
}
