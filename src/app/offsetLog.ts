/**
 * Recent tap-timing errors, banked per finished play (settings TIMING).
 *
 * The engine measures a signed error for every judged tap (GameSession.offsets)
 * and used to throw them away when the results screen closed. The settings
 * screen's TIMING section wants them across plays — "your last 5 plays average
 * +9.4 ms late, APPLY −21 MS" — so each finished play banks a downsampled
 * slice here, STAMPED WITH THE AUDIO OFFSET IN FORCE when it was measured.
 * The stamp is what keeps the recommendation stable: errors are normalized to
 * offset-zero before averaging, so applying the suggestion converges instead
 * of compounding (the classic "APPLY −21 → APPLY −42 → …" runaway).
 *
 * Persisted like the other app stores: untrusted JSON, sanitized on load,
 * capped so it can't grow without bound.
 */

import { isRecord, loadJson, saveJson } from './storage';

const STORAGE_KEY = 'notefield.offsetLog.v1';

/** How many plays the log keeps. */
export const OFFSET_LOG_PLAYS = 5;
/** Max tap errors kept per play (evenly sampled when a play has more). */
export const OFFSET_LOG_SAMPLES = 80;

export interface OffsetLogPlay {
  /** Sampled signed tap errors in ms (negative = early), as measured. */
  ms: number[];
  /** The audioOffsetMs setting in force during the play. */
  offsetMs: number;
  /** Unix ms when the play finished. */
  at: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function loadOffsetLog(): OffsetLogPlay[] {
  const p = loadJson<unknown>(STORAGE_KEY);
  if (!Array.isArray(p)) return [];
  const out: OffsetLogPlay[] = [];
  for (const e of p) {
    // Entries without the offset stamp can't be normalized — drop them.
    if (!isRecord(e) || !Array.isArray(e.ms) || !finite(e.offsetMs)) continue;
    const ms = e.ms.filter(finite).slice(0, OFFSET_LOG_SAMPLES);
    if (ms.length > 0) out.push({ ms, offsetMs: e.offsetMs, at: finite(e.at) ? e.at : 0 });
  }
  return out.slice(-OFFSET_LOG_PLAYS);
}

/** Bank one finished play's tap errors (seconds, as GameSession.offsets). */
export function recordPlayOffsets(
  offsetsSeconds: readonly number[],
  offsetMs: number,
  now = Date.now(),
): void {
  if (offsetsSeconds.length === 0) return;
  const step = Math.max(1, Math.ceil(offsetsSeconds.length / OFFSET_LOG_SAMPLES));
  const ms: number[] = [];
  for (let i = 0; i < offsetsSeconds.length; i += step) {
    const v = offsetsSeconds[i] * 1000;
    if (Number.isFinite(v)) ms.push(Math.round(v * 10) / 10);
  }
  const log = [...loadOffsetLog(), { ms, offsetMs, at: now }].slice(-OFFSET_LOG_PLAYS);
  saveJson(STORAGE_KEY, log);
}

/** Every logged tap error re-expressed AS IF measured at `atOffsetMs`. */
export function offsetsRelativeTo(atOffsetMs: number, log = loadOffsetLog()): number[] {
  // songSeconds = wallSeconds + audioOffset, so an error measured at offset X
  // re-measured at offset Y would read (err − X + Y).
  return log.flatMap((p) => p.ms.map((v) => v - p.offsetMs + atOffsetMs));
}

/**
 * The one number the panel recommends. Errors are normalized to offset-zero,
 * so the ideal offset is simply −mean₀ regardless of what was in force when
 * each play was banked. Returns null when there is too little signal (< 12
 * taps) or the current setting is already within 5 ms of ideal — which is
 * also what makes APPLY converge: after applying, the suggestion disappears.
 * Clamped to the settings slider's ±150 range.
 */
export function offsetSuggestion(
  currentOffsetMs: number,
  log = loadOffsetLog(),
): { meanMs: number; suggestMs: number } | null {
  const zeroed = offsetsRelativeTo(0, log);
  if (zeroed.length < 12) return null;
  const mean0 = zeroed.reduce((a, b) => a + b, 0) / zeroed.length;
  const ideal = Math.max(-150, Math.min(150, Math.round(-mean0)));
  if (Math.abs(ideal - currentOffsetMs) <= 5) return null;
  // meanMs: what the player's error reads at the CURRENT setting.
  return { meanMs: mean0 + currentOffsetMs, suggestMs: ideal };
}
