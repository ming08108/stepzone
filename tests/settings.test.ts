import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/app/settings';

describe('normalizeSettings (todo #15)', () => {
  it('clamps out-of-range values', () => {
    const s = normalizeSettings({
      ...DEFAULT_SETTINGS,
      musicRate: 99,
      audioOffsetMs: 9999,
      visualOffsetMs: -9999,
      scrollMode: 'C',
      scrollValue: 1e9,
    });
    expect(s.musicRate).toBeLessThanOrEqual(2);
    expect(s.audioOffsetMs).toBeLessThanOrEqual(300);
    expect(s.visualOffsetMs).toBeGreaterThanOrEqual(-300);
    expect(s.scrollValue).toBeLessThanOrEqual(2000);
  });

  it('falls back to a default for NaN', () => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, musicRate: NaN }).musicRate).toBe(1);
  });

  it('uses the X-mod range when scrollMode is X', () => {
    const s = normalizeSettings({ ...DEFAULT_SETTINGS, scrollMode: 'X', scrollValue: 50 });
    expect(s.scrollValue).toBeLessThanOrEqual(8);
  });
});
