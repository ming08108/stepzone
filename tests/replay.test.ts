import { describe, it, expect } from 'vitest';
import {
  parseReplay,
  sampleReplay,
  replayDuration,
  exPercentAt,
  comboAt,
  NBODY,
  type JudgmentName,
} from '../src/render/replay';

const POS_LEN = NBODY * 3;
const FULL_LEN = POS_LEN + NBODY * 4;

/** Build a raw replay object with `count` frames. `quatFn`/`posFn` fill data. */
function makeRaw(opts: {
  fps?: number;
  count: number;
  withQuat?: boolean;
  posFn?: (frame: number, body: number) => [number, number, number];
  quatFn?: (frame: number, body: number) => [number, number, number, number]; // WXYZ
  notes?: {
    t: number;
    pad: number;
    foot: number;
    judgment: JudgmentName;
    hit_dt_ms: number | null;
  }[];
}) {
  const frames: number[][] = [];
  for (let f = 0; f < opts.count; f++) {
    const row: number[] = [];
    for (let b = 0; b < NBODY; b++) {
      const p = opts.posFn ? opts.posFn(f, b) : [0, 0, 0];
      row.push(p[0], p[1], p[2]);
    }
    if (opts.withQuat) {
      for (let b = 0; b < NBODY; b++) {
        const q = opts.quatFn ? opts.quatFn(f, b) : [1, 0, 0, 0];
        row.push(q[0], q[1], q[2], q[3]);
      }
    }
    frames.push(row);
  }
  return {
    version: 1,
    fps: opts.fps ?? 30,
    chart: { name: 'Test', notes: opts.notes ?? [] },
    frames,
    meta: { ex_score: 22.8 },
  };
}

describe('parseReplay', () => {
  it('parses a minimal pos-only replay', () => {
    const r = parseReplay(makeRaw({ count: 3 }));
    expect(r.fps).toBe(30);
    expect(r.frames.length).toBe(3);
    expect(r.hasQuat).toBe(false);
    expect(r.chart.name).toBe('Test');
  });

  it('parses a pos+quat replay and flags hasQuat', () => {
    const r = parseReplay(makeRaw({ count: 2, withQuat: true }));
    expect(r.hasQuat).toBe(true);
    expect(r.frames[0].length).toBe(FULL_LEN);
  });

  it('rejects empty frames', () => {
    expect(() => parseReplay(makeRaw({ count: 0 }))).toThrow(/non-empty/);
  });

  it('rejects a bad frame width', () => {
    const raw = makeRaw({ count: 2 });
    raw.frames[0] = [1, 2, 3]; // wrong width
    expect(() => parseReplay(raw)).toThrow(/frame width|width/);
  });

  it('rejects a ragged frame', () => {
    const raw = makeRaw({ count: 2 });
    raw.frames[1] = raw.frames[1].slice(0, POS_LEN - 1);
    expect(() => parseReplay(raw)).toThrow();
  });

  it('sorts notes by time and clamps pad/foot/judgment', () => {
    const r = parseReplay(
      makeRaw({
        count: 2,
        notes: [
          { t: 1.0, pad: 9, foot: 5, judgment: 'weird' as JudgmentName, hit_dt_ms: null },
          { t: 0.2, pad: 2, foot: 1, judgment: 'perfect', hit_dt_ms: -3 },
        ],
      }),
    );
    expect(r.chart.notes[0].t).toBe(0.2);
    expect(r.chart.notes[1].pad).toBe(3); // clamped
    expect(r.chart.notes[1].foot).toBe(1);
    expect(r.chart.notes[1].judgment).toBe('miss'); // unknown -> miss
  });
});

describe('sampleReplay position interpolation', () => {
  it('lerps positions linearly at the midpoint (fps 30)', () => {
    // deltas stay under SNAP_JUMP (0.6 m) so this is smooth motion, not a reset
    const r = parseReplay(
      makeRaw({
        count: 2,
        fps: 30,
        posFn: (f, b) => (b === 0 ? [0.1 * f, 0.2 * f, 0] : [0, 0, 0]),
      }),
    );
    // midpoint between frame 0 and 1 is t = 0.5/30
    const pose = sampleReplay(r, 0.5 / 30);
    expect(pose.pos[0]).toBeCloseTo(0.05, 6);
    expect(pose.pos[1]).toBeCloseTo(0.1, 6);
  });

  it('handles fps 60 indexing generically', () => {
    const r = parseReplay(
      makeRaw({ count: 3, fps: 60, posFn: (f, b) => (b === 0 ? [0.1 * f, 0, 0] : [0, 0, 0]) }),
    );
    // t=1/60 lands exactly on frame 1
    expect(sampleReplay(r, 1 / 60).pos[0]).toBeCloseTo(0.1, 6);
    // t=1.5/60 is halfway between frame 1 and 2
    expect(sampleReplay(r, 1.5 / 60).pos[0]).toBeCloseTo(0.15, 6);
  });

  it('clamps before the first and after the last frame', () => {
    const r = parseReplay(
      makeRaw({ count: 2, posFn: (f, b) => (b === 0 ? [0.1 * f, 0, 0] : [0, 0, 0]) }),
    );
    expect(sampleReplay(r, -5).pos[0]).toBeCloseTo(0, 6);
    expect(sampleReplay(r, 999).pos[0]).toBeCloseTo(0.1, 6);
  });

  it('snaps (does not smear) across a teleport jump', () => {
    const r = parseReplay(
      makeRaw({
        count: 2,
        // body 0 jumps 5 m between frames -> env reset
        posFn: (f, b) => (b === 0 ? [f * 5, 0, 0] : [0, 0, 0]),
      }),
    );
    const pose = sampleReplay(r, 0.5 / 30); // frac 0.5
    // With snapping it must equal one endpoint (0 or 5), never the 2.5 midpoint.
    expect([0, 5]).toContain(pose.pos[0]);
  });
});

describe('sampleReplay quaternion slerp', () => {
  it('slerps identity -> 90deg about Y to 45deg at the midpoint, in XYZW', () => {
    const s = Math.SQRT1_2; // sin/cos 45
    const r = parseReplay(
      makeRaw({
        count: 2,
        withQuat: true,
        quatFn: (f, b) => {
          if (b !== 0) return [1, 0, 0, 0];
          return f === 0 ? [1, 0, 0, 0] : [s, 0, s, 0]; // WXYZ: 0 and 90deg about Y
        },
      }),
    );
    const pose = sampleReplay(r, 0.5 / 30);
    expect(pose.quatXYZW).not.toBeNull();
    const q = pose.quatXYZW!;
    // 45deg about Y -> XYZW (0, sin22.5, 0, cos22.5)
    expect(q[0]).toBeCloseTo(0, 5); // x
    expect(q[1]).toBeCloseTo(Math.sin(Math.PI / 8), 5); // y
    expect(q[2]).toBeCloseTo(0, 5); // z
    expect(q[3]).toBeCloseTo(Math.cos(Math.PI / 8), 5); // w
    // stays unit length
    expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 6);
  });

  it('reorders WXYZ -> XYZW on an exact frame hit', () => {
    const r = parseReplay(
      makeRaw({
        count: 2,
        withQuat: true,
        quatFn: (_f, b) => (b === 0 ? [0.1, 0.2, 0.3, 0.4] : [1, 0, 0, 0]),
      }),
    );
    const q = sampleReplay(r, 0)!.quatXYZW!;
    // WXYZ (0.1,0.2,0.3,0.4) -> XYZW (0.2,0.3,0.4,0.1)
    expect(q[0]).toBeCloseTo(0.2, 6);
    expect(q[1]).toBeCloseTo(0.3, 6);
    expect(q[2]).toBeCloseTo(0.4, 6);
    expect(q[3]).toBeCloseTo(0.1, 6);
  });

  it('leaves quatXYZW null for a pos-only replay', () => {
    const r = parseReplay(makeRaw({ count: 2 }));
    expect(sampleReplay(r, 0).quatXYZW).toBeNull();
  });
});

describe('scoring helpers', () => {
  const notes = [
    { t: 0.5, pad: 0, foot: 0, judgment: 'marvelous' as JudgmentName, hit_dt_ms: 1 },
    { t: 1.0, pad: 1, foot: 1, judgment: 'perfect' as JudgmentName, hit_dt_ms: -8 },
    { t: 1.5, pad: 2, foot: 0, judgment: 'miss' as JudgmentName, hit_dt_ms: null },
    { t: 2.0, pad: 3, foot: 1, judgment: 'great' as JudgmentName, hit_dt_ms: 20 },
  ];
  const r = parseReplay(makeRaw({ count: 2, notes }));

  it('EX% counts only notes up to now', () => {
    expect(exPercentAt(r.chart.notes, 0)).toBe(100); // nothing judged yet
    // after 2 notes: (3+2)/(3+3) = 83.33%
    expect(exPercentAt(r.chart.notes, 1.0)).toBeCloseTo((5 / 6) * 100, 4);
    // all four: (3+2+0+1)/12
    expect(exPercentAt(r.chart.notes, 3.0)).toBeCloseTo((6 / 12) * 100, 4);
  });

  it('combo breaks on miss and rebuilds', () => {
    expect(comboAt(r.chart.notes, 1.0)).toBe(2); // marv, perfect
    expect(comboAt(r.chart.notes, 1.5)).toBe(0); // miss breaks
    expect(comboAt(r.chart.notes, 2.0)).toBe(1); // great after miss
  });
});

describe('replayDuration', () => {
  it('uses pose length and extends past the last note', () => {
    const r = parseReplay(
      makeRaw({
        count: 31, // 30 intervals @ 30fps = 1.0 s of pose
        notes: [{ t: 2.0, pad: 0, foot: 0, judgment: 'marvelous', hit_dt_ms: 0 }],
      }),
    );
    // last note 2.0 + 0.5 tail dominates the 1.0 s pose length
    expect(replayDuration(r)).toBeCloseTo(2.5, 6);
  });
});
