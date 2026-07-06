/**
 * Simply Love (ITGmania) theme — the persisted 'itg' noteSkin. A left-aligned
 * playfield over the SL background filter, cel-noteskin arrows, and the SL
 * gameplay chrome: song meter + LifeMeterBar + Wendy score stacked in a side
 * panel to the right of the field (no top header, so the field runs the full
 * height), the step-density graph along the bottom, and judgment/combo drawn
 * over the notes (SL draworder 101). Extracted from the original
 * NoteFieldRenderer 'itg' path; hold bodies have since been upgraded (cel
 * sheen bands + engaged rim, no shadowBlur).
 */

import type { ActiveNote, Judge } from '../../gameplay/judge';
import { NoteType, TapNoteScore, TapNoteType } from '../../notes/noteTypes';
import type { Feedback, FieldView, JudgmentStyle, TapNoteStyle, Theme } from '../theme';

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

export class SimplyLoveTheme implements Theme {
  readonly quantColor = ITG_QUANT_COLOR;
  readonly judgments = ITG_JUDGMENT;
  readonly explosionSeconds = ITG_EXPLOSION;
  /** The ITG field seats its receptors high (no top header). */
  readonly receptorOffset = 78;

  // Cached per-measure NPS histogram for the SL step-density graph.
  private density: {
    src: unknown;
    bins: Array<{ t0: number; t1: number; h: number }>;
    lastT: number;
  } | null = null;

  /** Left-aligned in gameplay (the HUD fills the space to its right), but
   *  centered in the bare preview. */
  fieldLeft(v: FieldView): number {
    if (v.bare) return (v.width - v.numTracks * v.colW) / 2;
    return 48 * v.ds;
  }

  /** Notefield filter (SL BackgroundFilter): a plain dark strip behind the
   *  lanes, flushed red on the beat while the life meter is in danger. */
  drawFieldChrome(ctx: CanvasRenderingContext2D, v: FieldView, judge: Judge): void {
    const { ds, height } = v;
    const fieldW = v.numTracks * v.colW;
    const fieldL = v.fieldLeft;
    ctx.fillStyle = 'rgba(3,4,6,0.5)';
    ctx.fillRect(fieldL - 8 * ds, 0, fieldW + 16 * ds, height);
    if (!judge.failed && judge.life < 0.25) {
      ctx.fillStyle = `rgba(255,32,32,${(0.06 + 0.1 * v.beatPulse).toFixed(3)})`;
      ctx.fillRect(fieldL - 8 * ds, 0, fieldW + 16 * ds, height);
    }
  }

  /**
   * Simply Love gameplay chrome, drawn to the right of the left-aligned field
   * (no top header, so the field runs full-height): the bordered song meter
   * (title inside, SongInfoBar.lua), the LifeMeterBar with its scrolling
   * swoosh sheen (LifeMeter/Standard.lua), the Wendy dance-percentage
   * (Score.lua), the difficulty, and the step-density graph along the bottom.
   * Drawn before the notes, like SL's underlay.
   */
  drawHudUnderlay(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    judge: Judge,
    progress: number,
    _fb: Feedback,
    _comboPopAt: number,
  ): void {
    const { width, ds } = v;
    const beat = v.nowBeat;
    const fieldR = v.fieldLeft + v.numTracks * v.colW;
    const bd = 3 * ds; // frame thickness (SL: 2px of a 480-tall screen)

    // Info panel to the right of the field.
    const px = fieldR + 40 * ds;
    const pW = Math.max(120 * ds, Math.min(360 * ds, width - px - 24 * ds));
    const prog = Math.max(0, Math.min(1, progress));
    ctx.save();

    // Song meter: white frame, black well, accent stream + title inside.
    const mY = 34 * ds;
    const mH = 32 * ds;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px, mY, pW, mH);
    ctx.fillStyle = '#000000';
    ctx.fillRect(px + bd, mY + bd, pW - 2 * bd, mH - 2 * bd);
    ctx.fillStyle = SL_ACCENT;
    ctx.fillRect(px + bd, mY + bd, (pW - 2 * bd) * prog, mH - 2 * bd);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = font(ds, 700, 15);
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowOffsetY = 1.5 * ds;
    ctx.fillText(v.meta.title || 'stepzone', px + pW / 2, mY + mH / 2, pW - 16 * ds);
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetY = 0;
    if (v.meta.subtitle) {
      ctx.fillStyle = 'rgba(236,236,236,0.55)';
      ctx.font = font(ds, 400, 12);
      ctx.textBaseline = 'top';
      ctx.fillText(v.meta.subtitle, px + pW / 2, mY + mH + 6 * ds, pW);
    }

    // LifeMeterBar: white frame, black well, accent fill that turns white when
    // full ("Hot"), plus the beat-scrolled swoosh highlight.
    const lY = mY + mH + 30 * ds;
    const lH = 26 * ds;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px, lY, pW, lH);
    ctx.fillStyle = '#000000';
    ctx.fillRect(px + bd, lY + bd, pW - 2 * bd, lH - 2 * bd);
    const life = judge.failed ? 0 : judge.life;
    const hot = life >= 1;
    if (life > 0) {
      const lwIn = pW - 2 * bd;
      const fw = Math.max(2, lwIn * life);
      const fX = px + bd;
      const fY = lY + bd;
      const fH = lH - 2 * bd;
      ctx.fillStyle = hot ? '#ffffff' : SL_ACCENT;
      ctx.fillRect(fX, fY, fw, fH);
      // Swoosh: SL scrolls a soft diagonal gradient across the fill at half
      // the song's BPS, at alpha .2 (full strength while Hot).
      ctx.save();
      ctx.beginPath();
      ctx.rect(fX, fY, fw, fH);
      ctx.clip();
      const p = 1 - ((beat * 0.5) % 1);
      const gx0 = fX + (p * 2 - 2) * lwIn;
      const sw = ctx.createLinearGradient(gx0, fY + fH, gx0 + 2 * lwIn, fY);
      sw.addColorStop(0, 'rgba(255,255,255,0)');
      sw.addColorStop(0.5, `rgba(255,255,255,${hot ? 0.5 : 0.22})`);
      sw.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sw;
      ctx.fillRect(fX, fY, fw, fH);
      ctx.restore();
    }

    // Dance percentage (Score.lua: big Wendy digits, no "%") and difficulty.
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ececec';
    ctx.font = font(ds, 800, 44);
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(1 * ds).toFixed(2)}px`;
    ctx.fillText((judge.percentDancePoints * 100).toFixed(2) + '%', px + pW, lY + lH + 52 * ds);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.textAlign = 'left';
    ctx.fillStyle = SL_ACCENT;
    ctx.font = font(ds, 700, 15);
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(2 * ds).toFixed(2)}px`;
    ctx.fillText(v.meta.difficulty.toUpperCase(), px, lY + lH + 78 * ds);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.restore();

    this.drawDensityGraph(ctx, v, judge);
  }

  /**
   * Cel receptor: the cel silhouette in neutral silver, pulsing bright on
   * each beat (the skin's diffuseramp between 10% grey and white), with the
   * inset stem panel from the "Receptor Go" texture. A press blooms it white
   * and dips the scale, like the common noteskin's PressCommand.
   */
  drawReceptor(ctx: CanvasRenderingContext2D, v: FieldView, track: number, pressed: boolean): void {
    const s = v.arrowS;
    const ds = v.ds;
    const f = v.beatPulse * v.beatPulse; // sharp attack on the beat, quick decay
    const val = pressed ? 246 : Math.round(112 + 104 * f);
    ctx.save();
    ctx.translate(v.laneX(track), v.receptorY);
    ctx.rotate(v.angle(track));
    if (pressed) ctx.scale(0.92, 0.92);
    paintCelReceptor(ctx, s, ds, val, pressed);
    ctx.restore();
  }

  /**
   * Cel-noteskin tap note (the Simply Love default): the classic beveled ITG
   * arrow — notched-chevron silhouette with a near-black rim, a silver bevel
   * band, a flat quantization-colored face with a light cel shade, and the
   * animated stripe scrolling through the stem (the model's "scroller" mesh,
   * which cel scrolls one texture-height per beat). ITG freeze heads share the
   * tap look; dead (dropped/missed) heads grey out like their body.
   */
  drawTapNote(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    track: number,
    y: number,
    quant: NoteType,
    style: TapNoteStyle,
  ): void {
    const s = v.arrowS;
    const ds = v.ds;
    const dead = style === 'deadHead';
    const faceColor = dead ? '#7c8087' : this.quantColor[quant];
    ctx.save();
    ctx.translate(v.laneX(track), y);
    ctx.rotate(v.angle(track));
    paintCelTapBase(ctx, s, ds, faceColor, dead);
    // Animated center stripe: a soft highlight sweeping tip→tail each beat
    // (drawn twice, one period apart, so the wrap is seamless). A dead head
    // stays inert — no animation on something already scored.
    if (style !== 'deadHead') {
      ctx.clip();
      const frac = v.nowBeat - Math.floor(v.nowBeat);
      for (const yC of [-s + frac * 2 * s, -3 * s + frac * 2 * s]) {
        const sg = ctx.createLinearGradient(0, yC - 0.9 * s, 0, yC + 0.9 * s);
        sg.addColorStop(0, 'rgba(255,255,255,0)');
        sg.addColorStop(0.5, 'rgba(255,255,255,0.34)');
        sg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sg;
        ctx.fillRect(-0.188 * s, -s, 0.376 * s, 2 * s);
      }
    }
    ctx.restore();
  }

  /** Cel mine: a dark metal orb with three rotating shell plates and a red
   *  core pulsing on the beat ("_mine tex.png" / "_mine model.txt"). */
  drawMine(ctx: CanvasRenderingContext2D, v: FieldView, x: number, y: number): void {
    const r = v.arrowS * 0.66;
    const beatPulse = v.beatPulse;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(v.nowSeconds * 2.2);
    paintCelMineBody(ctx, r, v.ds);
    ctx.fillStyle = `rgba(255,48,48,${(0.55 + 0.45 * beatPulse).toFixed(3)})`;
    ctx.shadowColor = 'rgba(255,48,48,0.8)';
    ctx.shadowBlur = 10 * v.ds * (0.5 + beatPulse);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Cel hold: a light silver tube with dark side rims, cel sheen bands
   *  riding the body, and a rounded tail cap ("Down Hold Body Active.png");
   *  grey once dropped, rimmed bright and beat-shimmering while engaged
   *  (no shadowBlur — cheap flat fills only). */
  drawHoldBody(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    track: number,
    top: number,
    bottom: number,
    held: boolean,
    alive: boolean,
    _roll: boolean,
  ): void {
    const ds = v.ds;
    const x = v.laneX(track);
    const w = v.arrowS * 1.5;
    const r = w / 2;
    const h = Math.max(1, bottom - top);
    const caps: [number, number, number, number] = v.reverse ? [r, r, 0, 0] : [0, 0, r, r];
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x - w / 2, top, w, h, caps);
    ctx.save();
    ctx.clip();
    // Cylindrical silver tube.
    const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    if (alive) {
      g.addColorStop(0, 'rgba(148,154,162,0.95)');
      g.addColorStop(0.18, 'rgba(238,240,244,0.95)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.82, 'rgba(210,214,220,0.95)');
      g.addColorStop(1, 'rgba(128,133,141,0.95)');
    } else {
      g.addColorStop(0, 'rgba(70,72,78,0.8)');
      g.addColorStop(0.5, 'rgba(118,122,128,0.8)');
      g.addColorStop(1, 'rgba(70,72,78,0.8)');
    }
    ctx.fillStyle = g;
    ctx.fillRect(x - w / 2, top, w, h);
    // Cel sheen bands anchored at the head end, so they ride with the hold.
    const period = 26 * ds;
    const dir = v.reverse ? -1 : 1;
    const yStart = v.reverse ? bottom : top;
    ctx.fillStyle = alive ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.10)';
    for (let k = 8 * ds; k < h + period; k += period) {
      const yy = yStart + dir * k;
      ctx.fillRect(x - w / 2, dir > 0 ? yy - 4 * ds : yy, w, 4 * ds);
    }
    // Dark side rims give the tube its cel depth.
    ctx.fillStyle = alive ? 'rgba(20,22,26,0.5)' : 'rgba(20,22,26,0.35)';
    ctx.fillRect(x - w / 2, top, 2.2 * ds, h);
    ctx.fillRect(x + w / 2 - 2.2 * ds, top, 2.2 * ds, h);
    // Engaged: beat-driven shimmer washing the tube.
    if (alive && held) {
      ctx.fillStyle = `rgba(255,255,255,${(0.1 + 0.16 * v.beatPulse).toFixed(3)})`;
      ctx.fillRect(x - w / 2, top, w, h);
    }
    ctx.restore();
    // Outline; engaged holds get a bright rim instead of a blur glow.
    ctx.lineWidth = 2 * ds;
    ctx.strokeStyle = alive ? '#14161a' : 'rgba(20,22,26,0.6)';
    ctx.stroke();
    if (alive && held) {
      ctx.strokeStyle = `rgba(255,255,255,${(0.35 + 0.35 * v.beatPulse).toFixed(3)})`;
      ctx.lineWidth = 1.2 * ds;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Hit explosion: the cel "Tap Explosion" — the arrow silhouette blooming
   * in the judgment color with a white-hot core, scaling up as it fades
   * (the "Down Tap Explosion Dim/Bright" sprites; Fantastics run brighter).
   */
  drawExplosion(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    track: number,
    tns: TapNoteScore,
    k: number,
  ): void {
    const ds = v.ds;
    const fade = 1 - k;
    const j = this.judgments[tns];
    const color = j ? j.color : '#ffffff';
    const bright = tns === TapNoteScore.W1;
    ctx.save();
    ctx.translate(v.laneX(track), v.receptorY);
    ctx.rotate(v.angle(track));
    const sc = 1 + 0.18 * k;
    ctx.scale(sc, sc);
    paintCelExplosion(ctx, v.arrowS, ds, color, bright, fade);
    ctx.restore();
  }

  /**
   * SL overlay, drawn above the notes: the judgment label in the ITG colors
   * with the "Love" graphic's soft same-color glow and SL's zoom tween
   * (pop in slightly large, settle, hold, shrink away), and the bare combo
   * digits below — white, or pulsing SL's full-combo blue/gold/green pairs.
   */
  drawHudOverlay(
    ctx: CanvasRenderingContext2D,
    v: FieldView,
    judge: Judge,
    _progress: number,
    fb: Feedback,
    comboPopAt: number,
  ): void {
    const { ds } = v;
    const now = v.nowSeconds;
    // Centered over the (left-aligned) field, not the whole screen.
    const cx = v.fieldLeft + (v.numTracks * v.colW) / 2;
    const recY = v.receptorY;
    // Anchored inside the field past the receptor line (flips under reverse).
    const anchorY = v.reverse ? recY - 215 * ds : recY + 215 * ds;

    if (fb.lastJudgment) {
      const age = now - fb.lastJudgment.atSeconds;
      const j = this.judgments[fb.lastJudgment.tns];
      if (j && age >= 0 && age < SL_JUDGMENT_LIFE) {
        const t = age / SL_JUDGMENT_LIFE;
        // SL's tween: zoom 0.8 → decelerate 0.75 → sleep → accelerate 0.
        let pop: number;
        if (t < 0.111) {
          const k = t / 0.111;
          pop = 1 + 0.067 * (1 - k * (2 - k));
        } else if (t < 0.778) {
          pop = 1;
        } else {
          const k = (t - 0.778) / 0.222;
          pop = Math.max(0, 1 - k * k);
        }
        if (pop > 0.02) {
          ctx.save();
          ctx.translate(cx, anchorY - 26 * ds);
          ctx.scale(pop, pop);
          ctx.textAlign = 'center';
          ctx.font = font(ds, 800, 34);
          if ('letterSpacing' in ctx) ctx.letterSpacing = `${(1.5 * ds).toFixed(2)}px`;
          ctx.shadowColor = j.color;
          ctx.shadowBlur = 18 * ds;
          ctx.fillStyle = j.color;
          ctx.fillText(j.label, 0, 0);
          ctx.shadowBlur = 0;
          ctx.lineWidth = 1.2 * ds;
          ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.strokeText(j.label, 0, 0);
          ctx.restore();
        }
      }
    }

    // Combo: digits only (SL shows no label), visible from 4 (ShowComboAt).
    if (judge.combo > 3) {
      const tc = judge.tapCounts;
      const broken =
        (tc[TapNoteScore.Miss] ?? 0) + (tc[TapNoteScore.W5] ?? 0) + (tc[TapNoteScore.W4] ?? 0);
      const w3 = tc[TapNoteScore.W3] ?? 0;
      const w2 = tc[TapNoteScore.W2] ?? 0;
      let pulse: readonly [string, string] | null = null;
      if (broken === 0) {
        if (w3 === 0 && w2 === 0) pulse = SL_COMBO_W1;
        else if (w3 === 0) pulse = SL_COMBO_W2;
        else pulse = SL_COMBO_W3;
      }
      let fill = 'rgba(255,255,255,0.98)';
      if (pulse) {
        const ph = (now % 0.8) / 0.8; // SL's diffuseshift, 0.8s period
        fill = lerpHex(pulse[0], pulse[1], ph < 0.5 ? ph * 2 : (1 - ph) * 2);
      }
      const k = Math.max(0, Math.min(1, (now - comboPopAt) / 0.13));
      const pop = 1 + 0.08 * (1 - k);
      ctx.save();
      ctx.translate(cx, anchorY + 36 * ds);
      ctx.scale(pop, pop);
      ctx.textAlign = 'center';
      ctx.font = font(ds, 800, 48);
      // Hard 45° drop shadow, like SL's shadowlength on the combo font.
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowOffsetX = 2 * ds;
      ctx.shadowOffsetY = 2 * ds;
      ctx.fillStyle = fill;
      ctx.fillText(String(judge.combo), 0, 0);
      ctx.restore();
    }
  }

  /**
   * SL step-density graph: per-measure NPS as a filled silhouette, blue at
   * the baseline blending toward purple at the peak (SL-Histogram.lua's
   * vertex colors), over the #1E282F backing, with the already-played span
   * swept to black like UpperNPSGraph's ProgressQuad.
   */
  private drawDensityGraph(ctx: CanvasRenderingContext2D, v: FieldView, judge: Judge): void {
    const { width, height, ds } = v;
    if (this.density?.src !== judge.notes) this.buildDensity(judge.notes);
    const dg = this.density;
    if (!dg || dg.bins.length < 2 || dg.lastT <= 0) return;
    const H = 44 * ds;
    const top = height - H;
    ctx.save();
    ctx.fillStyle = SL_GRAPH_BG;
    ctx.fillRect(0, top, width, H);
    const xOf = (t: number) => (t / dg.lastT) * width;
    const g = ctx.createLinearGradient(0, height, 0, top);
    g.addColorStop(0, SL_GRAPH_LO);
    g.addColorStop(1, SL_GRAPH_HI);
    ctx.beginPath();
    ctx.moveTo(xOf(dg.bins[0].t0), height);
    for (const b of dg.bins) ctx.lineTo(xOf(b.t0), height - b.h * H);
    const last = dg.bins[dg.bins.length - 1];
    ctx.lineTo(xOf(last.t1), height);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    const played = Math.max(0, Math.min(1, v.nowSeconds / dg.lastT)) * width;
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(0, top, played, H);
    ctx.restore();
  }

  /**
   * Per-measure notes-per-second histogram (SL-Histogram's NPSperMeasure).
   * Measure-boundary times are interpolated from the chart's own (beat, time)
   * pairs, so BPM changes are respected without needing timing data here.
   * Cached per notes array; rebuilt when the song changes.
   */
  private buildDensity(notes: readonly ActiveNote[]): void {
    const bins: Array<{ t0: number; t1: number; h: number }> = [];
    const beats: number[] = [];
    const times: number[] = [];
    const counts = new Map<number, number>();
    let lastT = 0;
    let firstM = Infinity;
    let lastM = -1;
    for (const n of notes) {
      beats.push(n.beat);
      times.push(n.time);
      const end = n.note.type === TapNoteType.HoldHead ? n.tailTime : n.time;
      if (end > lastT) lastT = end;
      const kind = n.note.type;
      if (kind !== TapNoteType.Tap && kind !== TapNoteType.HoldHead && kind !== TapNoteType.Lift)
        continue;
      if (n.hidden) continue;
      const m = Math.floor(n.beat / 4);
      counts.set(m, (counts.get(m) ?? 0) + 1);
      if (m < firstM) firstM = m;
      if (m > lastM) lastM = m;
    }
    this.density = { src: notes, bins, lastT };
    if (lastM < 0 || beats.length < 2) return;
    // Piecewise-linear beat→time lookup; the cursor only moves forward since
    // measure boundaries are scanned in ascending order.
    let i = 0;
    const timeAt = (b: number): number => {
      while (i < beats.length - 1 && beats[i + 1] <= b) i++;
      let j = i;
      let k = i + 1;
      while (k < beats.length && beats[k] <= beats[j]) k++;
      if (k >= beats.length) {
        k = beats.length - 1;
        j = k - 1;
        while (j >= 0 && beats[j] >= beats[k]) j--;
        if (j < 0) return times[k]; // degenerate: the chart has no beat spread
      }
      const slope = (times[k] - times[j]) / (beats[k] - beats[j]);
      return Number.isFinite(slope) ? times[j] + (b - beats[j]) * slope : times[j];
    };
    let peak = 0;
    const raw: Array<{ t0: number; t1: number; nps: number }> = [];
    let t0 = timeAt(firstM * 4);
    for (let m = firstM; m <= lastM; m++) {
      const t1 = timeAt((m + 1) * 4);
      const nps = (counts.get(m) ?? 0) / Math.max(0.001, t1 - t0);
      raw.push({ t0, t1, nps });
      if (nps > peak) peak = nps;
      t0 = t1;
    }
    if (peak <= 0) return;
    for (const r of raw) bins.push({ t0: r.t0, t1: r.t1, h: Math.min(1, r.nps / peak) });
    const endT = raw[raw.length - 1].t1;
    if (endT > lastT) this.density.lastT = endT;
  }
}
