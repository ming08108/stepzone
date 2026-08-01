/**
 * Recent tap-timing errors, banked per finished play (todo: settings TIMING).
 *
 * The engine measures a signed error for every judged tap (GameSession.offsets)
 * and used to throw them away when the results screen closed. The settings
 * screen's TIMING section wants them across plays — "your last 5 plays average
 * +9.4 ms late, APPLY −21 MS" — so each finished play banks a downsampled
 * slice here. Persisted like the other app stores: untrusted JSON, sanitized
 * on load, capped so it can't grow without bound.
 */

import { isRecord, loadJson, saveJson } from './storage';

const STORAGE_KEY = 'notefield.offsetLog.v1';

/** How many plays the log keeps. */
export const OFFSET_LOG_PLAYS = 5;
/** Max tap errors kept per play (evenly sampled when a play has more). */
export const OFFSET_LOG_SAMPLES = 80;

export interface OffsetLogPlay {
  /** Sampled signed tap errors in ms (negative = early). */
  ms: number[];
  /** Unix ms when the play finished. */
  at: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function loadOffsetLog(): OffsetLogPlay[] {
  const p = loadJson<unknown>(STORAGE_KEY);
  if (!Array.isArray(p)) return [];
  const out: OffsetLogPlay[] = [];
  for (const e of p) {
    if (!isRecord(e) || !Array.isArray(e.ms)) continue;
    const ms = e.ms.filter(finite).slice(0, OFFSET_LOG_SAMPLES);
    if (ms.length > 0) out.push({ ms, at: finite(e.at) ? e.at : 0 });
  }
  return out.slice(-OFFSET_LOG_PLAYS);
}

/** Bank one finished play's tap errors (seconds, as GameSession.offsets). */
export function recordPlayOffsets(offsetsSeconds: readonly number[], now = Date.now()): void {
  if (offsetsSeconds.length === 0) return;
  const step = Math.max(1, Math.ceil(offsetsSeconds.length / OFFSET_LOG_SAMPLES));
  const ms: number[] = [];
  for (let i = 0; i < offsetsSeconds.length; i += step) {
    const v = offsetsSeconds[i] * 1000;
    if (Number.isFinite(v)) ms.push(Math.round(v * 10) / 10);
  }
  const log = [...loadOffsetLog(), { ms, at: now }].slice(-OFFSET_LOG_PLAYS);
  saveJson(STORAGE_KEY, log);
}

/** Every logged tap error, oldest play first — the settings TIMING scatter. */
export function allLoggedOffsets(log = loadOffsetLog()): number[] {
  return log.flatMap((p) => p.ms);
}

/**
 * The one number the panel recommends: mean of the logged errors, or null when
 * there is too little signal to say anything (< 12 taps or |mean| ≤ 5 ms).
 * The suggested setting is `audioOffsetMs − mean`: offsets measure hit − target
 * on the judged axis, so hitting late (+mean) means the reference should move
 * earlier by the same amount.
 */
export function offsetSuggestion(
  currentOffsetMs: number,
  log = loadOffsetLog(),
): { meanMs: number; suggestMs: number } | null {
  const all = allLoggedOffsets(log);
  if (all.length < 12) return null;
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  if (Math.abs(mean) <= 5) return null;
  return { meanMs: mean, suggestMs: Math.round(currentOffsetMs - mean) };
}
