/**
 * DDR A3 theme — the persisted 'arcade' noteSkin. A procedural canvas
 * recreation of DanceDanceRevolution A3's gameplay screen, matched by eye
 * against direct-capture gameplay frames and the sprite metrics of the
 * Curilang DDR-A3-THEME / Schneider HD noteskin recreations (drawn 100% in
 * code, no assets):
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
 * - Judgments under the arrows (A3 ComboUnderField): Title Case rounded
 *   lettering ("Marvelous!!!", "Perfect!!", …) with the squash-in pop and
 *   the Marvelous white shimmer; big tier-tinted combo numerals with the
 *   lowercase "combo" word on the baseline.
 * - Freeze bodies: green/yellow stream, white chevrons, grey rails, rounded
 *   tail cap and cylindrical shading (grey when dropped, purple for rolls),
 *   beat-shimmering while engaged.
 * - Gold-cab black panels: song title/artist bottom-center; the two-row
 *   difficulty + 7-digit money-score panel (dimmed leading zeros) sits
 *   bottom-left under the field, like A3's P1 ScoreFrame.
 *
 * Rendering strategy: every static element (arrows, receptors, text blocks,
 * gauge chrome, hold tiles) is rasterized once into offscreen sprites/
 * patterns via SpriteStore and blitted per frame — no per-frame shadowBlur,
 * gradients-per-note, or multi-pass text strokes. In environments without
 * canvas support (unit tests) every draw falls back to direct path painting.
 */

import type { Judge } from '../../gameplay/judge';
import { NoteType, TapNoteScore } from '../../notes/noteTypes';
import type { Feedback, FieldView, JudgmentStyle, TapNoteStyle, Theme } from '../theme';

// --- Fonts -------------------------------------------------------------------
// A3's HUD lettering is a heavy rounded pop face; Arial Rounded (macOS/Office)
// degrades to Segoe UI Black / Chakra Petch elsewhere.
const ROUND_FONT = '"Arial Rounded MT Bold", "Segoe UI", "Chakra Petch", system-ui, sans-serif';
const SQUARE_FONT = '"Chakra Petch", "Segoe UI", system-ui, sans-serif';

export function roundFont(px: number): string {
  return `900 ${px}px ${ROUND_FONT}`;
}
export function squareFont(w: number, px: number): string {
  return `${w} ${px}px ${SQUARE_FONT}`;
}

// --- Palette -----------------------------------------------------------------

export const GOLD_LIGHT = '#f6dc5a'; // gold-cab trim highlight
export const GOLD_MID = '#c9a227';
export const GOLD_DARK = '#6e5310';
export const PANEL_BG = 'rgba(0,0,0,0.86)';
export const OUTLINE_INK = '#0b0c10'; // arrow border / interior black

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
const A3_QUANT_COLOR: Record<NoteType, string> = {
  [NoteType.N4TH]: NOTE_RED[1],
  [NoteType.N8TH]: NOTE_BLUE[1],
  [NoteType.N12TH]: NOTE_GREEN[1],
  [NoteType.N16TH]: NOTE_YELLOW[1],
  [NoteType.N24TH]: NOTE_GREEN[1],
  [NoteType.N32ND]: NOTE_GREEN[1],
  [NoteType.N48TH]: NOTE_GREEN[1],
  [NoteType.N64TH]: NOTE_GREEN[1],
  [NoteType.N192ND]: NOTE_GREEN[1],
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

// --- Sprite cache --------------------------------------------------------------

/** Supersample factor for cached sprites (keeps them crisp on hidpi). */
export const SPRITE_SCALE = 2;

/** Shared scratch context for text measurement (null when unavailable). */
let measurer: CanvasRenderingContext2D | null | undefined;
export function measureWidth(font: string, text: string): number | null {
  if (measurer === undefined) {
    measurer =
      typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  }
  if (!measurer) return null;
  measurer.font = font;
  return measurer.measureText(text).width;
}

/**
 * Offscreen sprite/pattern cache. Everything is keyed and invalidated when
 * the design scale changes (and once when web fonts finish loading, so text
 * sprites baked with fallback fonts are rebuilt). Returns null when offscreen
 * canvases are unavailable (unit tests) — callers then paint directly.
 */
class SpriteStore {
  private sprites = new Map<string, HTMLCanvasElement | null>();
  private patterns = new Map<string, CanvasPattern | null>();
  private slotKeys = new Map<string, string>();
  private ds = -1;

  constructor() {
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => this.sprites.clear()).catch(() => undefined);
    }
  }

  sync(ds: number): void {
    if (ds !== this.ds) {
      this.sprites.clear();
      this.patterns.clear();
      this.slotKeys.clear();
      this.ds = ds;
    }
  }

  sprite(
    key: string,
    w: number,
    h: number,
    paint: (c: CanvasRenderingContext2D) => void,
  ): HTMLCanvasElement | null {
    let spr = this.sprites.get(key);
    if (spr === undefined) {
      spr = makeSprite(w, h, paint);
      this.sprites.set(key, spr);
    }
    return spr;
  }

  /** Single-slot sprite whose content hash is part of the key (combo count,
   *  score digits…): re-rendered only when the content changes. */
  slot(
    slot: string,
    key: string,
    w: number,
    h: number,
    paint: (c: CanvasRenderingContext2D) => void,
  ): HTMLCanvasElement | null {
    if (this.slotKeys.get(slot) !== key) {
      this.sprites.delete(`slot:${slot}`);
      this.slotKeys.set(slot, key);
    }
    return this.sprite(`slot:${slot}`, w, h, paint);
  }

  /** Cached repeating tile pattern (rendered at 1x). */
  pattern(
    key: string,
    w: number,
    h: number,
    paint: (c: CanvasRenderingContext2D) => void,
  ): CanvasPattern | null {
    let p = this.patterns.get(key);
    if (p === undefined) {
      p = null;
      if (typeof document !== 'undefined') {
        const tile = document.createElement('canvas');
        tile.width = Math.max(1, Math.ceil(w));
        tile.height = Math.max(1, Math.ceil(h));
        const c = tile.getContext('2d');
        if (c) {
          paint(c);
          p = c.createPattern(tile, 'repeat');
        }
      }
      this.patterns.set(key, p);
    }
    return p;
  }
}

function makeSprite(
  w: number,
  h: number,
  paint: (c: CanvasRenderingContext2D) => void,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.createElement('canvas');
  el.width = Math.max(1, Math.ceil(w * SPRITE_SCALE));
  el.height = Math.max(1, Math.ceil(h * SPRITE_SCALE));
  const c = el.getContext('2d');
  if (!c) return null;
  c.scale(SPRITE_SCALE, SPRITE_SCALE);
  paint(c);
  return el;
}

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
): void {
  c.fillStyle = PANEL_BG;
  c.fillRect(0, 0, pw, ph);
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

/** Score panel content: difficulty/grade row + hexagonal money-score bar. */
export function paintScorePanel(
  c: CanvasRenderingContext2D,
  pw: number,
  rowH: number,
  scoreH: number,
  ds: number,
  m: number,
  digits: string,
  diff: string,
  grade: string,
): void {
  c.translate(m, m);
  // Row 1: difficulty + grade, angled left edge.
  c.beginPath();
  c.moveTo(14 * ds, 0);
  c.lineTo(pw, 0);
  c.lineTo(pw, rowH);
  c.lineTo(4 * ds, rowH);
  c.closePath();
  c.fillStyle = PANEL_BG;
  c.fill();
  c.strokeStyle = GOLD_MID;
  c.lineWidth = 1.2 * ds;
  c.stroke();

  let dc = GOLD_LIGHT;
  for (const [name, color] of DIFF_COLOR) {
    if (diff.includes(name)) {
      dc = color;
      break;
    }
  }
  // Trailing meter number renders white, like A3's "EXPERT 16".
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
  c.textAlign = 'right';
  c.fillStyle = '#ffd83c';
  c.font = roundFont(14 * ds);
  c.fillText(grade, pw - 10 * ds, 16.5 * ds);
  // Gold slash divider.
  c.strokeStyle = GOLD_MID;
  c.lineWidth = 2 * ds;
  c.beginPath();
  c.moveTo(pw * 0.68, 3 * ds);
  c.lineTo(pw * 0.64, rowH - 3 * ds);
  c.stroke();

  // Row 2: hexagonal score bar.
  const sy = rowH + 2 * ds;
  const cut = 12 * ds;
  c.beginPath();
  c.moveTo(cut, sy);
  c.lineTo(pw - cut, sy);
  c.lineTo(pw, sy + scoreH / 2);
  c.lineTo(pw - cut, sy + scoreH);
  c.lineTo(cut, sy + scoreH);
  c.lineTo(0, sy + scoreH / 2);
  c.closePath();
  c.fillStyle = PANEL_BG;
  c.fill();
  const trim = c.createLinearGradient(0, sy, 0, sy + scoreH);
  trim.addColorStop(0, GOLD_LIGHT);
  trim.addColorStop(1, GOLD_DARK);
  c.strokeStyle = trim;
  c.lineWidth = 1.6 * ds;
  c.stroke();

  // 7-digit money score with commas, leading zeros dimmed.
  const firstSig = digits.search(/[1-9]/);
  let text = '';
  const dim: boolean[] = [];
  for (let i = 0; i < 7; i++) {
    const isDim = firstSig === -1 || i < firstSig;
    if (i === 1 || i === 4) {
      text += ',';
      dim.push(firstSig === -1 || i - 1 < firstSig); // comma follows its digit
    }
    text += digits[i];
    dim.push(isDim);
  }
  c.font = roundFont(25 * ds);
  c.textAlign = 'left';
  c.lineJoin = 'round';
  const widths = Array.from(text, (ch) => c.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0);
  let dx = (pw - total) / 2;
  const dy = sy + scoreH / 2 + 8 * ds;
  for (let i = 0; i < text.length; i++) {
    c.strokeStyle = OUTLINE_INK;
    c.lineWidth = 3.5 * ds;
    c.strokeText(text[i], dx, dy);
    c.fillStyle = dim[i] ? '#494a4f' : '#f6f6f8';
    c.fillText(text[i], dx, dy);
    dx += widths[i];
  }
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

export class DdrA3Theme implements Theme {
  readonly quantColor = A3_QUANT_COLOR;
  readonly judgments = A3_JUDGMENT;
  readonly explosionSeconds = A3_EXPLOSION;
  /** A3 step zone: y=-161 of a 480-tall screen ≈ 118 design px from the top,
   *  which also clears the dance gauge. */
  readonly receptorOffset = 118;

  private readonly store = new SpriteStore();
  private segPath: Path2D | null = null;
  private segPathKey = '';

  /** DDR P1 field: left of center (~22% screen center), clamped to the edge;
   *  centered in the bare Options preview. */
  fieldLeft(v: FieldView): number {
    const fieldW = v.numTracks * v.colW;
    if (v.bare) return (v.width - fieldW) / 2;
    return Math.max(24 * v.ds, 0.22 * v.width - fieldW / 2);
  }

  /** Lane cover (A3 ScreenFilter "Dark", soft edges) + the DangerAnim red
   *  wash and neon-yellow DANGER ropes while the gauge is critical. */
  drawFieldChrome(ctx: CanvasRenderingContext2D, v: FieldView, judge: Judge): void {
    const { ds, height } = v;
    const fieldW = v.numTracks * v.colW;
    const fieldL = v.fieldLeft;
    const pad = 14 * ds;
    const x0 = fieldL - pad;
    const w = fieldW + 2 * pad;
    const soft = 14 * ds;
    // Soft-edged dark filter, like the ScreenFilter sprite.
    const g = ctx.createLinearGradient(x0 - soft, 0, x0 + soft, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(x0 - soft, 0, soft * 2, height);
    const g2 = ctx.createLinearGradient(x0 + w - soft, 0, x0 + w + soft, 0);
    g2.addColorStop(0, 'rgba(0,0,0,0.55)');
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(x0 + w - soft, 0, soft * 2, height);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x0 + soft, 0, w - soft * 2, height);

    if (!judge.failed && judge.life < 0.25) {
      // Deep-red danger filter pulsing with the beat (A3 DangerAnim #900000).
      ctx.fillStyle = `rgba(144,0,0,${(0.16 + 0.14 * v.beatPulse).toFixed(3)})`;
      ctx.fillRect(x0, 0, w, height);
      // Glowing yellow DANGER ropes along both lane edges.
      const glow = 0.55 + 0.45 * v.beatPulse;
      ctx.save();
      ctx.strokeStyle = `rgba(250,238,0,${glow.toFixed(3)})`;
      ctx.lineWidth = 3 * ds;
      ctx.shadowColor = 'rgba(250,238,0,0.9)';
      ctx.shadowBlur = 12 * ds * glow;
      for (const x of [x0 + 5 * ds, x0 + w - 5 * ds]) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      ctx.font = roundFont(20 * ds);
      ctx.textAlign = 'center';
      ctx.lineWidth = 1.5 * ds;
      for (const x of [x0 + 5 * ds, x0 + w - 5 * ds]) {
        ctx.save();
        ctx.translate(x, height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.strokeText('D A N G E R', 0, 7 * ds);
        ctx.restore();
      }
      ctx.restore();
    }
  }

  drawHudUnderlay(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    judge: Judge,
    _progress: number,
    fb: Feedback,
    comboPopAt: number,
  ): void {
    this.store.sync(v.ds);
    // A3 renders judgment and combo beneath the arrows (ComboUnderField).
    this.drawJudgmentLabel(ctx, v, fb);
    this.drawCombo(ctx, v, judge, fb, comboPopAt);
  }

  // --- Receptors / notes -------------------------------------------------------

  /** Step Zone: hollow charcoal arrow with silver-white piping, brightening
   *  on each beat (cached dim/bright sprites cross-faded) and blooming solid
   *  white with a scale dip on a press. */
  drawReceptor(ctx: CanvasRenderingContext2D, v: FieldView, track: number, pressed: boolean): void {
    this.store.sync(v.ds);
    const s = v.arrowS * 0.95;
    const ds = v.ds;
    const f = v.beatPulse * v.beatPulse; // sharp attack, quick decay
    const m = s + 8 * ds;
    ctx.save();
    ctx.translate(v.laneX(track), v.receptorY);
    ctx.rotate(v.angle(track));
    if (pressed) ctx.scale(0.94, 0.94);
    const key = pressed ? 'rec:press' : 'rec:dim';
    const spr = this.store.sprite(key, 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintReceptor(c, s, ds, 0, pressed);
    });
    if (!spr) {
      paintReceptor(ctx, s, ds, pressed ? 0 : f, pressed);
      ctx.restore();
      return;
    }
    ctx.drawImage(spr, -m, -m, 2 * m, 2 * m);
    if (!pressed && f > 0.02) {
      const bright = this.store.sprite('rec:bright', 2 * m, 2 * m, (c) => {
        c.translate(m, m);
        paintReceptor(c, s, ds, 1, false);
      });
      if (bright) {
        ctx.globalAlpha = f;
        ctx.drawImage(bright, -m, -m, 2 * m, 2 * m);
      }
    }
    ctx.restore();
  }

  /** "NOTE" skin arrow: black rim, quantization-colored band (pale at the
   *  tail, saturated core, deep tip), near-black hollow, and the pale tube
   *  (capsule + pencil) inside the shaft. Freeze heads render green; dead
   *  (dropped/missed) freeze heads render grey like their body.
   *  One cached sprite per palette, rotated per column. */
  drawTapNote(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    track: number,
    y: number,
    quant: NoteType,
    style: TapNoteStyle,
  ): void {
    this.store.sync(v.ds);
    const s = v.arrowS;
    const ds = v.ds;
    const band =
      style === 'deadHead' ? NOTE_GREY : style === 'holdHead' ? NOTE_GREEN : QUANT_BAND[quant];
    const tube =
      style === 'deadHead'
        ? TUBE_GREY
        : style === 'holdHead'
          ? QUANT_TUBE[NoteType.N12TH]
          : QUANT_TUBE[quant];
    const m = s + 9 * ds;
    ctx.save();
    ctx.translate(v.laneX(track), y);
    ctx.rotate(v.angle(track));
    const spr = this.store.sprite(`note:${band[1]}`, 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintNote(c, s, ds, band, tube);
    });
    if (spr) ctx.drawImage(spr, -m, -m, 2 * m, 2 * m);
    else paintNote(ctx, s, ds, band, tube);
    ctx.restore();
  }

  /** Shock-arrow hazard: dark electric orb, cyan rim, rotating lightning
   *  arcs, beat-flashing spark (DDR's mine stand-in). Orb cached; arcs and
   *  spark animate live (cheap strokes, no shadows). */
  drawMine(ctx: CanvasRenderingContext2D, v: FieldView, x: number, y: number): void {
    this.store.sync(v.ds);
    const r = v.arrowS * 0.62;
    const ds = v.ds;
    const pulse = v.beatPulse;
    const m = r + 12 * ds;
    ctx.save();
    ctx.translate(x, y);
    const spr = this.store.sprite('mine', 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintMineOrb(c, r, ds);
    });
    if (spr) ctx.drawImage(spr, -m, -m, 2 * m, 2 * m);
    else {
      ctx.fillStyle = '#101c26';
      ctx.strokeStyle = 'rgba(0,192,240,0.85)';
      ctx.lineWidth = 2.5 * ds;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // Three lightning arcs orbiting the core.
    ctx.rotate(v.nowSeconds * 3);
    paintMineArcs(ctx, r, ds);
    // White-hot spark core flashing on the beat.
    ctx.fillStyle = `rgba(240,250,255,${(0.4 + 0.6 * pulse).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Freeze-arrow body: green/yellow stream with white chevrons pointing at
   *  the tail, grey rails, cylindrical shading, a dark outline and a rounded
   *  tail cap (the DDR freeze look). Greyscale once dropped; purple for
   *  rolls; shimmers with the beat while engaged. Chevrons + rails come from
   *  a cached repeating tile. */
  drawHoldBody(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    track: number,
    top: number,
    bottom: number,
    held: boolean,
    alive: boolean,
    roll: boolean,
  ): void {
    this.store.sync(v.ds);
    const ds = v.ds;
    const x = v.laneX(track);
    const w = v.arrowS * 1.66;
    const h = Math.max(1, bottom - top);
    const capR = w * 0.48;
    const skin = !alive ? HOLD_GREY : roll ? HOLD_PURPLE : HOLD_GREEN;
    const variant = !alive ? 'grey' : roll ? 'purple' : 'green';
    const caps: [number, number, number, number] = v.reverse
      ? [capR, capR, 0, 0]
      : [0, 0, capR, capR];

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x - w / 2, top, w, h, caps);
    ctx.save();
    ctx.clip();
    // Body stream: soft light<->core cycle down the tube.
    const grad = ctx.createLinearGradient(0, top, 0, top + Math.max(h, 220 * ds));
    grad.addColorStop(0, skin.light);
    grad.addColorStop(0.5, skin.core);
    grad.addColorStop(1, skin.light);
    ctx.fillStyle = grad;
    ctx.fillRect(x - w / 2, top, w, h);
    // Chevrons + rails from the cached tile, anchored at the head end so the
    // pattern rides with the hold.
    const period = 17 * ds;
    const pat = this.store.pattern(`hold:${variant}`, w, period, (c) =>
      paintHoldTile(c, w, period, ds, skin),
    );
    const yStart = v.reverse ? bottom : top;
    if (pat) {
      ctx.save();
      ctx.translate(x - w / 2, yStart);
      if (v.reverse) ctx.scale(1, -1);
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    } else {
      // Direct fallback: draw the chevrons (rails after).
      const chevW = w * 0.8;
      const thick = 4.5 * ds;
      const drop = 10 * ds;
      const dir = v.reverse ? -1 : 1;
      ctx.fillStyle = skin.chevron;
      for (let k = 3 * ds; k < h + drop + thick; k += period) {
        const yy = yStart + dir * k;
        ctx.beginPath();
        ctx.moveTo(x - chevW / 2, yy);
        ctx.lineTo(x, yy + dir * drop);
        ctx.lineTo(x + chevW / 2, yy);
        ctx.lineTo(x + chevW / 2, yy + dir * thick);
        ctx.lineTo(x, yy + dir * (drop + thick));
        ctx.lineTo(x - chevW / 2, yy + dir * thick);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = skin.rail;
      ctx.fillRect(x - w / 2, top, 2 * ds, h);
      ctx.fillRect(x + w / 2 - 2 * ds, top, 2 * ds, h);
    }
    // Cylindrical shading: darker edges, bright core.
    const shade = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    shade.addColorStop(0, 'rgba(0,0,0,0.32)');
    shade.addColorStop(0.22, 'rgba(0,0,0,0)');
    shade.addColorStop(0.5, 'rgba(255,255,255,0.10)');
    shade.addColorStop(0.78, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.32)');
    ctx.fillStyle = shade;
    ctx.fillRect(x - w / 2, top, w, h);
    // Engaged: beat-driven shimmer washing down the tube.
    if (alive && held) {
      ctx.fillStyle = `rgba(255,255,255,${(0.08 + 0.14 * v.beatPulse).toFixed(3)})`;
      ctx.fillRect(x - w / 2, top, w, h);
    }
    ctx.restore();
    // Dark outline seats the tube on the field (path is still current).
    ctx.strokeStyle = skin.outline;
    ctx.lineWidth = 1.8 * ds;
    ctx.stroke();
    ctx.restore();
  }

  /** Step-zone flare: white arrow bloom (cached, glow baked) plus an
   *  expanding four-ray starburst, additive — DDR's hit flash. */
  drawExplosion(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    track: number,
    tns: TapNoteScore,
    k: number,
  ): void {
    this.store.sync(v.ds);
    const s = v.arrowS;
    const ds = v.ds;
    const fade = 1 - k;
    ctx.save();
    ctx.translate(v.laneX(track), v.receptorY);
    ctx.globalCompositeOperation = 'lighter';
    // Arrow ghost swelling, white with a baked soft glow.
    ctx.save();
    ctx.rotate(v.angle(track));
    const sc = 1 + 0.32 * k;
    ctx.scale(sc, sc);
    const m = s + 18 * ds;
    const spr = this.store.sprite('boom', 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintBoom(c, s, ds);
    });
    ctx.globalAlpha = 0.42 * fade;
    if (spr) ctx.drawImage(spr, -m, -m, 2 * m, 2 * m);
    else {
      tracePoly(ctx, ARROW_OUTER, s);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
    ctx.restore();
    // Four-point star flare, tinted faintly by the judgment tier.
    const j = this.judgments[tns];
    const rr = s * (0.9 + 1.15 * k);
    const ww = s * 0.13 * fade;
    ctx.fillStyle = j ? j.color : '#ffffff';
    ctx.globalAlpha = 0.25 * fade;
    ctx.rotate(Math.PI / 4);
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.moveTo(0, -rr);
      ctx.lineTo(ww, 0);
      ctx.lineTo(0, rr);
      ctx.lineTo(-ww, 0);
      ctx.closePath();
      ctx.fill();
      ctx.rotate(Math.PI / 2);
    }
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.6 * fade;
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.moveTo(0, -rr * 0.92);
      ctx.lineTo(ww * 0.6, 0);
      ctx.lineTo(0, rr * 0.92);
      ctx.lineTo(-ww * 0.6, 0);
      ctx.closePath();
      ctx.fill();
      ctx.rotate(Math.PI / 2);
    }
    ctx.restore();
  }

  drawHudOverlay(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    judge: Judge,
    progress: number,
    _fb: Feedback,
    _comboPopAt: number,
  ): void {
    // The gauge and panels sit ON TOP of the field — arrows scroll in under
    // the score frame and vanish behind the dance gauge, like the cab.
    this.store.sync(v.ds);
    this.drawDanceGauge(ctx, v, judge);
    this.drawSongPanel(ctx, v, progress);
    this.drawScorePanel(ctx, v, judge);
  }

  // --- HUD pieces ------------------------------------------------------------

  /** Dance gauge: gold-cab industrial frame spanning the lane top, split into
   *  big chevron-pill segments — flowing green stream, scrolling rainbow when
   *  full, pulsing red in danger. Chrome and dividers are cached sprites; the
   *  animated fill is clipped by a cached Path2D. */
  private drawDanceGauge(ctx: CanvasRenderingContext2D, v: FieldView, judge: Judge): void {
    const { ds } = v;
    const fieldW = v.numTracks * v.colW;
    const cx = v.fieldLeft + fieldW / 2;
    const gw = fieldW + 1.6 * v.colW;
    const gh = 26 * ds;
    const gx = Math.max(6 * ds, cx - gw / 2);
    const gy = 12 * ds;
    const capL = 24 * ds;
    const capR = 16 * ds;
    const tx = gx + capL;
    const tw = gw - capL - capR;
    const life = judge.failed ? 0 : Math.max(0, Math.min(1, judge.life));
    const danger = !judge.failed && judge.life < 0.25;
    const hot = life >= 1;
    const o = 4 * ds;
    const sprW = gw + 8 * ds;
    const sprH = gh + 8 * ds;

    ctx.save();
    const chrome = this.store.sprite('gauge:chrome', sprW, sprH, (c) =>
      paintGaugeChrome(c, gw, gh, ds, capL, capR),
    );
    if (chrome) ctx.drawImage(chrome, gx - o, gy - o, sprW, sprH);
    else {
      ctx.save();
      ctx.translate(gx - o, gy - o);
      paintGaugeChrome(ctx, gw, gh, ds, capL, capR);
      ctx.restore();
    }

    // Animated fill, clipped to the segment shapes.
    if (life > 0) {
      ctx.save();
      ctx.translate(tx, gy);
      const pathKey = `${Math.round(tw)}|${ds}`;
      if (typeof Path2D !== 'undefined') {
        if (this.segPathKey !== pathKey || !this.segPath) {
          this.segPath = new Path2D();
          traceSegments(this.segPath, tw, gh, ds);
          this.segPathKey = pathKey;
        }
        ctx.clip(this.segPath);
      } else {
        ctx.beginPath();
        traceSegments(ctx, tw, gh, ds);
        ctx.clip();
      }
      const fw = Math.max(2 * ds, (tw + 8 * ds) * life);
      ctx.beginPath();
      ctx.rect(0, 0, fw, gh);
      ctx.clip();
      if (hot) {
        // Scrolling rainbow stream (the maxed gauge).
        const off = ((v.nowSeconds * 0.35) % 1) * tw;
        const rg = ctx.createLinearGradient(off - tw, 0, off + tw, 0);
        const cycle = ['#ff2fd4', '#ff3a3a', '#ffd52a', '#2fe23a', '#2ad4ff', '#4a3aff', '#ff2fd4'];
        for (let r = 0; r < 2; r++)
          for (let i = 0; i < cycle.length; i++)
            rg.addColorStop(r * 0.5 + (i / (cycle.length - 1)) * 0.5, cycle[i]);
        ctx.fillStyle = rg;
        ctx.fillRect(0, 0, fw, gh);
      } else if (danger) {
        ctx.fillStyle = `rgba(244,32,8,${(0.55 + 0.45 * v.beatPulse).toFixed(3)})`;
        ctx.fillRect(0, 0, fw, gh);
      } else {
        const sg = ctx.createLinearGradient(0, 0, 0, gh);
        sg.addColorStop(0, '#66f5b0');
        sg.addColorStop(0.45, '#0ddf75');
        sg.addColorStop(1, '#00a854');
        ctx.fillStyle = sg;
        ctx.fillRect(0, 0, fw, gh);
        // Flowing lighter bands drifting along the stream.
        const period = 56 * ds;
        const soff = ((v.nowSeconds * 0.5) % 1) * period;
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        for (let xx = -period + soff; xx < fw; xx += period) {
          ctx.beginPath();
          ctx.moveTo(xx, gh);
          ctx.lineTo(xx + gh * 0.7, 0);
          ctx.lineTo(xx + gh * 0.7 + 10 * ds, 0);
          ctx.lineTo(xx + 10 * ds, gh);
          ctx.closePath();
          ctx.fill();
        }
      }
      // Top sheen inside the fill.
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fillRect(0, 2 * ds, fw, 3 * ds);
      ctx.restore();
    }

    const div = this.store.sprite('gauge:div', tw + 8 * ds, gh, (c) =>
      paintGaugeDividers(c, tw, gh, ds),
    );
    if (div) ctx.drawImage(div, tx, gy, tw + 8 * ds, gh);
    else {
      ctx.save();
      ctx.translate(tx, gy);
      paintGaugeDividers(ctx, tw, gh, ds);
      ctx.restore();
    }
    ctx.restore();
  }

  /** Song title/artist panel, bottom-center: A3's plain black band with bold
   *  white lettering (cached), plus a live gold progress hairline. */
  private drawSongPanel(ctx: CanvasRenderingContext2D, v: FieldView, progress: number): void {
    const { ds, width, height } = v;
    const pw = Math.min(0.36 * width, 430 * ds);
    const ph = 52 * ds;
    const px = (width - pw) / 2;
    const py = height - ph - 8 * ds;
    const paint = (c: CanvasRenderingContext2D): void =>
      paintSongPanel(c, pw, ph, ds, v.meta.title, v.meta.subtitle);
    const spr = this.store.slot(
      'song',
      `${v.meta.title}|${v.meta.subtitle}|${Math.round(pw)}`,
      pw,
      ph,
      paint,
    );
    ctx.save();
    if (spr) ctx.drawImage(spr, px, py, pw, ph);
    else {
      ctx.translate(px, py);
      paint(ctx);
      ctx.translate(-px, -py);
    }
    // Progress hairline along the bottom edge.
    const prog = Math.max(0, Math.min(1, progress));
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(px, py + ph - 2.5 * ds, pw, 2.5 * ds);
    ctx.fillStyle = 'rgba(216,182,42,0.9)';
    ctx.fillRect(px, py + ph - 2.5 * ds, pw * prog, 2.5 * ds);
    ctx.restore();
  }

  /** Score panel in A3's P1 position (bottom-left, under the field):
   *  difficulty/grade bar over the hexagonal 7-digit money-score bar with
   *  dimmed leading zeros. Cached; re-rendered only when the score changes. */
  private drawScorePanel(ctx: CanvasRenderingContext2D, v: FieldView, judge: Judge): void {
    const { ds, height } = v;
    const pw = 280 * ds;
    const px = 16 * ds;
    const rowH = 23 * ds;
    const scoreH = 38 * ds;
    const py = height - rowH - scoreH - 12 * ds;
    const digits = String(
      Math.max(0, Math.min(9999999, Math.round(judge.percentDancePoints * 1000000))),
    ).padStart(7, '0');
    const diff = v.meta.difficulty.toUpperCase();
    const grade = judge.grade;
    const m = 4 * ds; // sprite margin for the trim strokes

    const paint = (c: CanvasRenderingContext2D): void =>
      paintScorePanel(c, pw, rowH, scoreH, ds, m, digits, diff, grade);

    const spr = this.store.slot(
      'score',
      `${digits}|${grade}|${diff}|${Math.round(pw)}`,
      pw + 2 * m,
      rowH + scoreH + 2 * ds + 2 * m,
      paint,
    );
    ctx.save();
    if (spr) ctx.drawImage(spr, px - m, py - m, pw + 2 * m, rowH + scoreH + 2 * ds + 2 * m);
    else {
      ctx.translate(px - m, py - m);
      paint(ctx);
    }
    ctx.restore();
  }

  /** A3 judgment: Title Case rounded lettering — color-gradient core, white
   *  rim, colored glow — squashing in vertically and vanishing with no fade.
   *  Marvelous adds the fast white shimmer. Lettering is cached per tier. */
  private drawJudgmentLabel(ctx: CanvasRenderingContext2D, v: FieldView, fb: Feedback): void {
    if (!fb.lastJudgment) return;
    const age = v.nowSeconds - fb.lastJudgment.atSeconds;
    const tns = fb.lastJudgment.tns;
    const j = this.judgments[tns];
    if (!j || age < 0 || age >= JUDGMENT_LIFE) return;
    const ink = JUDGMENT_INK[tns] ?? JUDGMENT_INK[TapNoteScore.W4];
    const { ds } = v;
    const cx = v.fieldLeft + (v.numTracks * v.colW) / 2;
    const dir = v.reverse ? -1 : 1;
    const y = v.receptorY + dir * 1.38 * v.colW;
    // Squash-in: zoomy 1.5 -> 1 across the first 0.036s (metrics.ini tween).
    const squash = age < 0.036 ? 1.5 - 0.5 * (age / 0.036) : 1;
    const px = 37 * ds;
    const pad = 18 * ds;
    const shimmer = tns === TapNoteScore.W1 && Math.floor(age / 0.025) % 2 === 0;

    ctx.save();
    ctx.translate(cx, y);
    ctx.scale(1, squash);
    const textW = measureWidth(roundFont(px), j.label);
    const spr =
      textW === null
        ? null
        : this.store.sprite(`judg:${tns}`, textW + 2 * pad, px * 1.1 + 2 * pad, (c) =>
            paintJudgment(c, j.label, ink, px, ds, pad, false),
          );
    if (spr && textW !== null) {
      const w = textW + 2 * pad;
      const h = px * 1.1 + 2 * pad;
      ctx.drawImage(spr, -w / 2, -(pad + px * 0.78), w, h);
      if (shimmer) {
        const shine = this.store.sprite(`judgshine:${tns}`, w, h, (c) =>
          paintJudgment(c, j.label, ink, px, ds, pad, true),
        );
        if (shine) {
          ctx.globalAlpha = 0.35;
          ctx.drawImage(shine, -w / 2, -(pad + px * 0.78), w, h);
        }
      }
    } else {
      // Direct fallback (no offscreen canvas): centered at the origin.
      ctx.textAlign = 'center';
      ctx.lineJoin = 'round';
      ctx.font = roundFont(px);
      ctx.shadowColor = ink[2];
      ctx.shadowBlur = 9 * ds;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 7.5 * ds;
      ctx.strokeText(j.label, 0, 0);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(14,14,20,0.95)';
      ctx.lineWidth = 3.4 * ds;
      ctx.strokeText(j.label, 0, 0);
      const g = ctx.createLinearGradient(0, -px * 0.78, 0, px * 0.12);
      g.addColorStop(0, ink[0]);
      g.addColorStop(1, ink[1]);
      ctx.fillStyle = g;
      ctx.fillText(j.label, 0, 0);
      if (shimmer) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillText(j.label, 0, 0);
      }
    }
    ctx.restore();
  }

  /** Combo: big tier-tinted numerals (black outline + white rim) with the
   *  lowercase "combo" word sharing the baseline, pulsing on each step.
   *  Cached; re-rendered only when the count/tint changes. */
  private drawCombo(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    judge: Judge,
    fb: Feedback,
    comboPopAt: number,
  ): void {
    if (judge.combo < 4) return;
    const { ds } = v;
    const cx = v.fieldLeft + (v.numTracks * v.colW) / 2;
    const dir = v.reverse ? -1 : 1;
    const yMid = v.receptorY + dir * 2.42 * v.colW;
    const tint = (fb.lastJudgment && COMBO_TINT[fb.lastJudgment.tns]) || COMBO_PLAIN;
    // Numerals step up with combo magnitude (A3's zoom ladder).
    const c = judge.combo;
    const count = String(c);
    const zoom = c >= 1000 ? 0.78 : c >= 100 ? 0.9 : 0.6 + 0.03 * Math.min(9, Math.floor(c / 10));
    const px = v.colW * zoom;
    // Pulse ~x1.3 settling in 0.05s on each increment (A3 PulseCommand).
    const k = Math.max(0, Math.min(1, (v.nowSeconds - comboPopAt) / 0.05));
    const pop = 1 + 0.3 * (1 - k);
    const baseline = yMid + px * 0.36;
    const joinX = cx + 0.34 * v.colW;

    ctx.save();
    ctx.translate(joinX, baseline);
    ctx.scale(pop, pop);
    const numW = measureWidth(roundFont(px), count);
    const wordW = measureWidth(roundFont(px * 0.42), 'combo');
    if (numW !== null && wordW !== null) {
      const pad = px * 0.14;
      const joinOff = pad + numW * 0.84;
      const w = joinOff + 6 * ds + wordW + pad;
      const baseY = px * 0.92;
      const h = px * 1.12;
      const spr = this.store.slot(
        'combo',
        `${count}|${tint[1]}|${Math.round(px * 10)}`,
        w,
        h,
        (cc) => paintCombo(cc, count, tint, px, ds, joinOff, baseY),
      );
      if (spr) {
        ctx.drawImage(spr, -joinOff, -baseY, w, h);
        ctx.restore();
        return;
      }
    }
    // Direct fallback.
    paintCombo(ctx, count, tint, px, ds, 0, 0);
    ctx.restore();
  }
}
