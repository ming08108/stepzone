/**
 * The WSOLA time-stretch feeds gameplay audio at MUSIC RATE ≠ 1 — pin the two
 * properties that matter: pitch stays put (the whole point) and the time
 * mapping songSeconds = bufferSeconds·rate holds (the judge depends on it).
 */
import { describe, expect, it } from 'vitest';
import { stretchChannels } from '../src/audio/timeStretch';

const SR = 44100;

function sine(freq: number, seconds: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

/** Dominant frequency of a window via zero-crossing count. */
function zeroCrossFreq(data: Float32Array, from: number, seconds: number): number {
  const n = Math.round(seconds * SR);
  let crossings = 0;
  for (let i = from + 1; i < from + n; i++) {
    if ((data[i - 1] < 0 && data[i] >= 0) || (data[i - 1] >= 0 && data[i] < 0)) crossings++;
  }
  return crossings / 2 / seconds;
}

describe('stretchChannels', () => {
  it('rate 1 is the identity', () => {
    const ch = sine(440, 0.5);
    const [out] = stretchChannels([ch], SR, 1);
    expect(out).toBe(ch);
  });

  it('changes duration by 1/rate', () => {
    const ch = sine(440, 3);
    for (const rate of [0.8, 1.25, 1.5]) {
      const [out] = stretchChannels([ch], SR, rate);
      expect(out.length).toBeGreaterThan((ch.length / rate) * 0.98);
      expect(out.length).toBeLessThan((ch.length / rate) * 1.02 + SR * 0.05);
    }
  });

  it('preserves pitch where resampling would shift it', () => {
    const ch = sine(440, 3);
    for (const rate of [0.8, 1.5]) {
      const [out] = stretchChannels([ch], SR, rate);
      // Measure well inside the output, away from the primed head and the tail.
      const f = zeroCrossFreq(out, Math.floor(out.length / 3), 0.5);
      expect(f).toBeGreaterThan(425); // resampled would read 440·rate (352/660)
      expect(f).toBeLessThan(455);
    }
  });

  it('keeps events at songSeconds = bufferSeconds·rate for the judge', () => {
    // A 30 ms burst centred at input 1.5 s in silence; after a 1.25× stretch it
    // must sit near output 1.5/1.25 s — bounded by the ±10 ms seek window.
    const rate = 1.25;
    const ch = new Float32Array(3 * SR);
    const center = Math.round(1.5 * SR);
    for (let i = -660; i < 660; i++) ch[center + i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.9;
    const [out] = stretchChannels([ch], SR, rate);

    let peakAt = 0;
    let peak = 0;
    // 10 ms energy windows across the output.
    const win = Math.round(0.01 * SR);
    for (let w = 0; w + win < out.length; w += win) {
      let e = 0;
      for (let i = w; i < w + win; i++) e += out[i] * out[i];
      if (e > peak) {
        peak = e;
        peakAt = w + win / 2;
      }
    }
    const expected = center / rate;
    expect(Math.abs(peakAt - expected)).toBeLessThan(0.03 * SR);
  });

  it('keeps stereo channels phase-aligned', () => {
    const l = sine(440, 2);
    const r = sine(440, 2);
    const [ol, or] = stretchChannels([l, r], SR, 1.3);
    expect(ol.length).toBe(or.length);
    for (let i = 0; i < ol.length; i += 997) expect(ol[i]).toBeCloseTo(or[i], 6);
  });
});
