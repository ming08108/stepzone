/**
 * Server-side replay verification — the leaderboard's real anti-cheat. Proves
 * the re-simulation (a) reproduces the score of a genuinely-played replay,
 * (b) IGNORES the client's self-reported result and ranks on what the inputs
 * actually produce, and (c) rejects a chart that doesn't hash to its board.
 */
import { describe, expect, it } from 'vitest';
import { hashChartContent } from '../src/song/chartHash';
import { parseNoteGrid } from '../src/notes/noteGrid';
import { noteRowToBeat } from '../src/notes/noteTypes';
import { TimingData } from '../src/timing/timingData';
import type { ChartData, ReplayEvent } from '../src/net/protocol';
import { verifyReplay, reconstructTiming } from '../src/gameplay/replayVerify';

/** A 4-measure quarter-note stream on lane 0 (16 taps), one tap per row. */
const NOTE_GRID = Array.from({ length: 4 }, () => '1000\n1000\n1000\n1000').join('\n,\n');
const STEPS_TYPE = 'dance-single';

/** 120 BPM: beat b is at b/2 seconds; beat 0 at time 0. */
function timing120(): TimingData {
  const t = new TimingData();
  t.bpms.push({ row: 0, bps: 2 });
  t.tidy();
  return t;
}

function chartData(): ChartData {
  const t = timing120();
  return {
    stepsType: STEPS_TYPE,
    noteData: NOTE_GRID,
    timing: {
      offset: t.offsetSeconds,
      bpms: [{ row: 0, bps: 2 }],
      stops: [],
      delays: [],
      warps: [],
      fakes: [],
    },
  };
}

/** The content hash the client would key the submission on. */
function boardHash(cd: ChartData): string {
  return hashChartContent(cd.stepsType, cd.noteData, reconstructTiming(cd.timing));
}

/** A replay that perfectly hits every lane-0 note: a press on each note time,
 *  released a moment later. Built from the chart's own timing. */
function perfectReplay(): ReplayEvent[] {
  const timing = timing120();
  const nd = parseNoteGrid(NOTE_GRID, 4, []);
  const events: ReplayEvent[] = [];
  for (const { row } of nd.getTrack(0)) {
    const t = timing.getElapsedTimeFromBeat(noteRowToBeat(row));
    events.push({ t: Math.round(t * 1e4) / 1e4, track: 0, up: false });
    events.push({ t: Math.round((t + 0.05) * 1e4) / 1e4, track: 0, up: true });
  }
  return events;
}

describe('verifyReplay', () => {
  it('reproduces a perfectly-played replay (100% / AAA)', () => {
    const cd = chartData();
    const out = verifyReplay(cd, boardHash(cd), perfectReplay(), 1);
    expect('result' in out).toBe(true);
    if ('result' in out) {
      expect(out.result.percent).toBeCloseTo(1, 5);
      expect(out.result.grade).toBe('AAA');
      expect(out.result.maxCombo).toBe(16);
      expect(out.result.failed).toBe(false);
    }
  });

  it('IGNORES the forged claim — an empty replay scores as a total miss', () => {
    const cd = chartData();
    const out = verifyReplay(cd, boardHash(cd), [], 1);
    expect('result' in out).toBe(true);
    if ('result' in out) {
      // Every note missed -> 0% and a fail, regardless of any claimed result.
      expect(out.result.percent).toBe(0);
      expect(out.result.maxCombo).toBe(0);
      expect(out.result.grade).toBe('F');
    }
  });

  it('a partial replay scores below a full one (monotonic in real hits)', () => {
    const cd = chartData();
    const full = perfectReplay();
    const half = full.slice(0, full.length / 2); // hit only the first 8 notes
    const hash = boardHash(cd);
    const a = verifyReplay(cd, hash, full, 1);
    const b = verifyReplay(cd, hash, half, 1);
    if ('result' in a && 'result' in b) {
      expect(b.result.percent).toBeLessThan(a.result.percent);
      expect(b.result.maxCombo).toBeLessThan(a.result.maxCombo);
    } else {
      throw new Error('both should verify');
    }
  });

  it('rejects a chart that does not hash to the claimed board', () => {
    const cd = chartData();
    const out = verifyReplay(cd, 'deadbeefdeadbeef', perfectReplay(), 1);
    expect('reject' in out).toBe(true);
  });

  it('rejects a tampered chart whose notes were swapped for an easier grid', () => {
    const cd = chartData();
    const realHash = boardHash(cd);
    // Cheater strips the chart to a single tap but claims the real board.
    const tampered: ChartData = { ...cd, noteData: '1000\n0000\n0000\n0000' };
    const out = verifyReplay(tampered, realHash, [{ t: 0, track: 0, up: false }], 1);
    expect('reject' in out).toBe(true);
  });
});
