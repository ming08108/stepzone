/**
 * Pure helper for the song-preview player (audio/songPreview.ts): picks the
 * loop window inside a decoded buffer from the song's SAMPLESTART/SAMPLELENGTH
 * hints, with sane fallbacks when they are missing or out of range. No WebAudio
 * here, so it is unit-testable under Node.
 */

/** Loop length used when the song file gives no (or a zero) SAMPLELENGTH. */
export const DEFAULT_PREVIEW_LENGTH_SECONDS = 12;
/** Never loop a window shorter than this. */
export const MIN_PREVIEW_LENGTH_SECONDS = 3;
/** Fallback start aims 30% into the song, but at most this far from the end. */
export const FALLBACK_PREVIEW_TAIL_SECONDS = 15;

export interface PreviewWindow {
  startSeconds: number;
  lengthSeconds: number;
}

/**
 * Clamp a song's sample hints to a playable loop window inside a buffer of
 * `durationSeconds`. A start that is missing (negative/NaN) or within the last
 * second of the buffer falls back to a spot near 30% in; the length defaults
 * to DEFAULT_PREVIEW_LENGTH_SECONDS and is clamped to what remains, but never
 * below MIN_PREVIEW_LENGTH_SECONDS.
 */
export function previewWindow(
  durationSeconds: number,
  sampleStartSeconds: number,
  sampleLengthSeconds: number,
): PreviewWindow {
  let start = sampleStartSeconds;
  if (!(start >= 0) || start > durationSeconds - 1) {
    start = Math.min(
      durationSeconds * 0.3,
      Math.max(0, durationSeconds - FALLBACK_PREVIEW_TAIL_SECONDS),
    );
  }
  let length = sampleLengthSeconds || DEFAULT_PREVIEW_LENGTH_SECONDS;
  length = Math.max(MIN_PREVIEW_LENGTH_SECONDS, Math.min(length, durationSeconds - start));
  return { startSeconds: start, lengthSeconds: length };
}
