/**
 * Deterministic chiptune-style track renderer for the bundled starter songs.
 * Pure math — no Web Audio, no randomness, no clock — so it runs identically
 * in the browser (lazily, on first play/preview) and in Node tests. Output is
 * a 16-bit PCM WAV ArrayBuffer that decodeAudioData accepts everywhere.
 *
 * Everything (music AND charts) is authored on the same beat grid at a fixed
 * BPM with the first beat at t=0, so audio and steps stay in sync by
 * construction.
 */

export interface VoiceNote {
  /** Start, in beats from song start. */
  b: number;
  /** Length in beats. */
  d: number;
  /** MIDI note number (69 = A4 = 440 Hz). */
  midi: number;
  /** Velocity 0..1 (default 1). */
  v?: number;
}

export type DrumKind = 'kick' | 'snare' | 'hat' | 'ohat' | 'crash';

export interface DrumHit {
  b: number;
  kind: DrumKind;
  v?: number;
}

export interface TrackSpec {
  bpm: number;
  /** Total song length in beats (rendering adds a short release tail). */
  beats: number;
  /** Pulse-wave lead (slight detune + vibrato). */
  lead: VoiceNote[];
  /** Triangle bass. */
  bass: VoiceNote[];
  /** Narrow-pulse arpeggio layer (quiet). */
  arp?: VoiceNote[];
  drums: DrumHit[];
}

const SAMPLE_RATE = 44100;
const TAIL_SECONDS = 1.5;

function midiHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Deterministic white-ish noise: xorshift32, same stream every render. */
function makeNoise(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff) * 2 - 1;
  };
}

function polyBlepSquare(phase: number, duty: number): number {
  // Naive pulse is fine at chip-lead frequencies; keep it simple and cheap.
  return (phase % 1 < duty ? 1 : -1) * 0.5;
}

function triangle(phase: number): number {
  const p = phase % 1;
  return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
}

interface RenderVoice {
  notes: VoiceNote[];
  gain: number;
  duty: number; // 0 = triangle, else pulse duty
  detuneCents: number;
  vibrato: boolean;
  attack: number;
  release: number;
}

function renderVoice(out: Float32Array, spb: number, voice: RenderVoice): void {
  const { notes, gain, duty, detuneCents, vibrato, attack, release } = voice;
  for (const n of notes) {
    const t0 = n.b * spb;
    const dur = n.d * spb;
    const vel = (n.v ?? 1) * gain;
    const hz = midiHz(n.midi);
    const hz2 = hz * Math.pow(2, detuneCents / 1200);
    const start = Math.floor(t0 * SAMPLE_RATE);
    const nSamples = Math.floor((dur + release) * SAMPLE_RATE);
    let phase = 0;
    let phase2 = 0;
    for (let i = 0; i < nSamples; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= out.length) break;
      const t = i / SAMPLE_RATE;
      // ADSR-lite: linear attack, sustain, linear release after note end.
      let env = 1;
      if (t < attack) env = t / attack;
      else if (t > dur) env = Math.max(0, 1 - (t - dur) / release);
      // Gentle vibrato that settles in after the onset.
      const vib = vibrato && t > 0.12 ? Math.sin(2 * Math.PI * 5.5 * t) * 0.004 : 0;
      const f = hz * (1 + vib);
      phase += f / SAMPLE_RATE;
      phase2 += hz2 / SAMPLE_RATE;
      const s =
        duty === 0
          ? triangle(phase) * 0.9
          : polyBlepSquare(phase, duty) + polyBlepSquare(phase2, duty) * 0.6;
      out[idx] += s * env * vel;
    }
  }
}

function renderDrums(out: Float32Array, spb: number, drums: DrumHit[]): void {
  const noise = makeNoise(0x5eed);
  // Pre-render one second of noise; every hit reads the same table so the
  // output is deterministic regardless of hit order.
  const table = new Float32Array(SAMPLE_RATE);
  for (let i = 0; i < table.length; i++) table[i] = noise();

  for (const h of drums) {
    const start = Math.floor(h.b * spb * SAMPLE_RATE);
    const vel = h.v ?? 1;
    if (h.kind === 'kick') {
      const len = Math.floor(0.22 * SAMPLE_RATE);
      let phase = 0;
      for (let i = 0; i < len; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= out.length) break;
        const t = i / SAMPLE_RATE;
        const f = 42 + 110 * Math.exp(-t / 0.045); // pitch sweep 152→42 Hz
        phase += f / SAMPLE_RATE;
        const env = Math.exp(-t / 0.07);
        out[idx] += Math.sin(2 * Math.PI * phase) * env * 0.95 * vel;
      }
    } else if (h.kind === 'snare') {
      const len = Math.floor(0.18 * SAMPLE_RATE);
      let phase = 0;
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= out.length) break;
        const t = i / SAMPLE_RATE;
        phase += 185 / SAMPLE_RATE;
        const body = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.04) * 0.5;
        // Crude band-pass: difference of the raw and low-passed noise.
        const raw = table[i % table.length];
        lp += (raw - lp) * 0.25;
        const crack = (raw - lp) * Math.exp(-t / 0.06);
        out[idx] += (body + crack * 0.9) * 0.7 * vel;
      }
    } else {
      // hat / open hat / crash: shaped noise, high-passed by differencing.
      const dur = h.kind === 'hat' ? 0.045 : h.kind === 'ohat' ? 0.22 : 1.1;
      const amp = h.kind === 'crash' ? 0.4 : 0.22;
      const len = Math.floor(dur * SAMPLE_RATE);
      let prev = 0;
      for (let i = 0; i < len; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= out.length) break;
        const t = i / SAMPLE_RATE;
        const raw = table[(i * 7 + 13) % table.length];
        const hp = raw - prev;
        prev = raw;
        out[idx] += hp * Math.exp(-t / (dur / 3.5)) * amp * vel;
      }
    }
  }
}

/** Render a spec to mono float samples at 44.1 kHz (soft-clipped, |s| < 1). */
export function renderSamples(spec: TrackSpec): Float32Array {
  const spb = 60 / spec.bpm; // seconds per beat
  const total = Math.ceil((spec.beats * spb + TAIL_SECONDS) * SAMPLE_RATE);
  const out = new Float32Array(total);

  renderVoice(out, spb, {
    notes: spec.lead,
    gain: 0.24,
    duty: 0.28,
    detuneCents: 8,
    vibrato: true,
    attack: 0.006,
    release: 0.06,
  });
  renderVoice(out, spb, {
    notes: spec.bass,
    gain: 0.42,
    duty: 0,
    detuneCents: 0,
    vibrato: false,
    attack: 0.004,
    release: 0.05,
  });
  if (spec.arp) {
    renderVoice(out, spb, {
      notes: spec.arp,
      gain: 0.1,
      duty: 0.125,
      detuneCents: -6,
      vibrato: false,
      attack: 0.002,
      release: 0.03,
    });
  }
  renderDrums(out, spb, spec.drums);

  // Soft clip so stacked voices can't wrap; tanh keeps transients punchy.
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * 1.1) * 0.92;
  return out;
}

/** Wrap mono float samples as a 16-bit PCM WAV file. */
export function samplesToWav(samples: Float32Array): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true); // PCM chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, SAMPLE_RATE, true);
  dv.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits
  str(36, 'data');
  dv.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return buf;
}

/** Render a full track to WAV bytes (the LibraryEntry synthAudio payload). */
export function renderTrackWav(spec: TrackSpec): ArrayBuffer {
  return samplesToWav(renderSamples(spec));
}
