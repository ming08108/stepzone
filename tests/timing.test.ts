import { describe, expect, it } from 'vitest';
import { TimingData } from '../src/timing/timingData';
import { beatToNoteRow } from '../src/notes/noteTypes';

/** The worked example from spec doc 9: 120->60 BPM, a 0.5s stop at beat 2. */
function workedExampleTiming(): TimingData {
  const t = new TimingData();
  t.offsetSeconds = -0.1;
  t.bpms = [
    { row: beatToNoteRow(0), bps: 120 / 60 },
    { row: beatToNoteRow(4), bps: 60 / 60 },
  ];
  t.stops = [{ row: beatToNoteRow(2), seconds: 0.5 }];
  t.tidy();
  return t;
}

describe('TimingData beat -> second (worked example, spec doc 9)', () => {
  const t = workedExampleTiming();
  const cases: Array<[beat: number, seconds: number]> = [
    [0, 0.1],
    [1, 0.6],
    [2, 1.1],
    [3, 2.1],
    [4, 2.6],
    [5, 3.6],
    [6, 4.6],
  ];
  for (const [beat, seconds] of cases) {
    it(`beat ${beat} -> ${seconds}s`, () => {
      expect(t.getElapsedTimeFromBeat(beat)).toBeCloseTo(seconds, 6);
    });
  }
});

describe('TimingData second -> beat (inverse)', () => {
  const t = workedExampleTiming();
  it('is the inverse of beat -> second', () => {
    for (const beat of [0, 1, 3, 4, 5, 6]) {
      const s = t.getElapsedTimeFromBeat(beat);
      expect(t.getBeatFromElapsedTime(s)).toBeCloseTo(beat, 4);
    }
  });

  it('freezes the beat during a stop', () => {
    // The 0.5s stop at beat 2 spans audio 1.1s .. 1.6s.
    const mid = t.getBeatInfoFromElapsedTime(1.35);
    expect(mid.beat).toBeCloseTo(2, 6);
    expect(mid.freeze).toBe(true);
  });
});

describe('TimingData warps', () => {
  const t = new TimingData();
  t.bpms = [{ row: beatToNoteRow(0), bps: 120 / 60 }];
  t.warps = [{ row: beatToNoteRow(2), lengthRows: beatToNoteRow(2) }]; // skip beats [2,4)
  t.tidy();

  it('consumes zero real time across the warp', () => {
    const tBeat2 = t.getElapsedTimeFromBeat(2);
    const tBeat3 = t.getElapsedTimeFromBeat(3); // inside the warp
    const tBeat4 = t.getElapsedTimeFromBeat(4); // warp destination
    expect(tBeat2).toBeCloseTo(1.0, 6); // 2 beats at 2 bps
    expect(tBeat3).toBeCloseTo(1.0, 6);
    expect(tBeat4).toBeCloseTo(1.0, 6);
  });

  it('marks warped rows unjudgable', () => {
    expect(t.isWarpAtRow(beatToNoteRow(3))).toBe(true);
    expect(t.isJudgableAtRow(beatToNoteRow(3))).toBe(false);
    expect(t.isJudgableAtRow(beatToNoteRow(1))).toBe(true);
  });
});
