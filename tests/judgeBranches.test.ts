/**
 * Judge branch coverage: rolls (refill / drop), hold LetGo vs Held, lifts,
 * mines (HitMine / AvoidMine), the miss horizon (regression: taps must miss at
 * the w5 edge, not the ~0.5s roll drop-timer), and fake notes/regions.
 *
 * All charts run at 60 BPM (bps = 1) so beat N lands at exactly N seconds and
 * every timestamp below reads directly as a beat.
 */

import { describe, expect, it } from 'vitest';
import { Judge } from '../src/gameplay/judge';
import { DEFAULT_WINDOWS, missHorizonSeconds, windowSeconds } from '../src/gameplay/windows';
import { NoteData } from '../src/notes/noteData';
import { TimingData } from '../src/timing/timingData';
import {
  beatToNoteRow,
  HoldNoteScore,
  makeFake,
  makeLift,
  makeMine,
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

/** A hold/roll head at the given beat lasting `beats` beats. */
function holdHead(sub: TapNoteSubType, beats: number) {
  const n = makeHoldHead(sub);
  n.durationRows = beatToNoteRow(beats);
  return n;
}

/** One note on track 0 of a 4-panel chart, judged with default windows. */
function oneNoteJudge(note: ReturnType<typeof makeTap>, rate = 1): Judge {
  const nd = new NoteData(4);
  nd.setTapNote(0, beatToNoteRow(1), note); // beat 1 -> 1.0s
  return new Judge(nd, sixtyBpm(), DEFAULT_WINDOWS, rate);
}

const UP = [false, false, false, false];
const DOWN0 = [true, false, false, false];

describe('Judge: rolls', () => {
  // Roll from 1.0s to 3.0s; the roll drop-timer is 0.5s.
  const rollJudge = () => oneNoteJudge(holdHead(TapNoteSubType.Roll, 2));

  it('repeated presses refill an active roll, holding it to the tail -> Held', () => {
    const j = rollJudge();
    j.update(1.0, UP);
    expect(j.step(0, 1.0, false)?.tns).toBe(TapNoteScore.W1);
    // Re-tap every ~0.45s — each gap stays under the 0.5s roll timer.
    for (const t of [1.4, 1.8, 2.25, 2.7]) {
      j.update(t, UP);
      j.step(0, t + 0.05, false); // refills holdLife to 1
    }
    j.update(3.05, UP); // past the tail
    expect(j.holdCounts[HoldNoteScore.Held]).toBe(1);
    expect(j.holdCounts[HoldNoteScore.LetGo]).toBeUndefined();
    // W1 head (+0.008) + Held (+0.008) on the 0.5 starting life.
    expect(j.life).toBeCloseTo(0.516, 6);
  });

  it('holding the button does not sustain a roll: it drops once the timer expires', () => {
    const j = rollJudge();
    j.update(1.0, DOWN0);
    expect(j.step(0, 1.0, false)?.tns).toBe(TapNoteScore.W1);
    j.update(1.3, DOWN0); // 0.3s elapsed -> life 0.4
    j.update(1.7, DOWN0); // 0.7s > 0.5s roll timer with no re-tap -> life 0
    j.update(3.05, DOWN0);
    expect(j.holdCounts[HoldNoteScore.LetGo]).toBe(1);
    expect(j.holdCounts[HoldNoteScore.Held]).toBeUndefined();
    // W1 head (+0.008) then LetGo (-0.08).
    expect(j.life).toBeCloseTo(0.428, 6);
  });
});

describe('Judge: hold LetGo / Held', () => {
  // Hold from 1.0s to 3.0s; the hold drop-timer is 0.25s.
  const holdJudge = () => oneNoteJudge(holdHead(TapNoteSubType.Hold, 2));

  it('held through the tail -> Held', () => {
    const j = holdJudge();
    expect(j.step(0, 1.0, false)?.tns).toBe(TapNoteScore.W1);
    j.update(2.0, DOWN0);
    j.update(3.05, DOWN0);
    expect(j.holdCounts[HoldNoteScore.Held]).toBe(1);
    expect(j.life).toBeCloseTo(0.516, 6); // +0.008 (W1) +0.008 (Held)
  });

  it('released for longer than the 0.25s hold window -> LetGo', () => {
    const j = holdJudge();
    expect(j.step(0, 1.0, false)?.tns).toBe(TapNoteScore.W1);
    j.update(1.1, DOWN0); // held: life pinned at 1
    j.update(1.2, UP); // 0.1s released -> life 0.6
    j.update(1.5, UP); // 0.4s total > 0.25s window -> life 0
    j.update(3.05, UP);
    expect(j.holdCounts[HoldNoteScore.LetGo]).toBe(1);
    expect(j.holdCounts[HoldNoteScore.Held]).toBeUndefined();
    expect(j.life).toBeCloseTo(0.428, 6); // +0.008 (W1) -0.08 (LetGo)
  });

  it('a brief release shorter than the window recovers -> Held', () => {
    const j = holdJudge();
    j.step(0, 1.0, false);
    j.update(1.1, DOWN0);
    j.update(1.2, UP); // life decays to 0.6
    j.update(1.3, DOWN0); // regrabbed before it died: life back to 1
    j.update(3.05, DOWN0);
    expect(j.holdCounts[HoldNoteScore.Held]).toBe(1);
  });

  it('a hold head never pressed -> tap Miss and hold Missed', () => {
    const j = holdJudge();
    j.update(1.19, UP); // just past the 1.0 + 0.18s miss horizon
    expect(j.tapCounts[TapNoteScore.Miss]).toBe(1);
    expect(j.holdCounts[HoldNoteScore.Missed]).toBe(1);
  });
});

describe('Judge: lifts', () => {
  it('a press does not judge a lift', () => {
    const j = oneNoteJudge(makeLift());
    expect(j.step(0, 1.0, false)).toBeNull();
    expect(j.judgmentSeq).toBe(0);
  });

  it('a release within the window judges the lift on the tap ladder', () => {
    const j = oneNoteJudge(makeLift());
    const e = j.step(0, 1.01, true); // 10ms late release -> W1
    expect(e?.tns).toBe(TapNoteScore.W1);
    expect(j.tapCounts[TapNoteScore.W1]).toBe(1);
  });

  it('an untouched lift ages to a Miss like a tap', () => {
    const j = oneNoteJudge(makeLift());
    j.update(1.19, UP);
    expect(j.tapCounts[TapNoteScore.Miss]).toBe(1);
  });
});

describe('Judge: mines', () => {
  it('a press inside the mine window -> HitMine with the -0.16 life hit', () => {
    const j = oneNoteJudge(makeMine());
    const e = j.step(0, 1.05, false); // 50ms <= 90ms mine window
    expect(e?.tns).toBe(TapNoteScore.HitMine);
    expect(j.tapCounts[TapNoteScore.HitMine]).toBe(1);
    expect(j.life).toBeCloseTo(0.34, 6);
  });

  it('a press outside the mine window is ignored', () => {
    const j = oneNoteJudge(makeMine());
    expect(j.step(0, 1.15, false)).toBeNull(); // 150ms > 90ms
    expect(j.life).toBe(0.5);
  });

  it('a release over a mine does not trigger it', () => {
    const j = oneNoteJudge(makeMine());
    expect(j.step(0, 1.0, true)).toBeNull();
    expect(j.tapCounts[TapNoteScore.HitMine]).toBeUndefined();
  });

  it('an unpressed mine ages to AvoidMine with no life loss', () => {
    const j = oneNoteJudge(makeMine());
    j.update(1.25, UP); // past 1.0 + max(w5, mine) = 1.18
    expect(j.tapCounts[TapNoteScore.AvoidMine]).toBe(1);
    expect(j.tapCounts[TapNoteScore.Miss]).toBeUndefined();
    expect(j.life).toBe(0.5);
    expect(j.failed).toBe(false);
  });

  it('hitting a mine between taps does not break the combo', () => {
    const nd = new NoteData(4);
    nd.setTapNote(0, beatToNoteRow(1), makeTap());
    nd.setTapNote(0, beatToNoteRow(2), makeMine());
    nd.setTapNote(0, beatToNoteRow(3), makeTap());
    const j = new Judge(nd, sixtyBpm());
    expect(j.step(0, 1.0, false)?.tns).toBe(TapNoteScore.W1);
    expect(j.step(0, 2.05, false)?.tns).toBe(TapNoteScore.HitMine);
    expect(j.combo).toBe(1); // mine neither extends nor resets it
    expect(j.step(0, 3.0, false)?.tns).toBe(TapNoteScore.W1);
    expect(j.combo).toBe(2);
    expect(j.maxCombo).toBe(2);
  });
});

describe('Judge: miss horizon (regression: taps must not wait for the roll timer)', () => {
  it('missHorizonSeconds is the w5/mine edge, excluding the hold/roll timers', () => {
    expect(missHorizonSeconds(DEFAULT_WINDOWS)).toBeCloseTo(0.18, 9);
    expect(missHorizonSeconds(DEFAULT_WINDOWS)).toBeLessThan(
      windowSeconds(DEFAULT_WINDOWS, 'roll'),
    );
    // If the mine window is widened past w5, it becomes the horizon.
    expect(missHorizonSeconds({ ...DEFAULT_WINDOWS, mine: 0.3 })).toBeCloseTo(0.3, 9);
  });

  it('a tap misses just after w5 closes, long before the 0.5s roll timer', () => {
    const j = oneNoteJudge(makeTap());
    j.update(1.17, UP); // 1.0 + w5(0.18) not yet reached
    expect(j.tapCounts[TapNoteScore.Miss]).toBeUndefined();
    j.update(1.19, UP); // past the w5 edge — and far before 1.0 + roll(0.5)
    expect(j.tapCounts[TapNoteScore.Miss]).toBe(1);
  });

  it('records the miss offset as the w5 window, not the roll timer', () => {
    const j = oneNoteJudge(makeTap());
    j.update(2.0, UP);
    expect(j.notes[0].tns).toBe(TapNoteScore.Miss);
    expect(j.notes[0].offset).toBeCloseTo(windowSeconds(DEFAULT_WINDOWS, 'w5'), 9);
    expect(j.notes[0].offset).toBeLessThan(windowSeconds(DEFAULT_WINDOWS, 'roll'));
  });

  it('rate-scales both the horizon and the recorded miss offset', () => {
    const j = oneNoteJudge(makeTap(), 2); // horizon = 0.18 * 2 = 0.36
    j.update(1.35, UP);
    expect(j.tapCounts[TapNoteScore.Miss]).toBeUndefined();
    j.update(1.37, UP);
    expect(j.tapCounts[TapNoteScore.Miss]).toBe(1);
    expect(j.notes[0].offset).toBeCloseTo(0.36, 9);
  });
});

describe('Judge: fake notes and fake regions are never judged', () => {
  it('a tap inside a #FAKES region can be neither hit nor missed', () => {
    const nd = new NoteData(4);
    nd.setTapNote(0, beatToNoteRow(1), makeTap());
    const t = sixtyBpm();
    t.fakes = [{ row: 0, lengthRows: beatToNoteRow(2) }]; // beats [0, 2)
    const j = new Judge(nd, t);
    expect(j.notes[0].judgable).toBe(false);
    expect(j.step(0, 1.0, false)).toBeNull();
    j.update(3.0, UP);
    expect(j.tapCounts[TapNoteScore.Miss]).toBeUndefined();
    expect(j.judgmentSeq).toBe(0);
    expect(j.life).toBe(0.5);
  });

  it('a TapNoteType.Fake note can be neither hit nor missed', () => {
    const j = oneNoteJudge(makeFake());
    expect(j.notes[0].judgable).toBe(false);
    expect(j.step(0, 1.0, false)).toBeNull();
    j.update(3.0, UP);
    expect(j.tapCounts[TapNoteScore.Miss]).toBeUndefined();
    expect(j.judgmentSeq).toBe(0);
  });
});

describe('Judge: immediate LetGo latch (ITG ImmediateHoldLetGo)', () => {
  const holdJudge = () => oneNoteJudge(holdHead(TapNoteSubType.Hold, 2));
  const rollJudge = () => oneNoteJudge(holdHead(TapNoteSubType.Roll, 2));

  it('a hold is scored LetGo the moment its life hits zero, not at the tail', () => {
    const j = holdJudge();
    expect(j.step(0, 1.0, false)?.tns).toBe(TapNoteScore.W1);
    j.update(1.1, DOWN0); // held: life pinned at 1
    j.update(1.5, UP); // 0.4s released > 0.25s window -> life 0, latched NOW
    // Tail is at 3.0s — the judgment and life delta must already have landed.
    expect(j.holdCounts[HoldNoteScore.LetGo]).toBe(1);
    expect(j.life).toBeCloseTo(0.428, 6); // +0.008 (W1) -0.08 (LetGo)
    expect(j.combo).toBe(1); // ComboBreakOnImmediateHoldLetGo is off for dance
  });

  it('regrabbing a dead hold does not resurrect it to Held', () => {
    const j = holdJudge();
    j.step(0, 1.0, false);
    j.update(1.1, DOWN0);
    j.update(1.5, UP); // life 0 -> LetGo latched
    j.update(1.6, DOWN0); // regrab after death
    j.update(3.05, DOWN0); // held through the tail
    expect(j.holdCounts[HoldNoteScore.Held]).toBeUndefined();
    expect(j.holdCounts[HoldNoteScore.LetGo]).toBe(1); // and not double-counted
    expect(j.life).toBeCloseTo(0.428, 6);
  });

  it('re-tapping a dead roll does not refill or resurrect it', () => {
    const j = rollJudge();
    expect(j.step(0, 1.0, false)?.tns).toBe(TapNoteScore.W1);
    j.update(1.7, UP); // 0.7s > 0.5s roll timer -> life 0, LetGo latched
    expect(j.holdCounts[HoldNoteScore.LetGo]).toBe(1);
    j.step(0, 1.8, false); // re-tap after death: must not refill
    j.update(3.05, UP);
    expect(j.holdCounts[HoldNoteScore.Held]).toBeUndefined();
    expect(j.holdCounts[HoldNoteScore.LetGo]).toBe(1);
  });
});

describe('Judge: `hidden` marks notes consumed by input, not merely judged', () => {
  // Regression: misses used to set hidden, so the arrow vanished ~0.18s past
  // the receptor instead of scrolling off the top of the field.
  it('a hit tap is consumed; a missed tap keeps drawing to scroll off', () => {
    const hit = oneNoteJudge(makeTap());
    expect(hit.step(0, 1.0, false)?.tns).toBe(TapNoteScore.W1);
    expect(hit.notes[0].hidden).toBe(true);

    const missed = oneNoteJudge(makeTap());
    missed.update(1.25, UP); // past 1.0 + the 0.18s miss horizon
    expect(missed.notes[0].tns).toBe(TapNoteScore.Miss);
    expect(missed.notes[0].hidden).toBe(false);
  });

  it('a stepped mine is consumed; an avoided mine keeps drawing to scroll off', () => {
    const stepped = oneNoteJudge(makeMine());
    expect(stepped.step(0, 1.0, false)?.tns).toBe(TapNoteScore.HitMine);
    expect(stepped.notes[0].hidden).toBe(true);

    const avoided = oneNoteJudge(makeMine());
    avoided.update(1.25, UP);
    expect(avoided.notes[0].tns).toBe(TapNoteScore.AvoidMine);
    expect(avoided.notes[0].hidden).toBe(false);
  });
});
