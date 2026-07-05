/**
 * Smoke-exercises the full renderer draw paths for both themes (DDR A3 and
 * Simply Love) against a no-op canvas context: layout, chrome, HUD underlay/
 * overlay, holds, mines, receptors, explosions, judgment + combo animations,
 * bare mode, reverse, appearance mods, and all three scroll modes. Catches
 * runtime errors the type checker can't (the pixel output itself is not
 * asserted).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Judge } from '../src/gameplay/judge';
import { TapNoteScore } from '../src/notes/noteTypes';
import { parseSimfile } from '../src/parse/loader';
import { NoteFieldRenderer, type Feedback, type NoteFieldConfig } from '../src/render/noteField';

const here = dirname(fileURLToPath(import.meta.url));
const ssc = readFileSync(join(here, '../src/dev/example.ssc'), 'utf8');

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

function makeJudge(): Judge {
  const song = parseSimfile(ssc, 'example.ssc');
  const chart = song.charts[0];
  const judge = new Judge(chart.getNoteData(), song.timing);
  // Hit the first two taps and engage the hold so held/hit states render.
  judge.step(0, 0.114, false);
  judge.step(1, 0.66, false);
  judge.step(3, 2.09, false);
  judge.update(2.2, [false, false, false, true]);
  return judge;
}

function feedbackAt(now: number, tns: TapNoteScore): Feedback {
  return {
    lastJudgment: { tns, atSeconds: now - 0.02 },
    laneFlash: [now - 0.01, now - 0.5, -999, now],
    laneHit: [
      { tns, atSeconds: now - 0.05 },
      { tns: TapNoteScore.W3, atSeconds: now - 0.2 },
      null,
      { tns: TapNoteScore.W1, atSeconds: now },
    ],
  };
}

const TIERS = [
  TapNoteScore.W1,
  TapNoteScore.W2,
  TapNoteScore.W3,
  TapNoteScore.W4,
  TapNoteScore.W5,
  TapNoteScore.Miss,
  TapNoteScore.HitMine,
];

describe.each([['arcade'], ['itg']] as const)('NoteFieldRenderer smoke (%s)', (skin) => {
  const base: Partial<NoteFieldConfig> = {
    noteSkin: skin,
    meta: { title: 'Song', subtitle: 'Artist', difficulty: 'dance-single · CHALLENGE 12' },
  };

  it('draws frames across times, tiers, and combo states without throwing', () => {
    const judge = makeJudge();
    const r = new NoteFieldRenderer(4, base);
    r.resize(1280, 720, 1);
    const ctx = mockCtx();
    judge.combo = 10; // force the combo display path
    expect(() => {
      for (const now of [0, 0.7, 2.2, 4.7]) {
        for (const tns of TIERS) {
          r.draw(ctx, judge, now, now * 2, now / 10, feedbackAt(now, tns));
        }
      }
      judge.combo = 1234; // large-combo sizing branch
      r.draw(ctx, judge, 2.2, 4.4, 0.3, feedbackAt(2.2, TapNoteScore.W1));
    }).not.toThrow();
  });

  it('draws bare, reverse, hidden/sudden, X/M scroll, and danger life', () => {
    const judge = makeJudge();
    const r = new NoteFieldRenderer(4, base);
    r.resize(600, 400, 2);
    const ctx = mockCtx();
    expect(() => {
      r.applyConfig({ bare: true });
      r.draw(ctx, judge, 1, 2, 0.1, feedbackAt(1, TapNoteScore.W2));
      r.applyConfig({ bare: false, reverse: true, appearance: 'hidden' });
      r.draw(ctx, judge, 1, 2, 0.1, feedbackAt(1, TapNoteScore.W2));
      r.applyConfig({ reverse: false, appearance: 'sudden', scrollMode: 'X', scrollValue: 2 });
      r.draw(ctx, judge, 1.5, 3, 0.2, feedbackAt(1.5, TapNoteScore.Miss));
      r.applyConfig({ scrollMode: 'M', scrollValue: 600, songMaxBpm: 150 });
      judge.life = 0.1; // danger chrome / gauge state
      r.draw(ctx, judge, 2, 4, 0.4, feedbackAt(2, TapNoteScore.W4));
      judge.life = 1; // hot/full gauge state
      r.draw(ctx, judge, 2.1, 4.2, 0.5, feedbackAt(2.1, TapNoteScore.W1));
    }).not.toThrow();
  });
});
