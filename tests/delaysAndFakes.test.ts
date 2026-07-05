import { describe, expect, it } from 'vitest';
import { TimingData } from '../src/timing/timingData';
import { beatToNoteRow } from '../src/notes/noteTypes';

/** 120 BPM (2 beats/sec) baseline; segments added per test. */
function at120(): TimingData {
  const t = new TimingData();
  t.bpms = [{ row: 0, bps: 120 / 60 }];
  return t;
}

describe('TimingData delays vs stops (event order, spec doc 2)', () => {
  it('a STOP is applied after its row: beat->time at the row excludes it', () => {
    const t = at120();
    t.stops = [{ row: beatToNoteRow(2), seconds: 0.5 }];
    t.tidy();
    expect(t.getElapsedTimeFromBeat(2)).toBeCloseTo(1.0, 6); // stop not yet served
    expect(t.getElapsedTimeFromBeat(3)).toBeCloseTo(2.0, 6); // 1.5s of beats + 0.5s stop
  });

  it('a DELAY is applied before its row: beat->time at the row includes it', () => {
    const t = at120();
    t.delays = [{ row: beatToNoteRow(2), seconds: 0.5 }];
    t.tidy();
    expect(t.getElapsedTimeFromBeat(2)).toBeCloseTo(1.5, 6); // delay already served
    expect(t.getElapsedTimeFromBeat(3)).toBeCloseTo(2.0, 6);
  });

  it('time->beat freezes on the delay row and reports delay (not freeze)', () => {
    const t = at120();
    t.delays = [{ row: beatToNoteRow(2), seconds: 0.5 }];
    t.tidy();
    // The delay spans audio 1.0s .. 1.5s.
    const mid = t.getBeatInfoFromElapsedTime(1.25);
    expect(mid.beat).toBeCloseTo(2, 6);
    expect(mid.delay).toBe(true);
    expect(mid.freeze).toBe(false);
    // After the delay, the beat resumes advancing.
    expect(t.getBeatFromElapsedTime(1.75)).toBeCloseTo(2.5, 6);
  });

  it('a delay and a stop on the same row: delay elapses first, then the stop', () => {
    const t = at120();
    t.delays = [{ row: beatToNoteRow(2), seconds: 0.4 }];
    t.stops = [{ row: beatToNoteRow(2), seconds: 0.6 }];
    t.tidy();

    // Beat 2 is reached after the delay but before the stop.
    expect(t.getElapsedTimeFromBeat(2)).toBeCloseTo(1.4, 6);
    expect(t.getElapsedTimeFromBeat(3)).toBeCloseTo(2.5, 6); // 1.5 + 0.4 + 0.6

    // Audio 1.0..1.4 is the delay; 1.4..2.0 is the stop.
    const inDelay = t.getBeatInfoFromElapsedTime(1.2);
    expect(inDelay.beat).toBeCloseTo(2, 6);
    expect(inDelay.delay).toBe(true);
    expect(inDelay.freeze).toBe(false);

    const inStop = t.getBeatInfoFromElapsedTime(1.7);
    expect(inStop.beat).toBeCloseTo(2, 6);
    expect(inStop.freeze).toBe(true);
    expect(inStop.delay).toBe(false);

    expect(t.getBeatFromElapsedTime(2.25)).toBeCloseTo(2.5, 6);
  });
});

describe('TimingData fake regions', () => {
  const t = at120();
  t.fakes = [{ row: beatToNoteRow(2), lengthRows: beatToNoteRow(2) }]; // beats [2, 4)
  t.tidy();

  it('covers [start, end): start inclusive, end exclusive', () => {
    expect(t.isFakeAtRow(beatToNoteRow(1))).toBe(false);
    expect(t.isFakeAtRow(beatToNoteRow(2))).toBe(true);
    expect(t.isFakeAtRow(beatToNoteRow(3))).toBe(true);
    expect(t.isFakeAtRow(beatToNoteRow(4))).toBe(false);
  });

  it('makes rows unjudgable without marking them warped', () => {
    expect(t.isJudgableAtRow(beatToNoteRow(3))).toBe(false);
    expect(t.isWarpAtRow(beatToNoteRow(3))).toBe(false);
    expect(t.isJudgableAtRow(beatToNoteRow(1))).toBe(true);
    expect(t.isJudgableAtRow(beatToNoteRow(4))).toBe(true);
  });

  it('never affects beat<->time conversion', () => {
    expect(t.getElapsedTimeFromBeat(4)).toBeCloseTo(2.0, 6); // 4 beats @ 2 bps
    expect(t.getBeatFromElapsedTime(1.5)).toBeCloseTo(3, 6);
  });
});
