import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSimfile } from '../src/parse/loader';
import { Judge } from '../src/gameplay/judge';
import { HoldNoteScore, TapNoteScore } from '../src/notes/noteTypes';

const here = dirname(fileURLToPath(import.meta.url));
const ssc = readFileSync(join(here, '../src/dev/example.ssc'), 'utf8');

/**
 * Replays the spec doc-9 input trace:
 *   L @0.114 -> W1, D @0.660 -> W3, U missed, R hold @2.09 held to 3.6 -> Held,
 *   L mine stepped @4.61 -> HitMine.  Expected: 53.3%, max combo 2, life ~0.288.
 */
describe('Judge: doc-9 input trace (spec doc 9 §9.4)', () => {
  const song = parseSimfile(ssc, 'example.ssc');
  const chart = song.charts[0];
  const judge = new Judge(chart.getNoteData(), song.timing);

  const noHold = [false, false, false, false];
  const rHeld = [false, false, false, true];

  const e1 = judge.step(0, 0.114, false); // L tap, +14ms
  const e2 = judge.step(1, 0.66, false); // D tap, +60ms
  judge.update(1.7, noHold); // U (1.1s) ages to Miss
  const e4 = judge.step(3, 2.09, false); // R hold head, -10ms
  judge.update(2.2, rHeld); // hold held
  judge.update(3.7, rHeld); // past tail (3.6s) -> Held
  const e5 = judge.step(0, 4.61, false); // L mine, +10ms
  judge.update(6.0, noHold);

  it('scores each input as expected', () => {
    expect(e1?.tns).toBe(TapNoteScore.W1);
    expect(e2?.tns).toBe(TapNoteScore.W3);
    expect(e4?.tns).toBe(TapNoteScore.W1);
    expect(e5?.tns).toBe(TapNoteScore.HitMine);
  });

  it('records the U tap as a miss and the hold as held', () => {
    expect(judge.tapCounts[TapNoteScore.Miss]).toBe(1);
    expect(judge.holdCounts[HoldNoteScore.Held]).toBe(1);
    expect(judge.tapCounts[TapNoteScore.W1]).toBe(2); // L tap + hold head
  });

  it('tracks combo (max 2, broken by the miss)', () => {
    expect(judge.maxCombo).toBe(2);
    expect(judge.combo).toBe(1); // W1 tap -> W3 -> [miss resets] -> hold head
  });

  it('computes 53.3% dance points', () => {
    expect(judge.percentDancePoints).toBeCloseTo(8 / 15, 4);
  });

  it('ends with life ~0.288 and not failed', () => {
    expect(judge.life).toBeCloseTo(0.288, 3);
    expect(judge.failed).toBe(false);
  });
});
