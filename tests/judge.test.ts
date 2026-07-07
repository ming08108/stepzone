import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSimfile } from '../src/parse/loader';
import { Judge } from '../src/gameplay/judge';
import { DEFAULT_WINDOWS } from '../src/gameplay/windows';
import { NoteData } from '../src/notes/noteData';
import { TimingData } from '../src/timing/timingData';
import {
  beatToNoteRow,
  HoldNoteScore,
  NO_KEYSOUND,
  NO_PLAYER,
  TapNoteScore,
  TapNoteSubType,
  TapNoteType,
} from '../src/notes/noteTypes';

/** A judge over a tiny 4-panel chart at 60 BPM, so beat N == N seconds. */
function judgeOf(taps: Array<[beat: number, track: number]>): Judge {
  const nd = new NoteData(4);
  for (const [beat, track] of taps)
    nd.setTapNote(track, beatToNoteRow(beat), {
      type: TapNoteType.Tap,
      subType: TapNoteSubType.Invalid,
      durationRows: 0,
      keysoundIndex: NO_KEYSOUND,
      player: NO_PLAYER,
    });
  const timing = new TimingData();
  timing.bpms.push({ row: 0, bps: 1 }); // 60 BPM
  timing.tidy();
  return new Judge(nd, timing);
}

function tapNote(type = TapNoteType.Tap) {
  return {
    type,
    subType: TapNoteSubType.Invalid,
    durationRows: 0,
    keysoundIndex: NO_KEYSOUND,
    player: NO_PLAYER,
  };
}

function timing60(): TimingData {
  const t = new TimingData();
  t.bpms.push({ row: 0, bps: 1 }); // 60 BPM: beat N == N seconds; beat 0 == time 0
  t.tidy();
  return t;
}

/** One note at row 0 (time exactly 0), so a press offset IS the raw error —
 *  no float drift from a non-zero note time — for exact-boundary assertions. */
function singleJudge(type = TapNoteType.Tap, rate = 1): Judge {
  const nd = new NoteData(4);
  nd.setTapNote(0, beatToNoteRow(0), tapNote(type));
  return new Judge(nd, timing60(), DEFAULT_WINDOWS, rate);
}

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

  it('ends with life ~0.272 and not failed', () => {
    // ITG regen-after-miss: the U miss withholds regen for the next hits, so the
    // hold head (+0.008) and Held (+0.008) after it don't refill. The spec's
    // hand-calc (0.288) omitted that; actual ITGmania LifeMeterBar gives 0.272.
    expect(judge.life).toBeCloseTo(0.272, 3);
    expect(judge.failed).toBe(false);
  });
});

describe('Judge: regen-after-miss (ITG LifeMeterBar)', () => {
  it('withholds life regen for five hits after a loss', () => {
    const j = judgeOf([
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
      [6, 0],
      [7, 0],
    ]);
    // Miss the first note (aged past the window), dropping life by 0.08.
    j.update(3.0, []);
    const afterMiss = j.life;
    expect(afterMiss).toBeCloseTo(0.42, 3);
    // The next four W1s are blocked from regenerating — life stays put.
    for (const t of [3, 4, 5, 6]) j.step(0, t, false);
    expect(j.life).toBeCloseTo(afterMiss, 3);
    // The fifth hit pays down the last owed combo and life finally refills.
    j.step(0, 7, false);
    expect(j.life).toBeGreaterThan(afterMiss);
  });
});

describe('Judge: jump combo cohesion (ITG row-worst break)', () => {
  it('breaks combo by the row worst tap, regardless of hit order', () => {
    // good foot (W1) first, then the bad foot (W4, 120ms).
    const a = judgeOf([
      [2, 0],
      [2, 1],
    ]);
    a.step(0, 2.0, false);
    a.step(1, 2.12, false);
    expect(a.combo).toBe(0);

    // bad foot first — must still end at 0 (per-note combo would leave 1).
    const b = judgeOf([
      [2, 0],
      [2, 1],
    ]);
    b.step(1, 2.12, false);
    b.step(0, 2.0, false);
    expect(b.combo).toBe(0);
  });

  it('a clean jump adds one combo per tap in the row', () => {
    const j = judgeOf([
      [2, 0],
      [2, 1],
      [3, 2],
    ]);
    j.step(0, 2.0, false);
    j.step(1, 2.0, false);
    expect(j.combo).toBe(2); // jump of two W1s
    j.step(2, 3.0, false);
    expect(j.combo).toBe(3);
  });
});

describe('Judge: FA+ white Fantastic (display-only)', () => {
  it('flags a W1 white inside the tight window and blue outside it', () => {
    const j = judgeOf([
      [2, 0],
      [3, 1],
    ]);
    const tight = j.step(0, 2.005, false); // +5ms, inside w0 (11.5ms)
    expect(tight?.tns).toBe(TapNoteScore.W1);
    expect(tight?.white).toBe(true);

    const loose = j.step(1, 3.018, false); // +18ms, W1 but outside w0
    expect(loose?.tns).toBe(TapNoteScore.W1);
    expect(loose?.white).toBe(false);
  });
});

describe('Judge: timing-window boundaries', () => {
  const tns = (off: number, type = TapNoteType.Tap, rate = 1) =>
    singleJudge(type, rate).step(0, off, false)?.tns ?? null;

  it('is inclusive (<=): a hit exactly at each edge is the tighter tier', () => {
    expect(tns(0.0225)).toBe(TapNoteScore.W1);
    expect(tns(0.045)).toBe(TapNoteScore.W2);
    expect(tns(0.09)).toBe(TapNoteScore.W3);
    expect(tns(0.135)).toBe(TapNoteScore.W4);
    expect(tns(0.18)).toBe(TapNoteScore.W5);
  });

  it('falls to the next tier just past each edge', () => {
    expect(tns(0.0225 + 1e-5)).toBe(TapNoteScore.W2);
    expect(tns(0.045 + 1e-5)).toBe(TapNoteScore.W3);
    expect(tns(0.09 + 1e-5)).toBe(TapNoteScore.W4);
    expect(tns(0.135 + 1e-5)).toBe(TapNoteScore.W5);
    expect(tns(0.18 + 1e-5)).toBeNull(); // past W5 → stray press, no judgment
  });

  it('is symmetric early vs late', () => {
    expect(tns(-0.0225)).toBe(TapNoteScore.W1);
    expect(tns(-0.045)).toBe(TapNoteScore.W2);
    expect(tns(-0.18)).toBe(TapNoteScore.W5);
    expect(tns(-0.18 - 1e-5)).toBeNull();
  });

  it('scales the windows by the music rate', () => {
    // 30ms is W2 at 1x but W1 at 2x (each window doubles in chart-seconds).
    expect(tns(0.03, TapNoteType.Tap, 1)).toBe(TapNoteScore.W2);
    expect(tns(0.03, TapNoteType.Tap, 2)).toBe(TapNoteScore.W1);
    // 0.36s is out of every window at 1x, exactly W5's edge at 2x.
    expect(tns(0.36, TapNoteType.Tap, 1)).toBeNull();
    expect(tns(0.36, TapNoteType.Tap, 2)).toBe(TapNoteScore.W5);
  });

  it('mine window is inclusive and only hit on press', () => {
    expect(tns(0.09, TapNoteType.Mine)).toBe(TapNoteScore.HitMine);
    expect(tns(0.09 + 1e-5, TapNoteType.Mine)).toBeNull(); // outside → not hit
    expect(singleJudge(TapNoteType.Mine).step(0, 0.0, true)).toBeNull(); // release never hits a mine
  });
});

describe('Judge: miss-horizon boundary', () => {
  it('a note is still hittable at exactly +W5, and misses just past it', () => {
    const edge = singleJudge();
    edge.update(0.18, []); // horizon == note time → not yet a miss
    expect(edge.step(0, 0.18, false)?.tns).toBe(TapNoteScore.W5);

    const past = singleJudge();
    past.update(0.18 + 1e-3, []); // just past → aged to Miss
    expect(past.tapCounts[TapNoteScore.Miss]).toBe(1);
    expect(past.step(0, 0.18, false)).toBeNull(); // already judged
  });
});

describe('Judge: note selection ties and jacks', () => {
  // Two notes in one column six rows (0.125s at 60 BPM) apart.
  const twoInColumn = () => {
    const nd = new NoteData(4);
    nd.setTapNote(0, 0, tapNote());
    nd.setTapNote(0, 6, tapNote());
    const j = new Judge(nd, timing60());
    const [a, b] = j.notes; // time-sorted: earlier (row 0), later (row 6)
    return { j, a, b };
  };

  it('a press equidistant between two notes takes the earlier one', () => {
    const { j, a, b } = twoInColumn();
    j.step(0, (a.time + b.time) / 2, false);
    expect(a.tns).not.toBe(TapNoteScore.None);
    expect(b.tns).toBe(TapNoteScore.None);
  });

  it('picks the strictly nearest note — a jack can be judged out of order', () => {
    const { j, a, b } = twoInColumn();
    // Press closest to the LATER note: it is judged, the earlier note is skipped.
    const ev = j.step(0, b.time - 0.01, false);
    expect(ev?.tns).toBe(TapNoteScore.W1);
    expect(b.tns).toBe(TapNoteScore.W1);
    expect(a.tns).toBe(TapNoteScore.None);
  });
});
