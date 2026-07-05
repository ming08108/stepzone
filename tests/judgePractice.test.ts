/**
 * Practice-mode Judge behavior: the optional section window marks notes
 * outside [start, end) unjudgable (rendered but never hit, missed, or counted
 * toward possible points), and reset() wipes judgments/score for another loop
 * pass over the same notes.
 *
 * Charts run at 60 BPM (bps = 1) so beat N lands at exactly N seconds.
 */

import { describe, expect, it } from 'vitest';
import { Judge } from '../src/gameplay/judge';
import { DEFAULT_WINDOWS } from '../src/gameplay/windows';
import { NoteData } from '../src/notes/noteData';
import { TimingData } from '../src/timing/timingData';
import {
  beatToNoteRow,
  HoldNoteScore,
  makeTap,
  makeHoldHead,
  TapNoteScore,
  TapNoteSubType,
} from '../src/notes/noteTypes';

function sixtyBpm(): TimingData {
  const t = new TimingData();
  t.bpms = [{ row: 0, bps: 1 }]; // 60 BPM
  t.tidy();
  return t;
}

/** Taps on track 0 at beats 1, 2, and 3 (-> 1.0s, 2.0s, 3.0s). */
function threeTapChart(): NoteData {
  const nd = new NoteData(4);
  for (const beat of [1, 2, 3]) nd.setTapNote(0, beatToNoteRow(beat), makeTap());
  return nd;
}

const UP = [false, false, false, false];

describe('Judge: practice section', () => {
  const sectionJudge = () =>
    new Judge(threeTapChart(), sixtyBpm(), DEFAULT_WINDOWS, 1, {
      startSeconds: 1.5,
      endSeconds: 3, // note at 3.0s is on the exclusive edge -> outside
    });

  it('notes outside the section are unjudgable: never hit, never missed', () => {
    const j = sectionJudge();
    // A perfect press on the out-of-section note at 1.0s finds no candidate
    // (the nearest judgable note, at 2.0s, is far outside every window).
    expect(j.step(0, 1.0, false)).toBeNull();
    // Run time far past everything: only the in-section note can miss.
    j.update(60, UP);
    expect(j.tapCounts[TapNoteScore.Miss]).toBe(1);
    const judged = j.notes.filter((n) => n.tns !== TapNoteScore.None);
    expect(judged).toHaveLength(1);
    expect(judged[0].time).toBe(2);
  });

  it('possible points count only the section, so a section-perfect pass is 100%', () => {
    const j = sectionJudge();
    expect(j.step(0, 2.0, false)?.tns).toBe(TapNoteScore.W1);
    j.update(60, UP);
    expect(j.percentDancePoints).toBe(1);
  });

  it('no section (default) leaves every note judgable', () => {
    const j = new Judge(threeTapChart(), sixtyBpm());
    j.update(60, UP);
    expect(j.tapCounts[TapNoteScore.Miss]).toBe(3);
  });
});

describe('Judge: reset (practice loop pass)', () => {
  it('wipes judgments, combo, life, and counts; the same notes judge again', () => {
    const j = new Judge(threeTapChart(), sixtyBpm());
    expect(j.step(0, 1.0, false)?.tns).toBe(TapNoteScore.W1);
    j.update(60, UP); // beats 2 and 3 miss
    expect(j.tapCounts[TapNoteScore.Miss]).toBe(2);
    expect(j.failed || j.life < 0.5).toBe(true);
    const seqBefore = j.judgmentSeq;

    j.reset();
    expect(j.combo).toBe(0);
    expect(j.maxCombo).toBe(0);
    expect(j.life).toBe(0.5);
    expect(j.failed).toBe(false);
    expect(j.tapCounts[TapNoteScore.Miss]).toBeUndefined();
    expect(j.percentDancePoints).toBe(0);
    // judgmentSeq keeps counting so UI diffing never sees a stale match.
    expect(j.judgmentSeq).toBe(seqBefore);
    for (const n of j.notes) expect(n.tns).toBe(TapNoteScore.None);

    // Second pass over the same notes judges cleanly from the top.
    for (const t of [1, 2, 3]) {
      j.update(t, UP);
      expect(j.step(0, t, false)?.tns).toBe(TapNoteScore.W1);
    }
    expect(j.combo).toBe(3);
    expect(j.percentDancePoints).toBe(1);
  });

  it('clears in-flight hold state so a looped hold can be re-held', () => {
    const nd = new NoteData(4);
    const head = makeHoldHead(TapNoteSubType.Hold);
    head.durationRows = beatToNoteRow(2);
    nd.setTapNote(0, beatToNoteRow(1), head); // hold 1.0s -> 3.0s
    const j = new Judge(nd, sixtyBpm());

    // Initiate the hold, then reset mid-hold (the loop jumped back).
    j.update(1.0, UP);
    expect(j.step(0, 1.0, false)?.tns).toBe(TapNoteScore.W1);
    j.update(2.0, [true, false, false, false]);
    j.reset();

    // Re-hold to the tail on the next pass -> Held, exactly once.
    j.update(1.0, UP);
    expect(j.step(0, 1.0, false)?.tns).toBe(TapNoteScore.W1);
    j.update(3.05, [true, false, false, false]);
    expect(j.holdCounts[HoldNoteScore.Held]).toBe(1);
    expect(j.holdCounts[HoldNoteScore.LetGo]).toBeUndefined();
  });
});
