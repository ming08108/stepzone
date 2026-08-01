/**
 * DDR A3 (arcade) GpuSkin — all of the arcade look's baked-sprite art, split
 * out of GpuNoteField so the field owns only the shared mechanics (scroll
 * math, cull cursor, the receptor/hold/note/explosion loops, the batches and
 * the render-pass encode) and delegates every bit of ART here. Extracted
 * verbatim from the field's former A3 members: same sprite keys, same paint
 * calls, same pass order — zero visual change intended.
 *
 * Everything a hook needs arrives on the per-frame SkinCtx (batches, atlas,
 * glyphs, layout), so the skin holds no stale refs across the field's atlas
 * rebuilds (dpr / 4K changes) and needs no constructor state.
 */

import type { Judge } from '../../gameplay/judge';
import { NoteType, TapNoteScore } from '../../notes/noteTypes';
import type { Feedback, TapNoteStyle } from '../types';
import {
  A3_EXPLOSION,
  A3_JUDGMENT,
  ARROW_CAPSULE,
  ARROW_HOLLOW,
  ARROW_PENCIL,
  COMBO_PLAIN,
  COMBO_TINT,
  HOLD_GREEN,
  HOLD_GREY,
  HOLD_PURPLE,
  JUDGMENT_INK,
  JUDGMENT_LIFE,
  NOTE_GREEN,
  NOTE_GREY,
  QUANT_BAND,
  QUANT_TUBE,
  TUBE_GREY,
  paintBoom,
  paintGaugeChrome,
  paintGaugeDividers,
  paintHoldTile,
  paintJudgment,
  paintMineArcs,
  paintMineOrb,
  paintNote,
  paintReceptor,
  traceSegments,
  tracePoly,
  type HoldSkin,
} from './ddrA3Art';
import { measureWidth, roundFont } from './text';
import type { AtlasRect } from './atlas';
import type { Tint } from './glyphs';
import { cropUV, type QuadOpts } from './quads';
import type { GpuSkin, SkinCtx } from './skin';

/** Beat pulse weight (0..1): 1 exactly ON the beat, easing to 0 at the half-beat
 *  via a cosine — the smooth zoom StepMania's pulse()/effectclock("beat") gives. */
function beatSine(beat: number): number {
  return 0.5 + 0.5 * Math.cos(2 * Math.PI * (beat - Math.floor(beat)));
}

/** Parse #rgb/#rrggbb/rgb()/rgba() into 0..1 floats. */
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

// Memoized: every color parsed here is a static skin-palette string, so the hot
// per-note / per-hold path (e.g. hold outlines, quant glows) is a Map lookup
// instead of a re-parse + fresh 4-float array each call. The cached tuple is
// only ever read (never mutated in place), so sharing one instance is safe.
const colorCache = new Map<string, [number, number, number, number]>();
function parseColor(s: string): [number, number, number, number] {
  let c = colorCache.get(s);
  if (c === undefined) colorCache.set(s, (c = parseColorUncached(s)));
  return c;
}

/** A3 step zone, design px (matches DdrA3Theme / the former field constant). */
const RECEPTOR_OFFSET = 118;

export class DdrA3GpuSkin implements GpuSkin {
  readonly receptorOffset = RECEPTOR_OFFSET;
  readonly explosionSeconds = A3_EXPLOSION;
  readonly beatLines = true;
  // Hot-path: cache the note-sprite rect by band color so the per-note draw is
  // a Map lookup — no template-string key or paint closure allocated per frame.
  private readonly noteSprites = new Map<string, AtlasRect | null>();
  // Reused opts for the per-note rotation push (avoids a `{rot}` alloc/note).
  private readonly rotOpt: QuadOpts = { rot: 0 };
  // Reused cropped-UV rect for the rising interior fill, so the per-note crop is a
  // few field writes rather than a fresh AtlasRect each frame.
  private readonly fillUV: AtlasRect = { u0: 0, v0: 0, u1: 0, v1: 0, w: 0, h: 0 };
  // Reused opts for the additive held-head glow.
  private readonly addOpt: QuadOpts = { add: true };
  // Quant core color (band[1]) parsed to a float tint once, for the held glow.
  private readonly glowTint = new Map<NoteType, Tint>();
  fieldLeft(bare: boolean, width: number, numTracks: number, colW: number, ds: number): number {
    return bare
      ? (width - numTracks * colW) / 2
      : Math.max(24 * ds, 0.22 * width - (numTracks * colW) / 2);
  }

  // --- Sprite getters (baked on demand; keys mirror the 2D SpriteStore) -----

  private sprNote(ctx: SkinCtx, band: typeof NOTE_GREEN, tube: string): AtlasRect | null {
    const cached = this.noteSprites.get(band[1]);
    if (cached !== undefined) return cached;
    const m = ctx.arrowS + 9 * ctx.ds;
    const rect = ctx.atlas.sprite(`note:${band[1]}`, 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      // Hollow interior — the dark centre is filled with a beat-driven white wash
      // in note(); the pale tube is omitted.
      paintNote(c, ctx.arrowS, ctx.ds, band, tube, true);
    });
    this.noteSprites.set(band[1], rect);
    return rect;
  }

  /** Solid white arrow INTERIOR (the hollow region + the capsule/pencil stem, i.e.
   *  the whole inside of the arrow up into the head) — drawn UV-cropped from the
   *  tail so it reads as a white fill rising through the arrow, clipped to the
   *  interior shape so the coloured outline/bands stay visible. */
  private sprInteriorFill(ctx: SkinCtx): AtlasRect | null {
    const m = ctx.arrowS + 9 * ctx.ds;
    return ctx.atlas.sprite('note:interiorfill', 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      c.fillStyle = '#ffffff';
      for (const poly of [ARROW_HOLLOW, ARROW_CAPSULE, ARROW_PENCIL]) {
        tracePoly(c, poly, ctx.arrowS);
        c.fill();
      }
    });
  }

  /** Soft round bloom behind an actively-held freeze head — additive, tinted to
   *  the note's quant color and pulsed with the beat so the arrow "breathes"
   *  while the sustain is held. */
  private sprGlow(ctx: SkinCtx): AtlasRect | null {
    const r = ctx.arrowS + 16 * ctx.ds;
    return ctx.atlas.sprite('note:glow', 2 * r, 2 * r, (c) => {
      const g = c.createRadialGradient(r, r, 0, r, r, r);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 2 * r, 2 * r);
    });
  }

  private sprReceptor(ctx: SkinCtx, kind: 'dim' | 'bright' | 'press') {
    const s = ctx.arrowS * 0.95;
    const m = s + 8 * ctx.ds;
    return ctx.atlas.sprite(`rec:${kind}`, 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintReceptor(c, s, ctx.ds, kind === 'bright' ? 1 : 0, kind === 'press');
    });
  }

  private sprGradStrip(
    ctx: SkinCtx,
    key: string,
    stops: Array<[number, string]>,
    horizontal = false,
  ) {
    const w = horizontal ? 128 : 16;
    const h = horizontal ? 16 : 128;
    return ctx.atlas.sprite(key, w, h, (c) => {
      const g = horizontal
        ? c.createLinearGradient(0, 0, w, 0)
        : c.createLinearGradient(0, 0, 0, h);
      for (const [at, color] of stops) g.addColorStop(at, color);
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
  }

  private holdSkinOf(
    alive: boolean,
    roll: boolean,
    quant: NoteType,
  ): { skin: HoldSkin; variant: string } {
    if (!alive) return { skin: HOLD_GREY, variant: 'grey' };
    if (roll) return { skin: HOLD_PURPLE, variant: 'purple' };
    // A regular freeze's trail takes its head's quantization color, so the whole
    // note is one color (only beat timing determines it). Cached per quant.
    const b = QUANT_BAND[quant];
    return {
      skin: {
        light: b[0],
        core: b[1],
        rail: HOLD_GREEN.rail,
        outline: b[2],
        chevron: HOLD_GREEN.chevron,
      },
      variant: 'q' + quant,
    };
  }

  // --- Art hooks --------------------------------------------------------------

  chrome(ctx: SkinCtx, judge: Judge, beatPulse: number): void {
    const white = ctx.white();
    if (!white) return;
    const { ds, height } = ctx;
    const b = ctx.batch;
    const fieldW = ctx.numTracks * ctx.colW;
    const pad = 14 * ds;
    const x0 = ctx.fieldLeft - pad;
    const w = fieldW + 2 * pad;
    const soft = 14 * ds;

    // NOTE: the former pushChrome also drew a bgDim overlay over the song media
    // here (`if (this.media.active) …`). SkinCtx exposes neither the media layer
    // nor bgDim, so that dim now belongs to the field's background pass (frame
    // graph step 1). Dropped here — see deviation note.

    const edge = this.sprGradStrip(
      ctx,
      'lf:edge',
      [
        [0, 'rgba(0,0,0,0)'],
        [1, 'rgba(0,0,0,1)'],
      ],
      true,
    );
    // Soft edges: gradient strip (transparent→black), alpha 0.55; right side mirrored.
    if (edge) {
      b.push(x0, height / 2, 2 * soft, height, edge, 1, 1, 1, 0.55);
      b.push(x0 + w, height / 2, -2 * soft, height, edge, 1, 1, 1, 0.55);
    }
    b.push(x0 + w / 2, height / 2, w - 2 * soft, height, white, 0, 0, 0, 0.55, { solid: true });

    if (!judge.failed && judge.life < 0.25) {
      // DANGER: red wash + glowing rope lines + rotated lettering.
      b.push(x0 + w / 2, height / 2, w, height, white, 144 / 255, 0, 0, 0.16 + 0.14 * beatPulse, {
        solid: true,
      });
      const glow = 0.55 + 0.45 * beatPulse;
      const rope = this.sprGradStrip(
        ctx,
        'danger:rope',
        [
          [0, 'rgba(250,238,0,0)'],
          [0.35, 'rgba(250,238,0,0.55)'],
          [0.46, 'rgba(250,238,0,1)'],
          [0.54, 'rgba(250,238,0,1)'],
          [0.65, 'rgba(250,238,0,0.55)'],
          [1, 'rgba(250,238,0,0)'],
        ],
        true,
      );
      const text = ctx.atlas.sprite('danger:text', 200 * ds, 26 * ds, (c) => {
        c.font = roundFont(20 * ds);
        c.textAlign = 'center';
        c.strokeStyle = '#faee00';
        c.lineWidth = 1.5 * ds;
        c.strokeText('D A N G E R', 100 * ds, 19 * ds);
      });
      for (const x of [x0 + 5 * ds, x0 + w - 5 * ds]) {
        if (rope) b.push(x, height / 2, 26 * ds, height, rope, 1, 1, 1, glow);
        if (text)
          b.push(x - 7 * ds, height / 2, 200 * ds, 26 * ds, text, 1, 1, 1, glow, {
            rot: -Math.PI / 2,
          });
      }
    }
  }

  hudUnderlay(
    _ctx: SkinCtx,
    _judge: Judge,
    _progress: number,
    _now: number,
    _beatPulse: number,
  ): void {
    // A3 has no under-HUD art (its gauge/panels draw over the notes).
  }

  receptor(ctx: SkinCtx, track: number, pressed: boolean, beatPulse: number): void {
    const b = ctx.batch;
    const f = beatPulse * beatPulse;
    const m = ctx.arrowS * 0.95 + 8 * ctx.ds;
    const x = ctx.laneX(track);
    const rot = ctx.angle(track);
    if (pressed) {
      const spr = this.sprReceptor(ctx, 'press');
      if (spr) b.push(x, ctx.receptorY, 2 * m * 0.94, 2 * m * 0.94, spr, 1, 1, 1, 1, { rot });
    } else {
      const dim = this.sprReceptor(ctx, 'dim');
      if (dim) b.push(x, ctx.receptorY, 2 * m, 2 * m, dim, 1, 1, 1, 1, { rot });
      if (f > 0.02) {
        const bright = this.sprReceptor(ctx, 'bright');
        if (bright) b.push(x, ctx.receptorY, 2 * m, 2 * m, bright, 1, 1, 1, f, { rot });
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
    roll: boolean,
    beatPulse: number,
    quant: NoteType,
  ): void {
    const { ds } = ctx;
    const b = ctx.batch;
    const x = ctx.laneX(track);
    const w = ctx.arrowS * 1.66;
    const h = Math.max(1, bottom - top);
    const capR = w * 0.48;
    const reverse = ctx.reverse;
    const { skin, variant } = this.holdSkinOf(alive, roll, quant);
    const white = ctx.white();

    // Straight section stops capR short of the tail (rounded end); the cap
    // sprite finishes it. Reverse puts the tail — and so the cap — at the top.
    const capH = Math.min(capR, h);
    const bodyH = h - capH;
    const bodyTop = reverse ? top + capH : top;
    const bodyCenter = bodyTop + bodyH / 2;

    // Stream gradient: light→core→light across max(h, 220ds), like the 2D theme.
    const grad = this.sprGradStrip(ctx, `holdgrad:${variant}`, [
      [0, skin.light],
      [0.5, skin.core],
      [1, skin.light],
    ]);
    const span = Math.max(h, 220 * ds);
    if (grad && bodyH > 0) {
      const gradUV = cropUV(grad, 0, 0, 1, h / span);
      b.push(x, bodyCenter, w, bodyH, gradUV);
    }

    // Chevron + rail tile, anchored at the head end.
    const period = 17 * ds;
    const tile = ctx.atlas.sprite(`holdtile:${variant}:${Math.round(w)}`, w, period, (c) =>
      paintHoldTile(c, w, period, ds, skin),
    );
    if (tile && bodyH > 0)
      b.push(x, bodyCenter, w, bodyH, tile, 1, 1, 1, 1, {
        repeatV: bodyH / period,
        flipV: reverse,
      });

    // Cylindrical shading.
    const shade = this.sprGradStrip(
      ctx,
      'holdshade',
      [
        [0, 'rgba(0,0,0,0.32)'],
        [0.22, 'rgba(0,0,0,0)'],
        [0.5, 'rgba(255,255,255,0.10)'],
        [0.78, 'rgba(0,0,0,0)'],
        [1, 'rgba(0,0,0,0.32)'],
      ],
      true,
    );
    if (shade && bodyH > 0) b.push(x, bodyCenter, w, bodyH, shade);

    // Arrow-tip tail cap: a triangle tapering to a point (matches the note
    // shape) instead of a rounded/extruded bulb. Baked with the stream gradient,
    // the same cylinder shading, and an outline.
    const cap = ctx.atlas.sprite(
      `holdcap:${variant}:${Math.round(w)}`,
      w + 4 * ds,
      capR + 2 * ds,
      (c) => {
        const pad = 2 * ds;
        c.beginPath();
        c.moveTo(pad, pad);
        c.lineTo(pad + w, pad);
        c.lineTo(pad + w / 2, capR + pad);
        c.closePath();
        const g = c.createLinearGradient(0, 0, 0, capR);
        g.addColorStop(0, skin.core);
        g.addColorStop(1, skin.light);
        c.fillStyle = g;
        c.fill();
        const sh = c.createLinearGradient(0, 0, w, 0);
        sh.addColorStop(0, 'rgba(0,0,0,0.32)');
        sh.addColorStop(0.22, 'rgba(0,0,0,0)');
        sh.addColorStop(0.5, 'rgba(255,255,255,0.10)');
        sh.addColorStop(0.78, 'rgba(0,0,0,0)');
        sh.addColorStop(1, 'rgba(0,0,0,0.32)');
        c.fillStyle = sh;
        c.fill();
        c.strokeStyle = skin.outline;
        c.lineWidth = 1.8 * ds;
        c.stroke();
      },
    );
    if (cap && capH > 0) {
      const capCy = reverse ? top + capH / 2 : bottom - capH / 2;
      b.push(x, capCy, w + 4 * ds, capH + 2 * ds, cap, 1, 1, 1, 1, { flipV: reverse });
    }

    // Side outlines along the straight section.
    if (white && bodyH > 0) {
      const [or, og, ob, oa] = parseColor(skin.outline);
      b.push(x - w / 2, bodyCenter, 1.8 * ds, bodyH, white, or, og, ob, oa);
      b.push(x + w / 2, bodyCenter, 1.8 * ds, bodyH, white, or, og, ob, oa);
    }

    // Engaged: a bright body wash pulsing with the beat + glowing side rails,
    // so a held freeze clearly lights up (arcade-style).
    if (alive && held && white) {
      b.push(x, top + h / 2, w, h, white, 1, 1, 1, 0.14 + 0.2 * beatPulse);
      const rim = 0.45 + 0.4 * beatPulse;
      b.push(x - w / 2, top + h / 2, 2.6 * ds, h, white, 1, 1, 1, rim);
      b.push(x + w / 2, top + h / 2, 2.6 * ds, h, white, 1, 1, 1, rim);
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
    const b = ctx.batch;
    const dead = style === 'deadHead';
    // A hold/freeze HEAD is colored by quantization exactly like a tap (the hold
    // body is what's visually distinct) — so a chord of a tap + a hold head reads
    // as one color. Only a dropped (dead) head greys out.
    const band = dead ? NOTE_GREY : QUANT_BAND[quant];
    const tube = dead ? TUBE_GREY : QUANT_TUBE[quant];
    const spr = this.sprNote(ctx, band, tube);
    // Fixed size — the arrows don't pulse; the beat animation lives in the
    // interior white fill below.
    const m = ctx.arrowS + 9 * ctx.ds;
    if (spr) {
      const rot = ctx.angle(track);
      // An engaged freeze head glows: a soft quant-tinted bloom behind the arrow,
      // pulsing with the beat while the sustain is held.
      if (style === 'heldHead') {
        const glow = this.sprGlow(ctx);
        if (glow) {
          let tint = this.glowTint.get(quant);
          if (!tint) {
            tint = parseColor(band[1]);
            this.glowTint.set(quant, tint);
          }
          const p = beatSine(beat);
          const gr = (ctx.arrowS + 16 * ctx.ds) * (1.05 + 0.18 * p);
          b.push(
            ctx.laneX(track),
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
      const cx = ctx.laneX(track);
      this.rotOpt.rot = rot;
      b.push(cx, y, 2 * m, 2 * m, spr, 1, 1, 1, 1, this.rotOpt);
      // Interior fill: a white wash that fills the arrow's hollow interior on the
      // beat — rising from the tail up through the stem and into the head, peaking
      // ON the beat and easing back by the half-beat (beatSine). Every arrow fills
      // in time with the music; a dead head sits dark.
      if (!dead) {
        const fill = this.sprInteriorFill(ctx); // solid white arrow interior
        const level = beatSine(beat);
        if (fill && level > 0.02) {
          // Reveal only the tail-side `level` fraction of the sprite (v grows toward
          // the base at v1); reuse one rect so the per-note crop never allocates.
          const uv = this.fillUV;
          const dv = fill.v1 - fill.v0;
          uv.u0 = fill.u0;
          uv.u1 = fill.u1;
          uv.w = fill.w;
          uv.v0 = fill.v0 + dv * (1 - level);
          uv.v1 = fill.v1;
          uv.h = fill.h * level;
          // Seat the strip on the tail (local +y = base) and rotate it into the lane.
          const off = m * (1 - level);
          const fcx = cx - off * Math.sin(rot);
          const fcy = y + off * Math.cos(rot);
          // Keep it a discreet translucent wash, not a solid white flash.
          b.push(fcx, fcy, 2 * m, 2 * m * level, uv, 1, 1, 1, 0.3, this.rotOpt);
        }
      }
    }
  }

  mine(ctx: SkinCtx, x: number, y: number, now: number, beatPulse: number): void {
    const { ds } = ctx;
    const b = ctx.batch;
    const r = ctx.arrowS * 0.62;
    const m = r + 12 * ds;
    const orb = ctx.atlas.sprite('mine:orb', 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintMineOrb(c, r, ds);
    });
    if (orb) b.push(x, y, 2 * m, 2 * m, orb);
    const arcs = ctx.atlas.sprite('mine:arcs', 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintMineArcs(c, r, ds);
    });
    if (arcs) b.push(x, y, 2 * m, 2 * m, arcs, 1, 1, 1, 1, { rot: now * 3 });
    const core = ctx.atlas.sprite('mine:core', 2 * r * 0.25, 2 * r * 0.25, (c) => {
      c.fillStyle = '#f0faff';
      c.beginPath();
      c.arc(r * 0.25, r * 0.25, r * 0.2, 0, Math.PI * 2);
      c.fill();
    });
    if (core) b.push(x, y, 2 * r * 0.25, 2 * r * 0.25, core, 1, 1, 1, 0.4 + 0.6 * beatPulse);
  }

  explosion(ctx: SkinCtx, track: number, tns: number, k: number): void {
    const { ds } = ctx;
    const b = ctx.batch;
    const s = ctx.arrowS;
    const fade = 1 - k;
    const x = ctx.laneX(track);
    const y = ctx.receptorY;
    const m = s + 18 * ds;
    const boom = ctx.atlas.sprite('boom', 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintBoom(c, s, ds);
    });
    const sc = 1 + 0.32 * k;
    if (boom)
      b.push(x, y, 2 * m * sc, 2 * m * sc, boom, 1, 1, 1, 0.42 * fade, {
        rot: ctx.angle(track),
        add: true,
      });
    // Four-point star: two tier-tinted diamonds + two brighter white ones.
    const ray = ctx.atlas.sprite('ray', 24, 48, (c) => {
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.moveTo(12, 0);
      c.lineTo(24, 24);
      c.lineTo(12, 48);
      c.lineTo(0, 24);
      c.closePath();
      c.fill();
    });
    if (!ray) return;
    const j = A3_JUDGMENT[tns];
    const [jr, jg, jb] = parseColor(j ? j.color : '#ffffff');
    const rr = s * (0.9 + 1.15 * k);
    const ww = s * 0.13 * fade;
    for (let i = 0; i < 2; i++) {
      const rot = Math.PI / 4 + (i * Math.PI) / 2;
      b.push(x, y, 2 * ww, 2 * rr, ray, jr, jg, jb, 0.25 * fade, { rot, add: true });
      b.push(x, y, 2 * ww * 0.6, 2 * rr * 0.92, ray, 1, 1, 1, 0.6 * fade, { rot, add: true });
    }
  }

  hudOverlay(
    ctx: SkinCtx,
    judge: Judge,
    _progress: number,
    fb: Feedback,
    now: number,
    beatPulse: number,
    comboPopAt: number,
  ): void {
    // Judgment + combo, ON TOP of the arrows (the DDR cab draws them over the
    // field), then the HUD chrome (gauge frames the top, panels the edges).
    this.pushJudgment(ctx, fb, now);
    this.pushCombo(ctx, judge, fb, now, comboPopAt);
    const white = ctx.white();
    if (white) {
      this.pushGauge(ctx, judge, now, beatPulse);
    }
  }

  // --- HUD-overlay builders ---------------------------------------------------

  private pushJudgment(ctx: SkinCtx, fb: Feedback, now: number): void {
    if (!fb.lastJudgment) return;
    const age = now - fb.lastJudgment.atSeconds;
    const tns = fb.lastJudgment.tns;
    const j = A3_JUDGMENT[tns];
    if (!j || age < 0 || age >= JUDGMENT_LIFE) return;
    const ink = JUDGMENT_INK[tns] ?? JUDGMENT_INK[TapNoteScore.W4];
    const { ds } = ctx;
    const cx = ctx.fieldLeft + (ctx.numTracks * ctx.colW) / 2;
    const dir = ctx.reverse ? -1 : 1;
    // Just above the combo (3.1·colW), not up at 1.38 where it sat on top of
    // the arrows approaching the receptors — the judgment + combo read as one
    // block, and the hit zone stays clear.
    const y = ctx.receptorY + dir * 2.35 * ctx.colW;
    const squash = age < 0.036 ? 1.5 - 0.5 * (age / 0.036) : 1;
    const px = 37 * ds;
    const pad = 18 * ds;
    const textW = measureWidth(roundFont(px), j.label);
    if (textW === null) return;
    const w = textW + 2 * pad;
    const h = px * 1.1 + 2 * pad;
    const spr = ctx.atlas.sprite(`judg:${tns}`, w, h, (c) =>
      paintJudgment(c, j.label, ink, px, ds, pad, false),
    );
    // Sprite anchor: drawImage(-w/2, -(pad+px*0.78)) under scale(1, squash).
    const cyOff = h / 2 - (pad + px * 0.78);
    if (spr) ctx.batch.push(cx, y + squash * cyOff, w, h * squash, spr);
    const shimmer = tns === TapNoteScore.W1 && Math.floor(age / 0.025) % 2 === 0;
    if (shimmer) {
      const shine = ctx.atlas.sprite(`judgshine:${tns}`, w, h, (c) =>
        paintJudgment(c, j.label, ink, px, ds, pad, true),
      );
      if (shine) ctx.batch.push(cx, y + squash * cyOff, w, h * squash, shine, 1, 1, 1, 0.35);
    }
  }

  private pushCombo(
    ctx: SkinCtx,
    judge: Judge,
    fb: Feedback,
    now: number,
    comboPopAt: number,
  ): void {
    if (judge.combo < 4) return;
    const { ds } = ctx;
    const cx = ctx.fieldLeft + (ctx.numTracks * ctx.colW) / 2;
    const dir = ctx.reverse ? -1 : 1;
    const yMid = ctx.receptorY + dir * 3.1 * ctx.colW;
    const tint = (fb.lastJudgment && COMBO_TINT[fb.lastJudgment.tns]) || COMBO_PLAIN;
    const c = judge.combo;
    const count = String(c);
    const zoom = c >= 1000 ? 0.78 : c >= 100 ? 0.9 : 0.6 + 0.03 * Math.min(9, Math.floor(c / 10));
    const basePx = ctx.colW * zoom;
    const k = Math.max(0, Math.min(1, (now - comboPopAt) / 0.05));
    const pop = 1 + 0.3 * (1 - k); // ~x1.3 bounce settling in 0.05s on each step
    const px = basePx * pop;
    const baseline = yMid + basePx * 0.36;
    const joinX = cx + 0.34 * ctx.colW;
    // Tint the white-baked glyphs by the tier's bright color (plain/W1 = white,
    // so the common case is unchanged). Digits reuse cached per-glyph sprites —
    // no per-hit re-bake.
    const col = parseColor(tint[0]);
    const t: Tint = [col[0], col[1], col[2], 1];
    // Bake at a fixed reference (max-zoom size) and scale to the current combo
    // px, so the zoom ladder never re-bakes glyphs. Number condensed 0.84 like
    // the A3 numerals, right-aligned at the join.
    const bakePx = Math.round(ctx.colW * 0.9);
    ctx.glyphs.drawNumber(
      ctx.batch,
      'combo',
      count,
      joinX,
      baseline,
      { px, bakePx, scaleX: 0.84 },
      'right',
      () => t,
    );
    // Lowercase "combo" word (constant → one cached sprite) sharing the baseline.
    ctx.glyphs.drawText(
      ctx.batch,
      'combo',
      'combo',
      joinX + 6 * ds,
      baseline,
      { px: px * 0.42, bakePx: Math.round(bakePx * 0.42) },
      'left',
      t,
    );
  }

  private pushGauge(ctx: SkinCtx, judge: Judge, now: number, beatPulse: number): void {
    const { ds } = ctx;
    const b = ctx.batch;
    const fieldW = ctx.numTracks * ctx.colW;
    // Field-aligned and lowered into the eyeline: the gauge used to sit 160px
    // above the receptors at a width nothing else shared. Under reverse the
    // receptors are at the bottom and notes stream DOWN through the top, so
    // the gauge mirrors below them instead of sitting in the note path. The
    // DOM HUD's `LIFE nn%` caption tracks gy + gh — keep PlayHud in sync
    // (it positions at ds*67 + 6k, mirrored under reverse).
    const gw = fieldW;
    const gh = 26 * ds;
    const gx = ctx.fieldLeft;
    // (Reverse tucks it flush between the receptor box and the bottom strip —
    // that slot is exactly gauge-height at 1080p, so the DOM caption hides.)
    const gy = ctx.reverse ? ctx.height - 78 * ds : 41 * ds;
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

    const chrome = ctx.atlas.sprite(`gauge:chrome:${Math.round(gw)}`, sprW, sprH, (c) =>
      paintGaugeChrome(c, gw, gh, ds, capL, capR),
    );
    if (chrome) b.push(gx - o + sprW / 2, gy - o + sprH / 2, sprW, sprH, chrome);

    const fillW = tw + 8 * ds;
    if (life > 0) {
      const fw = Math.max(2 * ds, fillW * life);
      const frac = Math.min(1, fw / fillW);
      // White chevron-pill segment shapes — the alpha mask every animated
      // fill layer clips against (what ctx.clip(segments) did in 2D).
      const mask = ctx.atlas.sprite(`gauge:mask:${Math.round(tw)}`, fillW, gh, (c) => {
        const path = new Path2D();
        traceSegments(path, tw, gh, ds);
        c.fillStyle = '#ffffff';
        c.fill(path);
      });
      const maskCrop = mask ? cropUV(mask, 0, 0, frac, 1) : null;
      if (danger) {
        if (maskCrop) {
          const a = 0.55 + 0.45 * beatPulse;
          b.push(tx + fw / 2, gy + gh / 2, fw, gh, maskCrop, 244 / 255, 32 / 255, 8 / 255, a);
        }
      } else if (hot) {
        // Maxed gauge: one baked color cycle scrolling through the segments
        // (period tw, like the 2D gradient that spanned off-tw..off+tw).
        const rainbow = ctx.atlas.sprite('gauge:rainbow', 256, 16, (c) => {
          const cycle = [
            '#ff2fd4',
            '#ff3a3a',
            '#ffd52a',
            '#2fe23a',
            '#2ad4ff',
            '#4a3aff',
            '#ff2fd4',
          ];
          const g = c.createLinearGradient(0, 0, 256, 0);
          for (let i = 0; i < cycle.length; i++) g.addColorStop(i / (cycle.length - 1), cycle[i]);
          c.fillStyle = g;
          c.fillRect(0, 0, 256, 16);
        });
        if (rainbow && maskCrop)
          b.push(tx + fw / 2, gy + gh / 2, fw, gh, rainbow, 1, 1, 1, 1, {
            repeatU: fw / tw,
            phaseU: -((now * 0.35) % 1),
            mask: maskCrop,
          });
      } else {
        const fill = ctx.atlas.sprite(`gauge:fill:${Math.round(tw)}`, fillW, gh, (c) => {
          const path = new Path2D();
          traceSegments(path, tw, gh, ds);
          c.save();
          c.clip(path);
          const sg = c.createLinearGradient(0, 0, 0, gh);
          sg.addColorStop(0, '#66f5b0');
          sg.addColorStop(0.45, '#0ddf75');
          sg.addColorStop(1, '#00a854');
          c.fillStyle = sg;
          c.fillRect(0, 0, fillW, gh);
          c.restore();
        });
        if (fill) b.push(tx + fw / 2, gy + gh / 2, fw, gh, cropUV(fill, 0, 0, frac, 1));
        // Flowing lighter bands drifting along the stream: the exact 2D band
        // parallelogram baked as one tile, scrolled with repeatU/phaseU,
        // clipped by the segment mask.
        const period = 56 * ds;
        const band = ctx.atlas.sprite(`gauge:band:${Math.round(gh)}`, period, gh, (c) => {
          c.fillStyle = '#ffffff';
          c.beginPath();
          c.moveTo(0, gh);
          c.lineTo(gh * 0.7, 0);
          c.lineTo(gh * 0.7 + 10 * ds, 0);
          c.lineTo(10 * ds, gh);
          c.closePath();
          c.fill();
        });
        if (band && maskCrop)
          b.push(tx + fw / 2, gy + gh / 2, fw, gh, band, 1, 1, 1, 0.22, {
            repeatU: fw / period,
            phaseU: -((now * 0.5) % 1),
            mask: maskCrop,
          });
        // Top sheen inside the fill, clipped to the segments like the 2D clip.
        const white = ctx.white();
        if (white && mask)
          b.push(tx + fw / 2, gy + 3.5 * ds, fw, 3 * ds, white, 1, 1, 1, 0.28, {
            mask: cropUV(mask, 0, (2 * ds) / gh, frac, (5 * ds) / gh),
          });
      }
    }

    const div = ctx.atlas.sprite(`gauge:div:${Math.round(tw)}`, fillW, gh, (c) =>
      paintGaugeDividers(c, tw, gh, ds),
    );
    if (div) b.push(tx + fillW / 2, gy + gh / 2, fillW, gh, div);
  }

  // --- Prewarm / cache lifecycle ---------------------------------------------

  prewarm(ctx: SkinCtx): void {
    // TODO: verify prewarm coverage
    try {
      const { ds } = ctx;
      // Taps (every quant band + tube), hold-head green, dead-head grey.
      for (const key of Object.keys(QUANT_BAND)) {
        const q = Number(key) as NoteType;
        this.sprNote(ctx, QUANT_BAND[q], QUANT_TUBE[q]);
      }
      this.sprNote(ctx, NOTE_GREEN, QUANT_TUBE[NoteType.N12TH]);
      this.sprNote(ctx, NOTE_GREY, TUBE_GREY);
      this.sprInteriorFill(ctx); // white interior used as the beat fill
      this.sprGlow(ctx); // held-freeze bloom

      // Receptors: idle dim, beat-bright, press flash.
      this.sprReceptor(ctx, 'dim');
      this.sprReceptor(ctx, 'bright');
      this.sprReceptor(ctx, 'press');

      // Hold skins: one per quant (live regular freeze), plus roll (purple) and
      // dropped (grey). A body long enough to bake the grad/tile AND the cap.
      const holdTop = ctx.receptorY;
      const holdBottom = ctx.receptorY + 220 * ds;
      for (const key of Object.keys(QUANT_BAND)) {
        this.hold(ctx, 0, holdTop, holdBottom, false, true, false, 0.5, Number(key) as NoteType);
      }
      this.hold(ctx, 0, holdTop, holdBottom, false, true, true, 0.5, NoteType.N4TH); // roll
      this.hold(ctx, 0, holdTop, holdBottom, false, false, false, 0.5, NoteType.N4TH); // grey

      // Mine (orb/arcs/core) and both explosion layers (boom + ray).
      this.mine(ctx, ctx.laneX(0), ctx.receptorY, 0, 0.5);
      this.explosion(ctx, 0, TapNoteScore.W1, 0.5);

      // Both gauge states (green fill + bands, and the maxed rainbow) + chrome,
      // mask and dividers — so no gauge state bakes mid-song.
      this.prewarmGauge(ctx);

      // Every judgment tier's lettering so no first "Great!"/"Miss" bakes.
      const jpx = 37 * ds;
      const jpad = 18 * ds;
      for (const key of Object.keys(A3_JUDGMENT)) {
        const tns = Number(key);
        const j = A3_JUDGMENT[tns];
        const ink = JUDGMENT_INK[tns] ?? JUDGMENT_INK[TapNoteScore.W4];
        const tw = measureWidth(roundFont(jpx), j.label);
        if (tw === null) break; // no canvas (unit env) — nothing to bake
        ctx.atlas.sprite(`judg:${tns}`, tw + 2 * jpad, jpx * 1.1 + 2 * jpad, (c) =>
          paintJudgment(c, j.label, ink, jpx, ds, jpad, false),
        );
      }

      // All digit/comma glyphs so a climbing combo never bakes a first-seen
      // digit mid-song. Combo bakes at its reference.
      const chars = '0123456789,';
      ctx.glyphs.measure('combo', { px: 1, bakePx: Math.round(ctx.colW * 0.9) }, chars);
    } catch {
      // Prewarm is best-effort; a failure must not break real rendering.
    }
  }

  /** Bake the gauge's baked sprites for both live states (green fill and the
   *  maxed rainbow), plus the shared chrome/mask/dividers. Mirrors the sprite
   *  keys + paint of pushGauge so no gauge sprite rasterizes mid-song. */
  private prewarmGauge(ctx: SkinCtx): void {
    const { ds } = ctx;
    const fieldW = ctx.numTracks * ctx.colW;
    const gw = fieldW; // mirrors pushGauge (field-aligned)
    const gh = 26 * ds;
    const capL = 24 * ds;
    const capR = 16 * ds;
    const tw = gw - capL - capR;
    const sprW = gw + 8 * ds;
    const sprH = gh + 8 * ds;
    const fillW = tw + 8 * ds;

    ctx.atlas.sprite(`gauge:chrome:${Math.round(gw)}`, sprW, sprH, (c) =>
      paintGaugeChrome(c, gw, gh, ds, capL, capR),
    );
    ctx.atlas.sprite(`gauge:mask:${Math.round(tw)}`, fillW, gh, (c) => {
      const path = new Path2D();
      traceSegments(path, tw, gh, ds);
      c.fillStyle = '#ffffff';
      c.fill(path);
    });
    ctx.atlas.sprite(`gauge:fill:${Math.round(tw)}`, fillW, gh, (c) => {
      const path = new Path2D();
      traceSegments(path, tw, gh, ds);
      c.save();
      c.clip(path);
      const sg = c.createLinearGradient(0, 0, 0, gh);
      sg.addColorStop(0, '#66f5b0');
      sg.addColorStop(0.45, '#0ddf75');
      sg.addColorStop(1, '#00a854');
      c.fillStyle = sg;
      c.fillRect(0, 0, fillW, gh);
      c.restore();
    });
    const period = 56 * ds;
    ctx.atlas.sprite(`gauge:band:${Math.round(gh)}`, period, gh, (c) => {
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.moveTo(0, gh);
      c.lineTo(gh * 0.7, 0);
      c.lineTo(gh * 0.7 + 10 * ds, 0);
      c.lineTo(10 * ds, gh);
      c.closePath();
      c.fill();
    });
    ctx.atlas.sprite('gauge:rainbow', 256, 16, (c) => {
      const cycle = ['#ff2fd4', '#ff3a3a', '#ffd52a', '#2fe23a', '#2ad4ff', '#4a3aff', '#ff2fd4'];
      const g = c.createLinearGradient(0, 0, 256, 0);
      for (let i = 0; i < cycle.length; i++) g.addColorStop(i / (cycle.length - 1), cycle[i]);
      c.fillStyle = g;
      c.fillRect(0, 0, 256, 16);
    });
    ctx.atlas.sprite(`gauge:div:${Math.round(tw)}`, fillW, gh, (c) =>
      paintGaugeDividers(c, tw, gh, ds),
    );
  }

  clear(): void {
    // ds/atlas changed — the baked note rects are invalid; rebake on next use.
    this.noteSprites.clear();
  }
}
