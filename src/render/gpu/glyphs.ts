/**
 * Glyph bank for the WebGPU note field's numbers (combo, money score).
 *
 * Text still bakes through canvas — WebGPU has no font rasterizer — but the
 * key is baking each glyph ONCE and compositing digits as quads, instead of
 * re-rasterizing the whole number every time it changes. The old approach
 * re-baked the combo/score to a texture on every hit; at 4K that raster
 * (DoEndRasterCHROMIUM) dropped frames. Here a digit sprite is baked the first
 * time it's seen at a given size and reused forever; drawNumber() just emits
 * tinted quads, so a changing number costs nothing on the CPU/GPU-raster side.
 *
 * Two styles match the 2D art: 'combo' (white rim + black outline + light
 * vertical gradient) and 'score' (black outline + near-white fill, no rim).
 * Glyphs bake white-ish so a per-quad tint recolors them — black outline
 * survives the multiply, so score's dim leading zeros and combo's tier tint
 * both work.
 */

import { measureWidth, OUTLINE_INK, roundFont } from '../themes/ddrA3';
import type { AtlasRect } from './atlas';
import type { GpuAtlas } from './atlas';
import type { QuadBatch } from './quads';

export type GlyphStyle = 'combo' | 'score';
export type Tint = readonly [number, number, number, number];

/** Display size `px`, optionally baked at `bakePx` (then scaled) with an extra
 *  horizontal condense `scaleX`. Baking at a fixed `bakePx` across a range of
 *  display sizes (combo's zoom ladder) means the glyphs bake only once. */
export interface DrawOpts {
  px: number;
  bakePx?: number;
  scaleX?: number;
}

interface Glyph {
  rect: AtlasRect | null;
  /** Pen advance in css px (measureText width). */
  advance: number;
  /** Baked sprite metrics (css px). */
  w: number;
  h: number;
  baseY: number;
  padX: number;
}

export class GlyphBank {
  private cache = new Map<string, Glyph>();

  constructor(private readonly atlas: GpuAtlas) {}

  /** Drop cached glyphs (design-scale change / font load) — they re-bake lazily. */
  clear(): void {
    this.cache.clear();
  }

  /** Bake (once) and return a sprite for `s` (a digit, comma, or whole word). */
  private glyph(style: GlyphStyle, px: number, s: string): Glyph {
    const key = `${style}:${Math.round(px)}:${s}`;
    let g = this.cache.get(key);
    if (g) return g;
    const font = roundFont(px);
    const advance = measureWidth(font, s) ?? px * 0.6 * s.length;
    const rim = style === 'combo';
    const padX = Math.ceil(px * (rim ? 0.16 : 0.11));
    const w = Math.ceil(advance) + 2 * padX;
    const h = Math.ceil(px * 1.28);
    const baseY = Math.round(px * 0.92);
    const rect = this.atlas.sprite(`glyph:${key}`, w, h, (c) => {
      c.lineJoin = 'round';
      c.textAlign = 'left';
      c.font = font;
      if (rim) {
        c.strokeStyle = '#ffffff';
        c.lineWidth = px * 0.13;
        c.strokeText(s, padX, baseY);
      }
      c.strokeStyle = OUTLINE_INK;
      c.lineWidth = px * (rim ? 0.075 : 0.14);
      c.strokeText(s, padX, baseY);
      // Combo keeps a subtle top-bright gradient; score bakes flat white so a
      // per-quad tint reproduces its exact bright (#f6f6f8) / dim (#494a4f).
      const grad = c.createLinearGradient(0, baseY - px * 0.9, 0, baseY);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(1, rim ? '#dfe0e4' : '#ffffff');
      c.fillStyle = grad;
      c.fillText(s, padX, baseY);
    });
    g = { rect, advance, w, h, baseY, padX };
    this.cache.set(key, g);
    return g;
  }

  /**
   * Options for a number/text draw. `px` is the DISPLAY size; `bakePx` is the
   * size the glyphs are actually rasterized at (defaults to px). Combo bakes
   * once at a reference size and scales, so its zoom ladder never re-bakes.
   * `scaleX` is an extra horizontal condense (A3 combo numerals are 0.84).
   */
  private opt(o: DrawOpts): { bakePx: number; scale: number; scaleX: number } {
    const bakePx = o.bakePx ?? o.px;
    return { bakePx, scale: o.px / bakePx, scaleX: o.scaleX ?? 1 };
  }

  /** Total pen width of `text` for centering/right-align (display css px). */
  measure(style: GlyphStyle, o: DrawOpts, text: string): number {
    const { bakePx, scale, scaleX } = this.opt(o);
    let total = 0;
    for (const ch of text) total += this.glyph(style, bakePx, ch).advance * scale * scaleX;
    return total;
  }

  /** Place a baked glyph quad so its pen origin sits at (penX, baseline). */
  private place(
    b: QuadBatch,
    g: Glyph,
    penX: number,
    baseline: number,
    scale: number,
    scaleX: number,
    tint: Tint,
  ): void {
    if (!g.rect) return;
    const drawW = g.w * scale * scaleX;
    const drawH = g.h * scale;
    const cx = penX - g.padX * scale * scaleX + drawW / 2;
    const cy = baseline - g.baseY * scale + drawH / 2;
    b.push(cx, cy, drawW, drawH, g.rect, tint[0], tint[1], tint[2], tint[3]);
  }

  /**
   * Composite `text` digit-by-digit (each a reused glyph). `x` is the left or
   * right edge per `align`; `baseline` is the text baseline. `tintOf(i, ch)`
   * colours each glyph (score dims leading zeros; combo tints by tier).
   */
  drawNumber(
    b: QuadBatch,
    style: GlyphStyle,
    text: string,
    x: number,
    baseline: number,
    o: DrawOpts,
    align: 'left' | 'right',
    tintOf: (i: number, ch: string) => Tint,
  ): void {
    const { bakePx, scale, scaleX } = this.opt(o);
    let penX = align === 'right' ? x - this.measure(style, o, text) : x;
    for (let i = 0; i < text.length; i++) {
      const g = this.glyph(style, bakePx, text[i]);
      this.place(b, g, penX, baseline, scale, scaleX, tintOf(i, text[i]));
      penX += g.advance * scale * scaleX;
    }
  }

  /** Draw a whole constant string (e.g. the "combo" word) as one cached sprite. */
  drawText(
    b: QuadBatch,
    style: GlyphStyle,
    text: string,
    x: number,
    baseline: number,
    o: DrawOpts,
    align: 'left' | 'right',
    tint: Tint,
  ): void {
    const { bakePx, scale, scaleX } = this.opt(o);
    const g = this.glyph(style, bakePx, text);
    const penX = align === 'right' ? x - g.advance * scale * scaleX : x;
    this.place(b, g, penX, baseline, scale, scaleX, tint);
  }
}
