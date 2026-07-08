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
export function measureWidth(font: string, text: string): number | null {
  if (measurer === undefined) {
    measurer =
      typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  }
  if (!measurer) return null;
  measurer.font = font;
  return measurer.measureText(text).width;
}
