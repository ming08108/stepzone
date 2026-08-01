/**
 * WSOLA time-stretch (SoundTouch-style) — change tempo WITHOUT changing pitch.
 *
 * AudioBufferSourceNode.playbackRate resamples, so a 1.2× music rate also
 * pitches the song up ~3 semitones. Instead the clock pre-stretches the decoded
 * buffer by 1/rate once at load time and plays it at playbackRate 1: sequences
 * of the input are overlap-added at a different spacing, cross-faded at the
 * seam whose waveforms correlate best, which preserves the spectrum.
 *
 * Timing contract (this is a rhythm game): the OUTPUT position of every block
 * is exact — block k starts at output sample k·hop by construction, sourced
 * from input near k·hop·rate. The correlation search only shifts WHERE the
 * source window sits, within ±SEEK_MS, and that deviation is measured from the
 * nominal position each iteration, so it never accumulates. Audible content can
 * therefore be locally early/late by at most SEEK_MS (10 ms — inside the W2
 * window), and the global song↔wall mapping songSeconds = bufferSeconds·rate
 * stays sample-exact for the judge.
 *
 * Pure Float32Array math — no AudioContext — so it runs in a worker and in
 * Node tests.
 */

/** Length of each copied sequence. Longer = fewer seams but more "echo". */
const SEQUENCE_MS = 40;
/** Cross-fade length at each seam. */
const OVERLAP_MS = 8;
/** Correlation search half-window around the nominal input position. */
const SEEK_MS = 10;

/** Normalized cross-correlation of `ref` against `cand` over `n` samples. */
function corr(mono: Float32Array, ref: number, cand: number, n: number): number {
  let dot = 0;
  let norm = 0;
  for (let j = 0; j < n; j++) {
    const a = mono[ref + j];
    const b = mono[cand + j];
    dot += a * b;
    norm += b * b;
  }
  return dot / Math.sqrt(norm + 1e-9);
}

/**
 * Stretch every channel by 1/rate (rate 1.2 → 1.2× tempo, ~0.83× duration),
 * preserving pitch. Channels must share a length. Returns new arrays; the
 * inputs are not modified. rate 1 returns the inputs untouched.
 */
export function stretchChannels(
  channels: readonly Float32Array[],
  sampleRate: number,
  rate: number,
): Float32Array[] {
  if (rate === 1 || channels.length === 0 || channels[0].length === 0)
    return channels.map((c) => c);
  const inLen = channels[0].length;
  const overlap = Math.round((sampleRate * OVERLAP_MS) / 1000);
  const seq = Math.round((sampleRate * SEQUENCE_MS) / 1000);
  const seek = Math.round((sampleRate * SEEK_MS) / 1000);
  const hop = seq - overlap; // output samples advanced per iteration

  // The search runs on a mono mix once; the chosen offset applies to all
  // channels (they must stay phase-aligned with each other anyway).
  let mono: Float32Array;
  if (channels.length === 1) {
    mono = channels[0];
  } else {
    mono = new Float32Array(inLen);
    for (const ch of channels) for (let i = 0; i < inLen; i++) mono[i] += ch[i];
    const g = 1 / channels.length;
    for (let i = 0; i < inLen; i++) mono[i] *= g;
  }

  const outLen = Math.ceil(inLen / rate);
  const outs = channels.map(() => new Float32Array(outLen + seq));

  // Prime with the first sequence verbatim; its tail is the first seam's
  // cross-fade partner.
  const first = Math.min(seq, inLen);
  for (let c = 0; c < channels.length; c++) outs[c].set(channels[c].subarray(0, first), 0);
  let outPos = hop;
  // Input-space position of the audio now sitting at out[outPos..outPos+overlap)
  // — the correlation reference for the next seam.
  let ref = hop;

  for (let iter = 1; ; iter++) {
    const nominal = Math.round(iter * hop * rate);
    const lo = Math.max(0, nominal - seek);
    const hi = Math.min(inLen - seq, nominal + seek);
    if (hi <= lo || outPos + seq > outs[0].length) break;

    // Two-stage seek (SoundTouch's "quick seek"): coarse stride, then refine.
    let best = lo;
    let bestScore = -Infinity;
    for (let cand = lo; cand <= hi; cand += 8) {
      const s = corr(mono, ref, cand, overlap);
      if (s > bestScore) {
        bestScore = s;
        best = cand;
      }
    }
    const rLo = Math.max(lo, best - 7);
    const rHi = Math.min(hi, best + 7);
    for (let cand = rLo; cand <= rHi; cand++) {
      const s = corr(mono, ref, cand, overlap);
      if (s > bestScore) {
        bestScore = s;
        best = cand;
      }
    }

    for (let c = 0; c < channels.length; c++) {
      const inp = channels[c];
      const out = outs[c];
      for (let j = 0; j < overlap; j++) {
        const t = j / overlap;
        out[outPos + j] = out[outPos + j] * (1 - t) + inp[best + j] * t;
      }
      out.set(inp.subarray(best + overlap, best + seq), outPos + overlap);
    }
    outPos += hop;
    ref = best + hop;
  }

  return outs.map((o) => o.slice(0, Math.min(outLen, outPos + overlap)));
}
