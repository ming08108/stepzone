/**
 * Simply Love (ITGmania) GPU skin — the 'itg' look on the WebGPU note field.
 * The cel-noteskin paint code lives in simplyLoveArt.ts; this skin bakes it
 * once into the atlas and drives it with
 * instanced quads: cel arrows (with the per-beat stem stripe as a masked,
 * vertically-scrolling overlay), silver hold tubes, the rotating mine, the
 * additive cel explosion, and the SL gameplay chrome — the side HUD panel
 * (song meter, LifeMeterBar with its scrolling swoosh, Wendy dance %,
 * difficulty) plus the bottom step-density graph, and the judgment/combo
 * over the notes.
 *
 * Layout differs from arcade: the field is left-aligned with the HUD in a
 * column to its right (no top header), receptors seated high, and no beat
 * guide lines. Chrome + density render UNDER the notes via the field's
 * underShapes batch; the side panel sits beside the field so it draws over.
 */

import type { ActiveNote, Judge } from '../../gameplay/judge';
import { NoteType, TapNoteScore, TapNoteType } from '../../notes/noteTypes';
import type { Feedback, TapNoteStyle } from '../types';
import { measureWidth } from './text';
import {
  CEL_FACE,
  font,
  ITG_EXPLOSION,
  ITG_JUDGMENT,
  ITG_QUANT_COLOR,
  lerpHex,
  paintCelExplosion,
  paintCelMineBody,
  paintCelReceptor,
  paintCelTapBase,
  SL_ACCENT,
  SL_COMBO_W1,
  SL_COMBO_W2,
  SL_COMBO_W3,
  SL_GRAPH_BG,
  SL_GRAPH_HI,
  SL_GRAPH_LO,
  SL_JUDGMENT_LIFE,
  traceCel,
} from './simplyLoveArt';
import type { AtlasRect } from './atlas';
import type { QuadOpts } from './quads';
import type { Tint } from './glyphs';
import type { ColorFn } from './shapes';
import type { GpuSkin, SkinCtx } from './skin';

/** Beat pulse weight (0..1): 1 exactly ON the beat, easing to 0 at the half-beat
 *  via a cosine — the smooth zoom StepMania's pulse()/effectclock("beat") gives. */
function beatSine(beat: number): number {
  return 0.5 + 0.5 * Math.cos(2 * Math.PI * (beat - Math.floor(beat)));
}

/** Parse #rgb/#rrggbb/rgb()/rgba() to straight-alpha floats (0..1). */
function parseColorUncached(s: string): [number, number, number, number] {
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const n =
      hex.length === 3
        ? hex.split('').map((c) => c + c)
        : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
    return [parseInt(n[0], 16) / 255, parseInt(n[1], 16) / 255, parseInt(n[2], 16) / 255, 1];
  }
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return [1, 1, 1, 1];
  const p = m[1].split(',').map((v) => parseFloat(v));
  return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
}

// Memoized: colors here are static palette strings, so the per-note / per-frame
// fills become a Map lookup instead of a re-parse + fresh array. The cached
// tuple is only ever read, never mutated, so sharing one instance is safe.
const colorCache = new Map<string, [number, number, number, number]>();
function parseColor(s: string): [number, number, number, number] {
  let c = colorCache.get(s);
  if (c === undefined) colorCache.set(s, (c = parseColorUncached(s)));
  return c;
}

const WHITE_TINT: Tint = [1, 1, 1, 1];
const SL_PCT_TINT: Tint = parseColor('#ececec'); // dance % ink (glyphs bake white)
const SL_PCT_CHARS = '0123456789.%'; // prewarmed so the live % never rasterizes

/** Corner list for a rect, for ShapeBatch.poly (convex). */
function rect(x: number, y: number, w: number, h: number): Array<[number, number]> {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

const SL_QUANTS: NoteType[] = [
  NoteType.N4TH,
  NoteType.N8TH,
  NoteType.N12TH,
  NoteType.N16TH,
  NoteType.N24TH,
  NoteType.N32ND,
  NoteType.N48TH,
  NoteType.N64TH,
  NoteType.N192ND,
];

export class SimplyLoveGpuSkin implements GpuSkin {
  readonly receptorOffset = 78;
  readonly explosionSeconds = ITG_EXPLOSION;
  readonly beatLines = false;

  // Cached per-song NPS histogram for the density graph (SL-Histogram).
  private density: {
    src: unknown;
    bins: Array<{ t0: number; t1: number; h: number }>;
    lastT: number;
  } | null = null;

  // Hot-path zero-alloc: cache baked rects by a STABLE key (face color, kind,
  // 'stripe'…) so per-note/hold/mine draws are Map lookups — no template-string
  // key or paint closure built per frame. Reused opts objects for the rotation
  // (and masked-stripe) pushes avoid a `{…}` alloc per quad. Reset on clear().
  private readonly rectCache = new Map<string, AtlasRect | null>();
  /** Per-view eased dance % (0..1) + last timestamp, so the readout counts up
   *  smoothly toward the real score instead of snapping on each hit. */
  private readonly scoreShown = new Map<string, { v: number; t: number }>();
  private readonly rotOpt: QuadOpts = { rot: 0 };
  private readonly stripeOpt: QuadOpts = { rot: 0, mask: undefined, phaseV: 0 };
  private readonly repeatOpt: QuadOpts = { repeatV: 0 };
  private readonly addOpt: QuadOpts = { add: true };
  /** ITG quant face color parsed to a float tint once, for the held-freeze glow. */
  private readonly glowTint = new Map<NoteType, Tint>();
  /** Reused 4-point buffer for the density trapezoids (no per-bin array alloc). */
  private readonly densitySeg: [number, number][] = [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];

  fieldLeft(bare: boolean, width: number, numTracks: number, colW: number, ds: number): number {
    if (bare) return (width - numTracks * colW) / 2;
    return 48 * ds;
  }

  clear(): void {
    this.density = null;
    this.rectCache.clear();
  }

  // --- sprite bakers ---------------------------------------------------------

  /** Padding around the cel outline (reaches ~1.0 of s, plus the 2.5·ds rim). */
  private pad(ctx: SkinCtx): number {
    return ctx.arrowS + 4 * ctx.ds;
  }

  private sprTap(ctx: SkinCtx, faceColor: string): AtlasRect | null {
    const hit = this.rectCache.get(faceColor);
    if (hit !== undefined) return hit;
    const s = ctx.arrowS;
    const ds = ctx.ds;
    const m = this.pad(ctx);
    const rect = ctx.atlas.sprite(`sltap:${faceColor}:${Math.round(s)}`, 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintCelTapBase(c, s, ds, faceColor, faceColor === '#7c8087');
    });
    this.rectCache.set(faceColor, rect);
    return rect;
  }

  /** White CEL_FACE alpha — clips the stem stripe to the arrow face. */
  private sprFaceMask(ctx: SkinCtx): AtlasRect | null {
    const hit = this.rectCache.get('facemask');
    if (hit !== undefined) return hit;
    const s = ctx.arrowS;
    const m = this.pad(ctx);
    const rect = ctx.atlas.sprite(`slfacemask:${Math.round(s)}`, 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      traceCel(c, s, CEL_FACE);
      c.fillStyle = '#ffffff';
      c.fill();
    });
    this.rectCache.set('facemask', rect);
    return rect;
  }

  /** One vertical white bump in the stem column; scrolled via phaseV, masked
   *  by the face. Transparent at top/bottom so the wrap is seamless. */
  private sprStripe(ctx: SkinCtx): AtlasRect | null {
    const hit = this.rectCache.get('stripe');
    if (hit !== undefined) return hit;
    const s = ctx.arrowS;
    const m = this.pad(ctx);
    const rect = ctx.atlas.sprite(`slstripe:${Math.round(s)}`, 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      const g = c.createLinearGradient(0, -m, 0, m);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.34)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(-0.188 * s, -m, 0.376 * s, 2 * m);
    });
    this.rectCache.set('stripe', rect);
    return rect;
  }

  private sprReceptor(ctx: SkinCtx, kind: 'dim' | 'bright' | 'press'): AtlasRect | null {
    const hit = this.rectCache.get(kind);
    if (hit !== undefined) return hit;
    const s = ctx.arrowS;
    const ds = ctx.ds;
    const m = this.pad(ctx);
    const val = kind === 'press' ? 246 : kind === 'bright' ? 216 : 112;
    const rect = ctx.atlas.sprite(`slrec:${kind}:${Math.round(s)}`, 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintCelReceptor(c, s, ds, val, kind === 'press');
    });
    this.rectCache.set(kind, rect);
    return rect;
  }

  private sprMineBody(ctx: SkinCtx): AtlasRect | null {
    const hit = this.rectCache.get('minebody');
    if (hit !== undefined) return hit;
    const r = ctx.arrowS * 0.66;
    const ds = ctx.ds;
    const m = r + 3 * ds;
    const rect = ctx.atlas.sprite(`slminebody:${Math.round(r)}`, 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintCelMineBody(c, r, ds);
    });
    this.rectCache.set('minebody', rect);
    return rect;
  }

  private sprMineCore(ctx: SkinCtx): AtlasRect | null {
    const hit = this.rectCache.get('minecore');
    if (hit !== undefined) return hit;
    const r = ctx.arrowS * 0.66;
    const ds = ctx.ds;
    const m = r * 0.3 + 12 * ds; // room for the glow
    const rect = ctx.atlas.sprite(`slminecore:${Math.round(r)}`, 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      c.shadowColor = 'rgba(255,48,48,0.8)';
      c.shadowBlur = 12 * ds;
      c.fillStyle = '#ff3030';
      c.beginPath();
      c.arc(0, 0, r * 0.3, 0, Math.PI * 2);
      c.fill();
    });
    this.rectCache.set('minecore', rect);
    return rect;
  }

  private boomPad(ctx: SkinCtx): number {
    return ctx.arrowS + 32 * ctx.ds; // room for the glow + the 1.18× grow
  }

  private sprBoom(ctx: SkinCtx, tns: number): AtlasRect | null {
    const s = ctx.arrowS;
    const ds = ctx.ds;
    const m = this.boomPad(ctx);
    const j = ITG_JUDGMENT[tns];
    const color = j ? j.color : '#ffffff';
    const bright = tns === TapNoteScore.W1;
    return ctx.atlas.sprite(`slboom:${tns}:${Math.round(s)}`, 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintCelExplosion(c, s, ds, color, bright, 1);
    });
  }

  /** Arrow-tip tail cap: a silver triangle tapering to a point (matches the
   *  note), so the freeze ends in an arrow shape rather than a flat tube. */
  private sprHoldCap(ctx: SkinCtx, alive: boolean): AtlasRect | null {
    const ck = alive ? 'cap1' : 'cap0';
    const hit = this.rectCache.get(ck);
    if (hit !== undefined) return hit;
    const w = ctx.arrowS * 1.5;
    const capH = Math.max(1, Math.round(w * 0.5));
    const rect = ctx.atlas.sprite(`slcap:${alive}:${Math.round(w)}`, w, capH, (c) => {
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(w, 0);
      c.lineTo(w / 2, capH);
      c.closePath();
      const g = c.createLinearGradient(0, 0, w, 0);
      if (alive) {
        g.addColorStop(0, 'rgba(148,154,162,0.95)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.95)');
        g.addColorStop(1, 'rgba(128,133,141,0.95)');
      } else {
        g.addColorStop(0, 'rgba(70,72,78,0.8)');
        g.addColorStop(0.5, 'rgba(118,122,128,0.8)');
        g.addColorStop(1, 'rgba(70,72,78,0.8)');
      }
      c.fillStyle = g;
      c.fill();
    });
    this.rectCache.set(ck, rect);
    return rect;
  }

  /** Horizontal silver gradient strip (constant down the tube). */
  private sprTube(ctx: SkinCtx, alive: boolean): AtlasRect | null {
    const ck = alive ? 'tube1' : 'tube0';
    const hit = this.rectCache.get(ck);
    if (hit !== undefined) return hit;
    const w = ctx.arrowS * 1.5;
    const rect = ctx.atlas.sprite(`sltube:${alive}:${Math.round(w)}`, w, 8, (c) => {
      const g = c.createLinearGradient(0, 0, w, 0);
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
      c.fillStyle = g;
      c.fillRect(0, 0, w, 8);
    });
    this.rectCache.set(ck, rect);
    return rect;
  }

  /** One 26·ds sheen period: a 4·ds white band at the top, transparent below. */
  private sprSheen(ctx: SkinCtx): AtlasRect | null {
    const hit = this.rectCache.get('sheen');
    if (hit !== undefined) return hit;
    const w = ctx.arrowS * 1.5;
    const ds = ctx.ds;
    const period = 26 * ds;
    const rect = ctx.atlas.sprite(
      `slsheen:${Math.round(w)}:${Math.round(period)}`,
      w,
      period,
      (c) => {
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, w, 4 * ds);
      },
    );
    this.rectCache.set('sheen', rect);
    return rect;
  }

  /** Soft round bloom behind an actively-held freeze head — additive, tinted to
   *  the note's quant color and pulsed with the beat. */
  private sprGlow(ctx: SkinCtx): AtlasRect | null {
    const hit = this.rectCache.get('glow');
    if (hit !== undefined) return hit;
    const r = ctx.arrowS + 14 * ctx.ds;
    const rect = ctx.atlas.sprite('slglow', 2 * r, 2 * r, (c) => {
      const g = c.createRadialGradient(r, r, 0, r, r, r);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 2 * r, 2 * r);
    });
    this.rectCache.set('glow', rect);
    return rect;
  }

  // --- art hooks -------------------------------------------------------------

  chrome(ctx: SkinCtx, judge: Judge, beatPulse: number): void {
    const ds = ctx.ds;
    const fieldW = ctx.numTracks * ctx.colW;
    const x0 = ctx.fieldLeft - 8 * ds;
    const w = fieldW + 16 * ds;
    const h = ctx.height;
    const dark: ColorFn = (_x, _y, o) => {
      o[0] = 3 / 255;
      o[1] = 4 / 255;
      o[2] = 6 / 255;
      o[3] = 0.5;
    };
    ctx.underShapes.poly(rect(x0, 0, w, h), dark);
    if (!judge.failed && judge.life < 0.25) {
      const a = 0.06 + 0.1 * beatPulse;
      const red: ColorFn = (_x, _y, o) => {
        o[0] = 1;
        o[1] = 32 / 255;
        o[2] = 32 / 255;
        o[3] = a;
      };
      ctx.underShapes.poly(rect(x0, 0, w, h), red);
    }
  }

  receptor(ctx: SkinCtx, track: number, pressed: boolean, beatPulse: number): void {
    const m = this.pad(ctx);
    const x = ctx.laneX(track);
    const y = ctx.receptorY;
    const o = this.rotOpt;
    o.rot = ctx.angle(track);
    if (pressed) {
      const spr = this.sprReceptor(ctx, 'press');
      if (spr) ctx.batch.push(x, y, 2 * m * 0.92, 2 * m * 0.92, spr, 1, 1, 1, 1, o);
      return;
    }
    const f = beatPulse * beatPulse;
    const dim = this.sprReceptor(ctx, 'dim');
    if (dim) ctx.batch.push(x, y, 2 * m, 2 * m, dim, 1, 1, 1, 1, o);
    if (f > 0.02) {
      const bright = this.sprReceptor(ctx, 'bright');
      if (bright) ctx.batch.push(x, y, 2 * m, 2 * m, bright, 1, 1, 1, f, o);
    }
  }

  note(
    ctx: SkinCtx,
    track: number,
    y: number,
    quant: NoteType,
    style: TapNoteStyle,
    _now: number,
    beat: number,
    _beatPulse: number,
  ): void {
    // Fixed size — no beat zoom; the interior animation is the stem stripe below.
    const m = this.pad(ctx);
    const dead = style === 'deadHead';
    const faceColor = dead ? '#7c8087' : ITG_QUANT_COLOR[quant];
    const x = ctx.laneX(track);
    const rot = ctx.angle(track);
    // An engaged freeze head glows: a quant-tinted bloom behind the face, pulsing
    // with the beat while the sustain is held.
    if (style === 'heldHead') {
      const glow = this.sprGlow(ctx);
      if (glow) {
        let tint = this.glowTint.get(quant);
        if (!tint) {
          tint = parseColor(ITG_QUANT_COLOR[quant]);
          this.glowTint.set(quant, tint);
        }
        const p = beatSine(beat);
        const gr = (ctx.arrowS + 14 * ctx.ds) * (1.05 + 0.18 * p);
        ctx.batch.push(
          x,
          y,
          2 * gr,
          2 * gr,
          glow,
          tint[0],
          tint[1],
          tint[2],
          0.3 + 0.35 * p,
          this.addOpt,
        );
      }
    }
    this.rotOpt.rot = rot;
    const base = this.sprTap(ctx, faceColor);
    if (base) ctx.batch.push(x, y, 2 * m, 2 * m, base, 1, 1, 1, 1, this.rotOpt);
    // Animated stem stripe (inert on a scored head), clipped to the face.
    if (!dead) {
      const stripe = this.sprStripe(ctx);
      const mask = this.sprFaceMask(ctx);
      if (stripe && mask) {
        const o = this.stripeOpt;
        o.rot = rot;
        o.mask = mask;
        o.phaseV = -(beat - Math.floor(beat));
        ctx.batch.push(x, y, 2 * m, 2 * m, stripe, 1, 1, 1, 1, o);
      }
    }
  }

  hold(
    ctx: SkinCtx,
    track: number,
    top: number,
    bottom: number,
    held: boolean,
    alive: boolean,
    _roll: boolean,
    beatPulse: number,
    _quant: NoteType, // ITG freeze bodies are silver, not quant-colored
  ): void {
    const ds = ctx.ds;
    const x = ctx.laneX(track);
    const w = ctx.arrowS * 1.5;
    const h = Math.max(1, bottom - top);
    const reverse = ctx.reverse;
    // Body stops short of a tapered arrow-tip tail (at the far end from the head).
    const capH = Math.min(w * 0.5, h);
    const bodyH = h - capH;
    const bodyCy = (reverse ? top + capH : top) + bodyH / 2;
    const white = ctx.white();
    // Silver tube.
    const tube = this.sprTube(ctx, alive);
    if (tube && bodyH > 0) ctx.batch.push(x, bodyCy, w, bodyH, tube, 1, 1, 1, 1);
    // Arrow-tip tail cap.
    const cap = this.sprHoldCap(ctx, alive);
    if (cap && capH > 0) {
      const capCy = reverse ? top + capH / 2 : bottom - capH / 2;
      ctx.batch.push(x, capCy, w, capH, cap, 1, 1, 1, 1, { flipV: reverse });
    }
    // Cel sheen bands riding the tube (tile anchored at the top).
    const sheen = this.sprSheen(ctx);
    if (sheen && bodyH > 0) {
      const a = alive ? 0.3 : 0.1;
      this.repeatOpt.repeatV = Math.max(1, bodyH / (26 * ds));
      ctx.batch.push(x, bodyCy, w, bodyH, sheen, 1, 1, 1, a, this.repeatOpt);
    }
    // Dark side rims.
    if (white && bodyH > 0) {
      const ra = alive ? 0.5 : 0.35;
      ctx.batch.push(x - w / 2 + 1.1 * ds, bodyCy, 2.2 * ds, bodyH, white, 20 / 255, 22 / 255, 26 / 255, ra); // prettier-ignore
      ctx.batch.push(x + w / 2 - 1.1 * ds, bodyCy, 2.2 * ds, bodyH, white, 20 / 255, 22 / 255, 26 / 255, ra); // prettier-ignore
      // Engaged: a brighter beat shimmer + glowing rims so a held freeze lights up.
      if (alive && held) {
        ctx.batch.push(x, bodyCy, w, bodyH, white, 1, 1, 1, 0.16 + 0.22 * beatPulse);
        const rim = 0.4 + 0.4 * beatPulse;
        ctx.batch.push(x - w / 2 + 0.6 * ds, bodyCy, 1.4 * ds, bodyH, white, 1, 1, 1, rim);
        ctx.batch.push(x + w / 2 - 0.6 * ds, bodyCy, 1.4 * ds, bodyH, white, 1, 1, 1, rim);
      }
    }
  }

  mine(ctx: SkinCtx, x: number, y: number, now: number, beatPulse: number): void {
    const r = ctx.arrowS * 0.66;
    const ds = ctx.ds;
    const mb = r + 3 * ds;
    const body = this.sprMineBody(ctx);
    if (body) {
      this.rotOpt.rot = now * 2.2;
      ctx.batch.push(x, y, 2 * mb, 2 * mb, body, 1, 1, 1, 1, this.rotOpt);
    }
    const core = this.sprMineCore(ctx);
    const mc = r * 0.3 + 12 * ds;
    if (core) ctx.batch.push(x, y, 2 * mc, 2 * mc, core, 1, 1, 1, 0.55 + 0.45 * beatPulse);
  }

  explosion(ctx: SkinCtx, track: number, tns: number, k: number): void {
    const spr = this.sprBoom(ctx, tns);
    if (!spr) return;
    const m = this.boomPad(ctx);
    const fade = 1 - k;
    const sc = 1 + 0.18 * k;
    ctx.batch.push(ctx.laneX(track), ctx.receptorY, 2 * m * sc, 2 * m * sc, spr, 1, 1, 1, fade, {
      rot: ctx.angle(track),
      add: true,
    });
  }

  // --- HUD -------------------------------------------------------------------

  hudUnderlay(ctx: SkinCtx, judge: Judge, progress: number, now: number, beat: number): void {
    this.drawPanel(ctx, judge, progress, beat, now);
    this.drawDensity(ctx, judge, now);
  }

  /** SL side panel: song meter, LifeMeterBar (+ swoosh), dance %, difficulty. */
  private drawPanel(ctx: SkinCtx, judge: Judge, progress: number, beat: number, now: number): void {
    const ds = ctx.ds;
    const white = ctx.white();
    if (!white) return;
    const fieldR = ctx.fieldLeft + ctx.numTracks * ctx.colW;
    const px = fieldR + 40 * ds;
    const pW = Math.max(120 * ds, Math.min(360 * ds, ctx.width - px - 24 * ds));
    const bd = 3 * ds;
    const prog = Math.max(0, Math.min(1, progress));

    const fill = (x: number, y: number, w: number, h: number, col: string): void => {
      const c = parseColor(col);
      ctx.shapes.poly(rect(x, y, w, h), (_x, _y, o) => {
        o[0] = c[0];
        o[1] = c[1];
        o[2] = c[2];
        o[3] = c[3];
      });
    };

    // Song meter: white frame, black well, accent progress.
    const mY = 34 * ds;
    const mH = 32 * ds;
    fill(px, mY, pW, mH, '#ffffff');
    fill(px + bd, mY + bd, pW - 2 * bd, mH - 2 * bd, '#000000');
    if (prog > 0) fill(px + bd, mY + bd, (pW - 2 * bd) * prog, mH - 2 * bd, SL_ACCENT);
    // Title (constant per song) baked into the well width.
    const title = ctx.meta.title || 'stepzone';
    const titleSpr = ctx.atlas.sprite(
      `sltitle:${title}:${Math.round(pW)}:${Math.round(mH)}`,
      pW,
      mH,
      (c) => {
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = font(ds, 700, 15);
        c.shadowColor = 'rgba(0,0,0,0.9)';
        c.shadowOffsetY = 1.5 * ds;
        c.fillStyle = '#ffffff';
        c.fillText(title, pW / 2, mH / 2, pW - 16 * ds);
      },
    );
    if (titleSpr) ctx.hud.push(px + pW / 2, mY + mH / 2, pW, mH, titleSpr, 1, 1, 1, 1);

    // LifeMeterBar: white frame, black well, accent (white when Hot) + swoosh.
    const lY = mY + mH + 30 * ds;
    const lH = 26 * ds;
    fill(px, lY, pW, lH, '#ffffff');
    fill(px + bd, lY + bd, pW - 2 * bd, lH - 2 * bd, '#000000');
    const life = judge.failed ? 0 : judge.life;
    const hot = life >= 1;
    if (life > 0) {
      const lwIn = pW - 2 * bd;
      const fw = Math.max(2, lwIn * life);
      const fX = px + bd;
      const fY = lY + bd;
      const fH = lH - 2 * bd;
      fill(fX, fY, fw, fH, hot ? '#ffffff' : SL_ACCENT);
      // Swoosh: a soft white band scrolling across the fill at half BPS.
      const swoosh = this.sprSwoosh(ctx);
      if (swoosh) {
        const phase = (beat * 0.5) % 1;
        ctx.hud.push(fX + fw / 2, fY + fH / 2, fw, fH, swoosh, 1, 1, 1, hot ? 0.5 : 0.22, {
          repeatU: Math.max(1, fw / lwIn),
          phaseU: -phase,
        });
      }
    }

    // Dance % (big Wendy digits, right-aligned): composited per-glyph so the
    // value changing every hit never re-rasterizes (the old repaint-in-place
    // slot baked a fresh texture each change — a per-hit stutter at 4K).
    // Ease the shown % toward the real score so it rolls up instead of snapping.
    const target = Math.max(0, Math.min(1, judge.percentDancePoints));
    const prev = this.scoreShown.get(ctx.viewKey);
    let shown = target;
    if (prev) {
      const dt = Math.max(0, now - prev.t);
      shown = prev.v + (target - prev.v) * (1 - Math.exp(-dt / 0.09));
      if (Math.abs(target - shown) < 1e-6) shown = target;
    }
    this.scoreShown.set(ctx.viewKey, { v: shown, t: now });
    const pct = (shown * 100).toFixed(2) + '%';
    const pctO = { px: 44 * ds, bakePx: Math.round(44 * ds), tracking: 1 * ds };
    ctx.glyphs.drawNumber(
      ctx.hud,
      'slpct',
      pct,
      px + pW - 4 * ds,
      lY + lH + 52 * ds,
      pctO,
      'right',
      () => SL_PCT_TINT,
    );
    const diff = ctx.meta.difficulty.toUpperCase();
    const dFont = font(ds, 700, 15);
    // measureWidth ignores letterSpacing, so add it back per gap.
    const dw =
      (measureWidth(dFont, diff) ?? diff.length * 9 * ds) +
      2 * ds * Math.max(0, diff.length - 1) +
      6 * ds;
    const dh = 22 * ds;
    const diffSpr = ctx.atlas.sprite(`sldiff:${diff}:${Math.round(ds * 10)}`, dw, dh, (c) => {
      c.textAlign = 'left';
      c.textBaseline = 'alphabetic';
      c.font = dFont;
      if ('letterSpacing' in c) c.letterSpacing = `${(2 * ds).toFixed(2)}px`;
      c.fillStyle = SL_ACCENT;
      c.fillText(diff, 2 * ds, 16 * ds);
      if ('letterSpacing' in c) c.letterSpacing = '0px';
    });
    if (diffSpr) ctx.hud.push(px + dw / 2, lY + lH + 72 * ds, dw, dh, diffSpr, 1, 1, 1, 1);
  }

  /** A soft white band, one period wide, for the LifeMeter swoosh scroll. */
  private sprSwoosh(ctx: SkinCtx): AtlasRect | null {
    return ctx.atlas.sprite('slswoosh', 128, 8, (c) => {
      const g = c.createLinearGradient(0, 0, 128, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 128, 8);
    });
  }

  /** SL step-density graph: per-measure NPS silhouette (blue→purple), the
   *  played span swept to black, under the notes (underShapes). */
  private drawDensity(ctx: SkinCtx, judge: Judge, now: number): void {
    if (this.density?.src !== judge.notes) this.buildDensity(judge.notes);
    const dg = this.density;
    if (!dg || dg.bins.length < 2 || dg.lastT <= 0) return;
    const { width, height, ds } = ctx;
    const H = 44 * ds;
    const top = height - H;
    const lo = parseColor(SL_GRAPH_LO);
    const hi = parseColor(SL_GRAPH_HI);
    const bg = parseColor(SL_GRAPH_BG);
    ctx.underShapes.poly(rect(0, top, width, H), (_x, _y, o) => {
      o[0] = bg[0];
      o[1] = bg[1];
      o[2] = bg[2];
      o[3] = bg[3];
    });
    const xOf = (t: number): number => (t / dg.lastT) * width;
    // Vertical blue→purple gradient by height above the baseline.
    const grad: ColorFn = (_x, y, o) => {
      const t = Math.max(0, Math.min(1, (height - y) / H));
      o[0] = lo[0] + (hi[0] - lo[0]) * t;
      o[1] = lo[1] + (hi[1] - lo[1]) * t;
      o[2] = lo[2] + (hi[2] - lo[2]) * t;
      o[3] = 1;
    };
    // Draw each measure segment as a trapezoid (baseline → the two bin tops).
    // One reused 4-point buffer instead of a fresh array-of-pairs per bin.
    const seg = this.densitySeg;
    for (let i = 0; i < dg.bins.length - 1; i++) {
      const a = dg.bins[i];
      const b = dg.bins[i + 1];
      const xa = xOf(a.t0);
      const xb = xOf(b.t0);
      seg[0][0] = xa;
      seg[0][1] = height;
      seg[1][0] = xa;
      seg[1][1] = height - a.h * H;
      seg[2][0] = xb;
      seg[2][1] = height - b.h * H;
      seg[3][0] = xb;
      seg[3][1] = height;
      ctx.underShapes.poly(seg, grad);
    }
    const played = Math.max(0, Math.min(1, now / dg.lastT)) * width;
    if (played > 0)
      ctx.underShapes.poly(rect(0, top, played, H), (_x, _y, o) => {
        o[0] = 0;
        o[1] = 0;
        o[2] = 0;
        o[3] = 0.85;
      });
  }

  /** Per-measure NPS histogram (ported from SimplyLoveTheme.buildDensity). */
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
        if (j < 0) return times[k];
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
    for (const rw of raw) bins.push({ t0: rw.t0, t1: rw.t1, h: Math.min(1, rw.nps / peak) });
    const endT = raw[raw.length - 1].t1;
    if (endT > lastT) this.density.lastT = endT;
  }

  hudOverlay(
    ctx: SkinCtx,
    judge: Judge,
    _progress: number,
    fb: Feedback,
    now: number,
    _beatPulse: number,
    comboPopAt: number,
  ): void {
    const ds = ctx.ds;
    const cx = ctx.fieldLeft + (ctx.numTracks * ctx.colW) / 2;
    const recY = ctx.receptorY;
    const anchorY = ctx.reverse ? recY - 215 * ds : recY + 215 * ds;

    // Judgment label with SL color glow + zoom tween.
    if (fb.lastJudgment) {
      const age = now - fb.lastJudgment.atSeconds;
      const j = ITG_JUDGMENT[fb.lastJudgment.tns];
      if (j && age >= 0 && age < SL_JUDGMENT_LIFE) {
        const t = age / SL_JUDGMENT_LIFE;
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
          const spr = this.sprJudgment(ctx, fb.lastJudgment.tns, fb.lastJudgment.white ?? false);
          if (spr) {
            const w = spr.w * pop;
            const h = spr.h * pop;
            ctx.batch.push(cx, anchorY - 26 * ds, w, h, spr, 1, 1, 1, 1);
          }
        }
      }
    }

    // Combo digits (from 4), white or a full-combo pulse pair.
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
      let tint: Tint = WHITE_TINT;
      if (pulse) {
        const ph = (now % 0.8) / 0.8;
        tint = parseColor(lerpHex(pulse[0], pulse[1], ph < 0.5 ? ph * 2 : (1 - ph) * 2));
      }
      const k = Math.max(0, Math.min(1, (now - comboPopAt) / 0.13));
      const pop = 1 + 0.08 * (1 - k);
      const text = String(judge.combo);
      const o = { px: 48 * ds * pop, bakePx: Math.round(48 * ds) };
      // drawNumber only left/right-aligns; center by starting half-width left.
      const half = ctx.glyphs.measure('slcombo', o, text) / 2;
      ctx.glyphs.drawNumber(
        ctx.hud,
        'slcombo',
        text,
        cx - half,
        anchorY + 76 * ds,
        o,
        'left',
        () => tint,
      );
    }
  }

  /** SL judgment label baked per tier (color + same-color glow + white rim).
   *  A white FA+ W1 uses white ink/glow — same "Fantastic", tighter timing. */
  private sprJudgment(ctx: SkinCtx, tns: number, white = false): AtlasRect | null {
    const ds = ctx.ds;
    const j = ITG_JUDGMENT[tns];
    if (!j) return null;
    const color = white && tns === TapNoteScore.W1 ? '#ffffff' : j.color;
    const f = font(ds, 800, 34);
    const tw = measureWidth(f, j.label);
    if (tw === null) return null;
    const pad = 24 * ds;
    const w = tw + 2 * pad;
    const h = 34 * ds * 1.5 + 2 * pad;
    return ctx.atlas.sprite(
      `sljudg:${tns}:${white ? 'w' : ''}:${Math.round(ds * 10)}`,
      w,
      h,
      (c) => {
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = f;
        if ('letterSpacing' in c) c.letterSpacing = `${(1.5 * ds).toFixed(2)}px`;
        c.shadowColor = color;
        c.shadowBlur = 18 * ds;
        c.fillStyle = color;
        c.fillText(j.label, w / 2, h / 2);
        c.shadowBlur = 0;
        c.lineWidth = 1.2 * ds;
        c.strokeStyle = 'rgba(255,255,255,0.8)';
        c.strokeText(j.label, w / 2, h / 2);
        if ('letterSpacing' in c) c.letterSpacing = '0px';
      },
    );
  }

  prewarm(ctx: SkinCtx): void {
    try {
      this.sprFaceMask(ctx);
      this.sprStripe(ctx);
      this.sprGlow(ctx);
      this.sprSwoosh(ctx);
      this.sprMineBody(ctx);
      this.sprMineCore(ctx);
      for (const kind of ['dim', 'bright', 'press'] as const) this.sprReceptor(ctx, kind);
      for (const q of SL_QUANTS) this.sprTap(ctx, ITG_QUANT_COLOR[q]);
      this.sprTap(ctx, '#7c8087'); // dead head
      for (const alive of [true, false]) {
        this.sprTube(ctx, alive);
      }
      this.sprSheen(ctx);
      for (const tns of Object.keys(ITG_JUDGMENT)) {
        const n = Number(tns);
        this.sprBoom(ctx, n);
        this.sprJudgment(ctx, n);
      }
      this.sprJudgment(ctx, TapNoteScore.W1, true); // FA+ white Fantastic
      // Combo digits + dance-% glyphs (both per-glyph now, so neither re-bakes).
      ctx.glyphs.measure(
        'slcombo',
        { px: 48 * ctx.ds, bakePx: Math.round(48 * ctx.ds) },
        '0123456789',
      );
      ctx.glyphs.measure(
        'slpct',
        { px: 44 * ctx.ds, bakePx: Math.round(44 * ctx.ds) },
        SL_PCT_CHARS,
      );
    } catch {
      // Baking is best-effort; a missing sprite just draws nothing.
    }
  }
}
