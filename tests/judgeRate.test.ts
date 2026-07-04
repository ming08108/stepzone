import { describe, expect, it } from 'vitest';
import { Judge } from '../src/gameplay/judge';
import { DEFAULT_WINDOWS } from '../src/gameplay/windows';
import { NoteData } from '../src/notes/noteData';
import { TimingData } from '../src/timing/timingData';
import { beatToNoteRow, makeTap, TapNoteScore } from '../src/notes/noteTypes';

function oneTapChart() {
  const nd = new NoteData(4);
  nd.setTapNote(0, beatToNoteRow(1), makeTap()); // beat 1
  const t = new TimingData();
  t.bpms = [{ row: 0, bps: 2 }]; // 120 BPM -> beat 1 at 0.5s
  t.tidy();
  return { nd, t };
}

describe('Judge scales windows by music rate (todo #10)', () => {
  it('a 40ms-late tap is W2 at 1x but W1 at 2x', () => {
    const { nd, t } = oneTapChart();
    // Note at 0.5s; tap at 0.54s => 40ms late (chart-seconds).
    const at1 = new Judge(nd, t, DEFAULT_WINDOWS, 1).step(0, 0.54, false);
    const at2 = new Judge(nd, t, DEFAULT_WINDOWS, 2).step(0, 0.54, false);
    expect(at1?.tns).toBe(TapNoteScore.W2); // 40ms > W1(22.5) at 1x
    expect(at2?.tns).toBe(TapNoteScore.W1); // W1 window doubles to 45ms at 2x
  });
});
