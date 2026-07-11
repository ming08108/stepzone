import { describe, expect, it } from 'vitest';
import {
  MAX_GHOST_FRAMES,
  parseChartRef,
  parseGhost,
  parsePlayResult,
  parseSubmitScoreRequest,
  rateKey,
  PROTOCOL_VERSION,
  type GhostFrame,
  type SubmitScoreRequest,
} from '../src/net/protocol';

/** A well-formed submission the tests then break one field at a time. */
export function validSubmit(): SubmitScoreRequest {
  return {
    protocol: PROTOCOL_VERSION,
    playerId: 'player-1',
    secret: 'secret-1',
    playerName: 'PLAYER',
    chart: {
      chartHash: 'abc123',
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

  it('rejects non-objects and wrong protocol versions', () => {
    expect(parseSubmitScoreRequest(null)).toBeNull();
    expect(parseSubmitScoreRequest('hi')).toBeNull();
    expect(parseSubmitScoreRequest({ ...validSubmit(), protocol: 2 })).toBeNull();
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
