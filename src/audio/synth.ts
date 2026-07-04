/**
 * Procedural click track. The bundled example has no audio file, so we
 * synthesize a metronome from the chart's beat times: a short decaying blip on
 * each beat, accented on downbeats. Gives you rhythm to play against and a real
 * AudioBuffer for the clock to drive.
 */

export interface Click {
  /** Time in seconds. */
  time: number;
  /** Higher pitch / louder for downbeats. */
  accent: boolean;
}

export function makeClickTrack(
  ctx: BaseAudioContext,
  clicks: Click[],
  durationSeconds: number,
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.ceil(durationSeconds * sampleRate));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  const blipSeconds = 0.05;
  for (const { time, accent } of clicks) {
    const start = Math.floor(time * sampleRate);
    if (start < 0 || start >= length) continue;
    const freq = accent ? 1320 : 880;
    const amp = accent ? 0.5 : 0.32;
    const n = Math.floor(blipSeconds * sampleRate);
    for (let i = 0; i < n && start + i < length; i++) {
      const env = Math.exp((-5 * i) / n); // fast exponential decay
      data[start + i] += Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp * env;
    }
  }
  return buffer;
}
