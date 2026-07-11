import { describe, expect, it } from 'vitest';
import {
  MAX_GHOST_FRAMES,
  MAX_NOTE_DATA_CHARS,
  MAX_REPLAY_EVENTS,
  parseChartData,
  parseChartRef,
  parseGhost,
  parsePlayResult,
  parseReplay,
  parseSubmitInput,
  parseSubmitScoreRequest,
  rateKey,
  PROTOCOL_VERSION,
  type ChartData,
  type GhostFrame,
  type ReplayEvent,
  type SubmitScoreRequest,
} from '../src/net/protocol';
import { hashChartContent } from '../src/song/chartHash';
import { reconstructTiming } from '../src/gameplay/replayVerify';

/** A plausible pad replay: enough presses to cover any test combo, spanning
 *  well past the server's minimum duration. */
export function sampleReplay(n = 120): ReplayEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    t: Math.round(i * 0.1 * 1e4) / 1e4,
    track: i % 4,
    up: false,
  }));
}

// ---- shared re-simulatable fixture chart --------------------------------------
// A 4-measure quarter-note stream on lane 0 (16 taps at 120 BPM: beat b at b/2
// seconds). The server now RE-SIMULATES the submitted replay against the
// submitted chartData and ranks on what it produces, so the API tests need a
// real chart, a replay that actually scores, and a chartHash the chart hashes
// to. Mirrors tests/replayVerify.test.ts.
export const FIXTURE_STEPS_TYPE = 'dance-single';
export const FIXTURE_NOTE_GRID = Array.from({ length: 4 }, () => '1000\n1000\n1000\n1000').join(
  '\n,\n',
);
/** The 16 note times (seconds), one quarter note per beat at 120 BPM. */
export const FIXTURE_NOTE_TIMES = Array.from({ length: 16 }, (_, i) => i * 0.5);

export function fixtureChartData(): ChartData {
  return {
    stepsType: FIXTURE_STEPS_TYPE,
    noteData: FIXTURE_NOTE_GRID,
    timing: { offset: 0, bpms: [{ row: 0, bps: 2 }], stops: [], delays: [], warps: [], fakes: [] },
  };
}

/** The content hash the client keys a submission on — recomputed the SAME way
 *  the server does (so a submission with this chartData verifies). */
export const FIXTURE_CHART_HASH = hashChartContent(
  FIXTURE_STEPS_TYPE,
  FIXTURE_NOTE_GRID,
  reconstructTiming(fixtureChartData().timing),
);

/** A replay pressing the given note indices (0..15), each released 50 ms later,
 *  time-sorted. Pressing at the exact note time scores W1 (an `offset` shifts
 *  the hit into a worse window). */
export function fixtureReplay(indices: number[], offset = 0): ReplayEvent[] {
  const ev: ReplayEvent[] = [];
  for (const i of indices) {
    const t = Math.round((FIXTURE_NOTE_TIMES[i] + offset) * 1e4) / 1e4;
    ev.push({ t, track: 0, up: false });
    ev.push({ t: Math.round((t + 0.05) * 1e4) / 1e4, track: 0, up: true });
  }
  return ev.sort((a, b) => a.t - b.t);
}

/** Hits every note perfectly — re-sims to 100% / AAA / 16 combo. */
export function perfectReplay(): ReplayEvent[] {
  return fixtureReplay([...Array(16).keys()]);
}

/** Hits `count` notes evenly spread across the stream (always including the
 *  first and last, so the span always clears the server's minimum) — a partial
 *  play that re-sims strictly below a perfect one. */
export function spreadReplay(count: number): ReplayEvent[] {
  const idx = new Set<number>();
  for (let k = 0; k < count; k++) idx.add(Math.round((k * 15) / (count - 1)));
  return fixtureReplay([...idx]);
}

/** A well-formed submission the tests then break one field at a time. The chart
 *  + replay re-simulate to a real 100% on the fixture board. */
export function validSubmit(): SubmitScoreRequest {
  return {
    protocol: PROTOCOL_VERSION,
    playerId: 'player-1',
    secret: 'secret-1',
    playerName: 'PLAYER',
    chart: {
      chartHash: FIXTURE_CHART_HASH,
      title: 'Song',
      artist: 'Artist',
      stepsType: 'dance-single',
      difficulty: 3,
      meter: 9,
    },
    musicRate: 1,
    result: {
      percent: 0.95,
      grade: 'AA',
      maxCombo: 100,
      failed: false,
      counts: { 9: 80, 8: 15, 4: 5 },
      holdCounts: { 6: 10 },
    },
    input: { device: 'pad', padId: 'pad-1', padKnown: false },
    chartData: fixtureChartData(),
    replay: perfectReplay(),
  };
}

describe('rateKey', () => {
  it('partitions boards on integer percent', () => {
    expect(rateKey(1)).toBe(100);
    expect(rateKey(1.5)).toBe(150);
    expect(rateKey(1.1)).toBe(110);
    expect(rateKey(0.75)).toBe(75);
  });
});

describe('parseSubmitScoreRequest', () => {
  it('accepts a well-formed submission and echoes it back', () => {
    const sub = validSubmit();
    expect(parseSubmitScoreRequest(JSON.parse(JSON.stringify(sub)))).toEqual(sub);
  });

  it('pins the current protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(validSubmit().protocol).toBe(3);
  });

  it('rejects non-objects and wrong protocol versions', () => {
    expect(parseSubmitScoreRequest(null)).toBeNull();
    expect(parseSubmitScoreRequest('hi')).toBeNull();
    // Only the current version parses; older submissions no longer do — old
    // queued plays are dropped on load rather than accepted without v3 evidence.
    expect(parseSubmitScoreRequest({ ...validSubmit(), protocol: 1 })).toBeNull();
    expect(parseSubmitScoreRequest({ ...validSubmit(), protocol: 2 })).toBeNull();
  });

  it('requires a pad input, a chart, and a replay (anti-cheat, v3)', () => {
    const noInput = { ...validSubmit() } as Record<string, unknown>;
    delete noInput.input;
    expect(parseSubmitScoreRequest(noInput)).toBeNull();
    const noReplay = { ...validSubmit() } as Record<string, unknown>;
    delete noReplay.replay;
    expect(parseSubmitScoreRequest(noReplay)).toBeNull();
    // The chart itself is required in v3 (the server re-simulates against it).
    const noChartData = { ...validSubmit() } as Record<string, unknown>;
    delete noChartData.chartData;
    expect(parseSubmitScoreRequest(noChartData)).toBeNull();
    // Only a pad is accepted — a keyboard device is rejected outright.
    expect(
      parseSubmitScoreRequest({
        ...validSubmit(),
        input: { device: 'keyboard', padId: 'kb', padKnown: false },
      }),
    ).toBeNull();
    // A malformed replay or chartData rejects the whole submission.
    expect(parseSubmitScoreRequest({ ...validSubmit(), replay: 'nope' })).toBeNull();
    expect(parseSubmitScoreRequest({ ...validSubmit(), chartData: 'nope' })).toBeNull();
  });

  it('rejects missing/oversized identity fields', () => {
    expect(parseSubmitScoreRequest({ ...validSubmit(), secret: '' })).toBeNull();
    expect(parseSubmitScoreRequest({ ...validSubmit(), playerId: 'x'.repeat(65) })).toBeNull();
    expect(parseSubmitScoreRequest({ ...validSubmit(), playerName: 'x'.repeat(25) })).toBeNull();
  });

  it('rejects out-of-range rates', () => {
    expect(parseSubmitScoreRequest({ ...validSubmit(), musicRate: 0.1 })).toBeNull();
    expect(parseSubmitScoreRequest({ ...validSubmit(), musicRate: 5 })).toBeNull();
    expect(parseSubmitScoreRequest({ ...validSubmit(), musicRate: NaN })).toBeNull();
  });

  it('rejects implausible results', () => {
    const bad = (result: object) =>
      parseSubmitScoreRequest({ ...validSubmit(), result: { ...validSubmit().result, ...result } });
    expect(bad({ percent: 1.2 })).toBeNull();
    expect(bad({ percent: -0.1 })).toBeNull();
    expect(bad({ maxCombo: -1 })).toBeNull();
    // A combo can't exceed the number of judged steps (100 judged above).
    expect(bad({ maxCombo: 101 })).toBeNull();
    expect(bad({ counts: { 9: -1 } })).toBeNull();
    expect(bad({ counts: { 9: 1.5 } })).toBeNull();
    expect(bad({ counts: { 999: 1 } })).toBeNull();
    expect(bad({ counts: { 9: 1e9 } })).toBeNull();
    expect(bad({ failed: 'no' })).toBeNull();
  });
});

describe('parseGhost', () => {
  const frame = (atSong: number, percent = 0.5): GhostFrame => ({
    atSong,
    percent,
    combo: 10,
    life: 0.8,
  });

  it('accepts a monotonic timeline and rides along on a submission', () => {
    const ghost = [frame(0), frame(0.5), frame(1)];
    expect(parseGhost(ghost)).toEqual(ghost);
    const sub = parseSubmitScoreRequest({ ...validSubmit(), ghost });
    expect(sub?.ghost).toEqual(ghost);
  });

  it('a submission without a ghost stays ghostless', () => {
    expect(parseSubmitScoreRequest(validSubmit())?.ghost).toBeUndefined();
  });

  it('rejects non-monotonic, oversized, and out-of-range timelines', () => {
    expect(parseGhost([frame(1), frame(0.5)])).toBeNull();
    expect(parseGhost(Array.from({ length: MAX_GHOST_FRAMES + 1 }, (_, i) => frame(i)))).toBeNull();
    expect(parseGhost([frame(0, 1.5)])).toBeNull();
    expect(parseGhost([{ ...frame(0), life: 2 }])).toBeNull();
    expect(parseGhost([{ ...frame(0), combo: 1.5 }])).toBeNull();
    expect(parseGhost('nope')).toBeNull();
  });

  it('a malformed ghost rejects the whole submission', () => {
    expect(parseSubmitScoreRequest({ ...validSubmit(), ghost: [frame(1), frame(0)] })).toBeNull();
  });
});

describe('parseReplay', () => {
  const ev = (t: number, track = 0, up = false): ReplayEvent => ({ t, track, up });

  it('accepts a time-ordered log and echoes it', () => {
    const replay = [ev(0), ev(0.5, 1, true), ev(1, 2)];
    expect(parseReplay(replay)).toEqual(replay);
  });

  it('rejects out-of-order, oversized, and out-of-range events', () => {
    expect(parseReplay([ev(1), ev(0.5)])).toBeNull(); // t must not decrease
    expect(parseReplay(Array.from({ length: MAX_REPLAY_EVENTS + 1 }, (_, i) => ev(i)))).toBeNull();
    expect(parseReplay([ev(-100)])).toBeNull();
    expect(parseReplay([{ t: 0, track: 16, up: false }])).toBeNull();
    expect(parseReplay([{ t: 0, track: 1.5, up: false }])).toBeNull();
    expect(parseReplay([{ t: 0, track: 0, up: 'no' }])).toBeNull();
    expect(parseReplay('nope')).toBeNull();
  });
});

describe('parseSubmitInput', () => {
  it('accepts only a pad device', () => {
    expect(parseSubmitInput({ device: 'pad', padId: 'x', padKnown: true })).toEqual({
      device: 'pad',
      padId: 'x',
      padKnown: true,
    });
    expect(parseSubmitInput({ device: 'keyboard', padId: 'x', padKnown: false })).toBeNull();
    expect(parseSubmitInput({ device: 'pad', padId: '', padKnown: false })).toBeNull();
    expect(parseSubmitInput({ device: 'pad', padId: 'x'.repeat(129), padKnown: false })).toBeNull();
    expect(parseSubmitInput({ device: 'pad', padId: 'x' })).toBeNull();
  });
});

describe('parseChartData', () => {
  it('accepts a well-formed chart payload and echoes it back', () => {
    const cd = fixtureChartData();
    expect(parseChartData(JSON.parse(JSON.stringify(cd)))).toEqual(cd);
  });

  it('rejects a non-object or a missing timing block', () => {
    expect(parseChartData(null)).toBeNull();
    expect(parseChartData('nope')).toBeNull();
    const noTiming = { ...fixtureChartData() } as Record<string, unknown>;
    delete noTiming.timing;
    expect(parseChartData(noTiming)).toBeNull();
  });

  it('rejects a non-string or over-long note grid', () => {
    expect(parseChartData({ ...fixtureChartData(), noteData: 1234 })).toBeNull();
    expect(
      parseChartData({ ...fixtureChartData(), noteData: 'x'.repeat(MAX_NOTE_DATA_CHARS + 1) }),
    ).toBeNull();
  });

  it('rejects a malformed timing segment', () => {
    const withTiming = (timing: object) =>
      parseChartData({
        ...fixtureChartData(),
        timing: { ...fixtureChartData().timing, ...timing },
      });
    // A segment row must be a non-negative integer.
    expect(withTiming({ bpms: [{ row: -1, bps: 2 }] })).toBeNull();
    expect(withTiming({ bpms: [{ row: 1.5, bps: 2 }] })).toBeNull();
    // The segment value (here bps) must be finite.
    expect(withTiming({ bpms: [{ row: 0, bps: Infinity }] })).toBeNull();
    expect(withTiming({ bpms: [{ row: 0, bps: 'fast' }] })).toBeNull();
    // A missing offset sinks the whole timing block.
    const noOffset = { ...fixtureChartData().timing } as Record<string, unknown>;
    delete noOffset.offset;
    expect(parseChartData({ ...fixtureChartData(), timing: noOffset })).toBeNull();
  });
});

describe('parseChartRef / parsePlayResult', () => {
  it('requires a hash and sane meter, allows an empty artist', () => {
    const chart = validSubmit().chart;
    expect(parseChartRef(chart)).toEqual(chart);
    expect(parseChartRef({ ...chart, chartHash: '' })).toBeNull();
    expect(parseChartRef({ ...chart, meter: -1 })).toBeNull();
    expect(parseChartRef({ ...chart, meter: 3.5 })).toBeNull();
    expect(parseChartRef({ ...chart, artist: '' })).not.toBeNull();
  });

  it('normalizes count maps to plain numeric records', () => {
    const r = parsePlayResult({ ...validSubmit().result, counts: { '9': 3 } });
    expect(r?.counts).toEqual({ 9: 3 });
  });
});
