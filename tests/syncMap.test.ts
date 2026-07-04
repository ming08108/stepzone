import { describe, expect, it } from 'vitest';
import { SyncMap } from '../src/audio/syncMap';

describe('SyncMap (low-latency clock mapping, spec doc 6)', () => {
  it('maps performance timestamps to song seconds via the anchor', () => {
    const m = new SyncMap();
    m.startContextTime = 5; // song-second 0 begins at context time 5s
    m.setAnchor(6, 1000); // context time 6s is heard at perf 1000ms

    // At perf 1000ms we hear context 6s -> song 1.0s.
    expect(m.songSecondsAtPerf(1000)).toBeCloseTo(1, 6);
    // 100ms later we hear context 6.1s -> song 1.1s.
    expect(m.songSecondsAtPerf(1100)).toBeCloseTo(1.1, 6);
    // 50ms earlier (e.g. an input event slightly in the past).
    expect(m.songSecondsAtPerf(950)).toBeCloseTo(0.95, 6);
  });

  it('applies playback rate', () => {
    const m = new SyncMap();
    m.startContextTime = 5;
    m.playbackRate = 1.5;
    m.setAnchor(6, 1000);
    expect(m.songSecondsAtPerf(1100)).toBeCloseTo((6.1 - 5) * 1.5, 6);
  });

  it('applies the calibration offset', () => {
    const m = new SyncMap();
    m.startContextTime = 5;
    m.audioOffsetSeconds = 0.02;
    m.setAnchor(6, 1000);
    expect(m.songSecondsAtPerf(1000)).toBeCloseTo(1 + 0.02, 6);
  });

  it('returns just the offset before any anchor is set', () => {
    const m = new SyncMap();
    m.audioOffsetSeconds = 0.03;
    expect(m.ready).toBe(false);
    expect(m.songSecondsAtPerf(1234)).toBeCloseTo(0.03, 6);
  });
});
