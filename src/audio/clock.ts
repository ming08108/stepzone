/**
 * WebAudioClock — the browser glue around SyncMap. Browser-only: it references
 * AudioContext, so it is imported by the app, never by the engine barrel or the
 * Node tests. All the timing math lives in the pure SyncMap. See spec doc 6.
 *
 * Design choices that matter for low latency (spec doc 6 §6.5):
 *  - Master clock = AudioContext, NOT requestAnimationFrame or Date.now().
 *  - The song is a fully-decoded AudioBuffer scheduled with source.start(when),
 *    so song-second 0 maps to a known context time exactly.
 *  - latencyHint 'interactive' asks the platform for the smallest output buffer.
 *  - Each refresh() samples getOutputTimestamp() (which already reflects output
 *    latency) to re-anchor the SyncMap; a fallback approximates it from
 *    currentTime - outputLatency when the API is unavailable.
 *  - Judging and rendering both read song time via performance timestamps, so
 *    an input's event.timeStamp lines up with the audio on the audible axis.
 */

import { SyncMap } from './syncMap';

/**
 * Re-anchor a SyncMap from the audio hardware — THE sync primitive shared by
 * gameplay (WebAudioClock) and the song-preview player, so both live on the
 * same audible axis. getOutputTimestamp already accounts for output latency;
 * when it is missing or not yet warmed up we approximate with
 * currentTime - outputLatency.
 */
/** How often to re-anchor the audio↔perf mapping. Long enough that `now`
 *  extrapolates smoothly with performance.now() between anchors (no per-frame
 *  quantization to the audio callback), short enough that the crystal drift
 *  between the clocks stays well under a millisecond. */
const ANCHOR_INTERVAL_MS = 250;

export function anchorSyncFromOutput(ctx: AudioContext, sync: SyncMap): void {
  const ts = ctx.getOutputTimestamp?.();
  if (
    ts &&
    ts.contextTime !== undefined &&
    ts.performanceTime !== undefined &&
    ts.contextTime > 0
  ) {
    sync.setAnchor(ts.contextTime, ts.performanceTime);
    return;
  }
  const outLatency = ctx.outputLatency || ctx.baseLatency || 0;
  sync.setAnchor(ctx.currentTime - outLatency, performance.now());
}

export class WebAudioClock {
  readonly ctx: AudioContext;
  readonly sync = new SyncMap();

  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private playing = false;
  private disposed = false;

  constructor() {
    // 'interactive' minimizes output buffer size (lowest latency the device allows).
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
  }

  /** Must be called from a user gesture (autoplay policy). */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Decode an encoded audio file (ArrayBuffer) into a playable buffer.
   *  Decodes a copy so the caller's ArrayBuffer stays usable (replays). */
  async load(encoded: ArrayBuffer): Promise<void> {
    this.buffer = await this.ctx.decodeAudioData(encoded.slice(0));
  }

  /** Use a pre-made buffer (e.g. a synthesized click track). */
  setBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
  }

  get durationSeconds(): number {
    return this.buffer?.duration ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /**
   * Start playback at `offsetSeconds` into the song, `leadSeconds` from now.
   * The small lead lets the graph settle before audio begins.
   */
  start(offsetSeconds = 0, leadSeconds = 0.12): void {
    if (!this.buffer) throw new Error('WebAudioClock.start: no buffer loaded');
    this.stop();

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.sync.playbackRate;
    src.connect(this.ctx.destination);

    const when = this.ctx.currentTime + leadSeconds;
    src.start(when, offsetSeconds);

    // song-second 0 == context time (when - offset/rate).
    this.sync.startContextTime = when - offsetSeconds / this.sync.playbackRate;
    this.source = src;
    this.playing = true;
    src.onended = () => {
      if (this.source === src) this.playing = false;
    };

    this.refresh();
  }

  stop(): void {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        // already stopped
      }
      this.source.disconnect();
      this.source = null;
    }
    this.playing = false;
  }

  /**
   * Stop playback and release the underlying AudioContext. Browsers cap the
   * number of concurrent contexts, so every owner must dispose its clock when
   * it is done (each play/retry and each calibration run makes a fresh one).
   * Idempotent: safe to call twice, after stop(), or on an already-closed
   * context. The clock is unusable afterwards.
   */
  async dispose(): Promise<void> {
    this.stop();
    if (this.disposed) return;
    this.disposed = true;
    if (this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        // context already closed (or closing) — nothing left to release
      }
    }
  }

  private lastAnchorPerf = 0;

  /** Re-anchor the SyncMap from the audio hardware (a fresh getOutputTimestamp
   *  snapshot: contextTime paired with a ~now performanceTime). */
  refresh(): void {
    anchorSyncFromOutput(this.ctx, this.sync);
    this.lastAnchorPerf = performance.now();
  }

  /**
   * Song position (seconds) audible right now.
   *
   * Re-anchoring every call would pin the anchor's performanceTime to ~now, so
   * `songSecondsAtPerf(now)` would return the raw contextTime — the audio clock,
   * which only advances per audio callback (a few ms). That makes `now` step at
   * the audio cadence, so time-based animations look low-fps on a high-refresh
   * display. Instead we hold the anchor and extrapolate with performance.now()
   * (which advances every frame), re-anchoring only every ANCHOR_INTERVAL_MS to
   * correct the small crystal drift between the two clocks — smooth at any Hz.
   */
  songSecondsNow(): number {
    const perf = performance.now();
    if (perf - this.lastAnchorPerf >= ANCHOR_INTERVAL_MS) this.refresh();
    return this.sync.songSecondsAtPerf(perf);
  }

  /** Song position (seconds) audible at an input's event.timeStamp (ms). */
  songSecondsAtEvent(eventTimeStampMs: number): number {
    return this.sync.songSecondsAtPerf(eventTimeStampMs);
  }
}
