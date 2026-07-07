/**
 * Smoke-exercises the procedural ART both note-field skins are built from — the
 * exported paint functions the WebGPU atlas bakes (render/gpu/*Skin.ts). The
 * per-frame renderer itself lives on the GPU field, which needs a real device
 * and is verified via the render harness; but a bad paint throws only at bake
 * time, where prewarm() swallows it — so this guards them against a no-op
 * canvas context. Pixel output is not asserted, only that nothing throws.
 */
import { describe, expect, it } from 'vitest';
import { NoteType, TapNoteScore } from '../src/notes/noteTypes';
import {
  A3_JUDGMENT,
  JUDGMENT_INK,
  paintBoom,
  paintJudgment,
  paintMineArcs,
  paintMineOrb,
  paintNote,
  paintReceptor,
  QUANT_BAND,
  QUANT_TUBE,
} from '../src/render/gpu/ddrA3Art';
import {
  ITG_JUDGMENT,
  ITG_QUANT_COLOR,
  paintCelExplosion,
  paintCelMineBody,
  paintCelReceptor,
  paintCelTapBase,
} from '../src/render/gpu/simplyLoveArt';

/** A CanvasRenderingContext2D stand-in: every method is a no-op. */
function mockCtx(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => {} };
  const target: Record<string | symbol, unknown> = {};
  const noop = () => undefined;
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
      if (prop === 'measureText') return () => ({ width: 10 });
      const existing = t[prop];
      if (existing !== undefined) return existing;
      return noop;
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
    has() {
      return true; // makes feature probes like `'letterSpacing' in ctx` truthy
    },
  }) as unknown as CanvasRenderingContext2D;
}

const S = 40;
const DS = 2;
const R = 26;

describe('arcade (DDR A3) paint functions', () => {
  it('paints every quant note, receptors, mine, explosion, and judgment tier', () => {
    const c = mockCtx();
    expect(() => {
      for (const q of Object.values(NoteType) as NoteType[]) {
        if (typeof q !== 'number') continue;
        paintNote(c, S, DS, QUANT_BAND[q], QUANT_TUBE[q]);
      }
      paintReceptor(c, S, DS, 0, false);
      paintReceptor(c, S, DS, 1, true);
      paintMineOrb(c, R, DS);
      paintMineArcs(c, R, DS);
      paintBoom(c, S, DS);
      for (const key of Object.keys(A3_JUDGMENT)) {
        const tns = Number(key);
        const ink = JUDGMENT_INK[tns] ?? JUDGMENT_INK[TapNoteScore.W4];
        paintJudgment(c, A3_JUDGMENT[tns].label, ink, 30, DS, 8, false);
      }
    }).not.toThrow();
  });
});

describe('Simply Love (ITG) paint functions', () => {
  it('paints every quant cel note, receptors, mine, and explosion tier', () => {
    const c = mockCtx();
    expect(() => {
      for (const color of Object.values(ITG_QUANT_COLOR)) {
        paintCelTapBase(c, S, DS, color, false);
      }
      paintCelTapBase(c, S, DS, '#7c8087', true); // dead freeze head
      paintCelReceptor(c, S, DS, 112, false);
      paintCelReceptor(c, S, DS, 246, true);
      paintCelMineBody(c, R, DS);
      for (const key of Object.keys(ITG_JUDGMENT)) {
        const j = ITG_JUDGMENT[Number(key)];
        paintCelExplosion(c, S, DS, j.color, true, 0.5);
      }
    }).not.toThrow();
  });
});
