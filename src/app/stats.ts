/**
 * Global lifetime stats, persisted to localStorage (todos3 #9/#10): the total
 * number of steps the player has ever hit, and how many times each song has
 * been started (keyed by songKey — includes retries and practice runs, unlike
 * ChartScore.plays which counts completed plays).
 */

import { isRecord, loadJson, saveJson } from './storage';

const STORAGE_KEY = 'notefield.stats.v1';

export interface GlobalStats {
  /** Lifetime count of successfully hit steps (W1–W5 taps, incl. hold heads). */
  steps: number;
  /** songKey -> number of times a play of that song was started. */
  songPlays: Record<string, number>;
}

/** Load + sanitize (persisted JSON is untrusted, like app/settings). */
export function loadStats(): GlobalStats {
  const p = loadJson<unknown>(STORAGE_KEY);
  const out: GlobalStats = { steps: 0, songPlays: {} };
  if (isRecord(p)) {
    if (typeof p.steps === 'number' && Number.isFinite(p.steps) && p.steps > 0) {
      out.steps = Math.floor(p.steps);
    }
    if (isRecord(p.songPlays)) {
      for (const [k, v] of Object.entries(p.songPlays)) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
          out.songPlays[k] = Math.floor(v);
        }
      }
    }
  }
  return out;
}

/** Fold a session's hit steps into the lifetime counter. */
export function addSteps(n: number): void {
  if (!Number.isFinite(n) || n <= 0) return;
  const s = loadStats();
  s.steps += Math.floor(n);
  saveJson(STORAGE_KEY, s);
}

/** Count one play start of a song (by songKey from app/favorites). */
export function addSongPlay(key: string): void {
  const s = loadStats();
  s.songPlays[key] = (s.songPlays[key] ?? 0) + 1;
  saveJson(STORAGE_KEY, s);
}
