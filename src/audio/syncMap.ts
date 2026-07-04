/**
 * The clock mapping — the crux of low-latency correctness on the web.
 *
 * The problem: two clocks live on different timebases.
 *   - AudioContext.currentTime (seconds) drives audio playback.
 *   - performance.now() (ms) is what KeyboardEvent.timeStamp is measured against.
 * To judge an input against the music we must map an input's performance
 * timestamp onto the *audible* song position, accounting for output latency.
 *
 * The bridge is AudioContext.getOutputTimestamp(), which yields an anchor pair
 * {contextTime, performanceTime}: "the sample at contextTime is heard at
 * performanceTime". Because that pair already reflects output latency, we never
 * separately subtract it — we just interpolate from the anchor.
 *
 * This class is intentionally pure (no Web Audio) so the math is unit-tested.
 * WebAudioClock (audio/clock.ts) feeds it anchors from a real AudioContext.
 * See spec doc 6 (§6.5).
 */

export interface SyncAnchor {
  /** AudioContext time (seconds) of the sample currently being made audible. */
  contextTime: number;
  /** performance.now() timestamp (ms) at which that sample is audible. */
  performanceTimeMs: number;
}

export class SyncMap {
  /** AudioContext time (seconds) at which song-second 0 begins playing. */
  startContextTime = 0;

  /** Music playback rate (1 = normal). Speeds/slows the mapping from ctx->song. */
  playbackRate = 1;

  /**
   * User audio-sync calibration (seconds), added to the computed song time.
   * Positive shifts judgment later (compensates for audio heard earlier than
   * reported). Tune it on a calibration screen; it is the honest fix for
   * per-device latency the platform will not disclose.
   */
  audioOffsetSeconds = 0;

  private anchor: SyncAnchor = { contextTime: 0, performanceTimeMs: 0 };
  private hasAnchor = false;

  /** Feed a fresh {contextTime, performanceTime} pair (from getOutputTimestamp). */
  setAnchor(contextTime: number, performanceTimeMs: number): void {
    this.anchor = { contextTime, performanceTimeMs };
    this.hasAnchor = true;
  }

  get ready(): boolean {
    return this.hasAnchor;
  }

  /** The AudioContext time being *heard* at a given performance timestamp (ms). */
  audibleContextTimeAtPerf(perfMs: number): number {
    return this.anchor.contextTime + (perfMs - this.anchor.performanceTimeMs) / 1000;
  }

  /**
   * Song position (seconds) audible at a performance timestamp (ms).
   * Use with performance.now() for "now", or event.timeStamp for an input.
   */
  songSecondsAtPerf(perfMs: number): number {
    if (!this.hasAnchor) return this.audioOffsetSeconds;
    const ctx = this.audibleContextTimeAtPerf(perfMs);
    return (ctx - this.startContextTime) * this.playbackRate + this.audioOffsetSeconds;
  }
}
