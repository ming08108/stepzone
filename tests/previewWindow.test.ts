import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREVIEW_LENGTH_SECONDS,
  FALLBACK_PREVIEW_TAIL_SECONDS,
  MIN_PREVIEW_LENGTH_SECONDS,
  previewWindow,
} from '../src/audio/previewWindow';

describe('previewWindow (song-preview loop selection)', () => {
  it('uses the song sample hints verbatim when they fit the buffer', () => {
    const w = previewWindow(120, 30, 12);
    expect(w.startSeconds).toBe(30);
    expect(w.lengthSeconds).toBe(12);
  });

  it('falls back to ~30% in when the start hint is missing (SM default -1)', () => {
    const w = previewWindow(100, -1, 12);
    // min(100 * 0.3, 100 - 15) = 30
    expect(w.startSeconds).toBeCloseTo(30, 6);
    expect(w.lengthSeconds).toBe(12);
  });

  it('falls back when the start hint is NaN or inside the last second', () => {
    expect(previewWindow(100, Number.NaN, 12).startSeconds).toBeCloseTo(30, 6);
    expect(previewWindow(100, 99.5, 12).startSeconds).toBeCloseTo(30, 6);
  });

  it('caps the fallback start so at least the tail window remains for long songs', () => {
    const w = previewWindow(300, -1, 12);
    // min(300 * 0.3 = 90, 300 - FALLBACK_PREVIEW_TAIL_SECONDS = 285) = 90
    expect(w.startSeconds).toBeCloseTo(90, 6);
    expect(300 - w.startSeconds).toBeGreaterThanOrEqual(FALLBACK_PREVIEW_TAIL_SECONDS);
  });

  it('never places the fallback start before 0 on very short buffers', () => {
    const w = previewWindow(10, -1, 12);
    // min(10 * 0.3 = 3, max(0, 10 - 15) = 0) = 0.
    expect(w.startSeconds).toBe(0);
  });

  it('defaults a zero/missing length to the standard preview length', () => {
    expect(previewWindow(120, 30, 0).lengthSeconds).toBe(DEFAULT_PREVIEW_LENGTH_SECONDS);
    expect(previewWindow(120, 30, Number.NaN).lengthSeconds).toBe(DEFAULT_PREVIEW_LENGTH_SECONDS);
  });

  it('clamps the length to what remains after the start', () => {
    const w = previewWindow(40, 35, 12);
    // start 35 is within duration - 1, so it is kept; only 5s remain.
    expect(w.startSeconds).toBe(35);
    expect(w.lengthSeconds).toBe(5);
  });

  it('never loops shorter than the minimum length', () => {
    const w = previewWindow(100, 99, 12);
    // 99 <= duration - 1, so the hint survives; remaining 1s is raised to the floor.
    expect(w.startSeconds).toBe(99);
    expect(w.lengthSeconds).toBe(MIN_PREVIEW_LENGTH_SECONDS);
  });
});
