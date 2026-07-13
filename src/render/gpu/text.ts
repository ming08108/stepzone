/**
 * Shared text primitives for the WebGPU sprite bakers — the font builders,
 * the outline ink, and canvas text measurement. Both skins (ddrA3Art,
 * simplyLoveArt) and the glyph bank (glyphs.ts) draw text, so these live in one
 * skin-agnostic module rather than in either skin's art file.
 */

// The playfield's HUD uses a rounded display face where available, and a
// squared technical face for panel labels; each degrades to system fallbacks.
const ROUND_FONT = '"Arial Rounded MT Bold", "Segoe UI", "Chakra Petch", system-ui, sans-serif';
const SQUARE_FONT = '"Chakra Petch", "Segoe UI", system-ui, sans-serif';

export function roundFont(px: number): string {
  return `900 ${px}px ${ROUND_FONT}`;
}
export function squareFont(w: number, px: number): string {
  return `${w} ${px}px ${SQUARE_FONT}`;
}

/** Arrow border / interior black — the shared outline ink for baked glyphs. */
export const OUTLINE_INK = '#0b0c10';

/** Shared scratch context for text measurement (null when unavailable). */
let measurer: CanvasRenderingContext2D | null | undefined;
// Memoize widths: HUD labels (grade, judgment, difficulty) are measured every
// frame but their (font, text) pairs are a tiny stable set, so measuring once
// and reusing turns a per-frame ctx.measureText into a Map lookup. Cleared once
// when real web fonts arrive, so widths measured against fallback fonts before
// load can't persist stale (the skins likewise rebake their sprites then).
const widthCache = new Map<string, number>();
if (typeof document !== 'undefined' && document.fonts?.ready) {
  document.fonts.ready.then(() => widthCache.clear()).catch(() => undefined);
}
export function measureWidth(font: string, text: string): number | null {
  const key = `${font} ${text}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;
  if (measurer === undefined) {
    measurer =
      typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  }
  if (!measurer) return null;
  measurer.font = font;
  const w = measurer.measureText(text).width;
  widthCache.set(key, w);
  return w;
}
