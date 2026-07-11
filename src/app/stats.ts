/**
 * Global lifetime stats, persisted to localStorage (todos3 #9/#10): the total
 * number of steps the player has ever hit, how many times each song has been
 * started (keyed by songKey — includes retries and practice runs, unlike
 * ChartScore.plays which counts completed plays), plus lifetime judgment tallies
 * and a per-day step log surfaced on the OPTIONS screen.
 */

import { isRecord, loadJson, saveJson } from './storage';

const STORAGE_KEY = 'notefield.stats.v1';

/** Keep at most this many day-keyed step buckets (pruned oldest-first on save). */
const MAX_DAILY_STEPS = 90;

export interface GlobalStats {
  /** Lifetime count of successfully hit steps (W1–W5 taps, incl. hold heads). */
  steps: number;
  /** songKey -> number of times a play of that song was started. */
  songPlays: Record<string, number>;
  /** Lifetime seconds spent in gameplay sessions. */
  playTimeSeconds: number;
  /** Finished plays that did not fail out. */
  songsCompleted: number;
  /** Finished plays that failed out. */
  songsFailed: number;
  /** Lifetime tally per TapNoteScore (W1..W5, Miss, hit mines), like Judge.tapCounts. */
  taps: Record<number, number>;
  /** Lifetime tally per HoldNoteScore (held/dropped), like Judge.holdCounts. */
  holds: Record<number, number>;
  /** Highest max-combo ever seen in a single play. */
  bestCombo: number;
  /** Steps hit per local calendar day, keyed `YYYY-MM-DD`. */
  dailySteps: Record<string, number>;
}

function emptyStats(): GlobalStats {
  return {
    steps: 0,
    songPlays: {},
    playTimeSeconds: 0,
    songsCompleted: 0,
    songsFailed: 0,
    taps: {},
    holds: {},
    bestCombo: 0,
    dailySteps: {},
  };
}

/** A positive finite number floored to an int, or 0. */
function posInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Local calendar day as `YYYY-MM-DD` (sorts chronologically as a string). */
export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Sanitize a `{ intKey: positiveInt }` map (taps/holds — keys are score enums). */
function loadCountMap(v: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (isRecord(v)) {
    for (const [k, val] of Object.entries(v)) {
      const nk = Number(k);
      const nv = posInt(val);
      if (Number.isInteger(nk) && nv > 0) out[nk] = nv;
    }
  }
  return out;
}

/** Sanitize the per-day step log: only `YYYY-MM-DD` keys with positive counts. */
function loadDailySteps(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isRecord(v)) {
    for (const [k, val] of Object.entries(v)) {
      const nv = posInt(val);
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && nv > 0) out[k] = nv;
    }
  }
  return out;
}

/** Load + sanitize (persisted JSON is untrusted, like app/settings). */
export function loadStats(): GlobalStats {
  const p = loadJson<unknown>(STORAGE_KEY);
  const out = emptyStats();
  if (isRecord(p)) {
    out.steps = posInt(p.steps);
    out.playTimeSeconds =
      typeof p.playTimeSeconds === 'number' &&
      Number.isFinite(p.playTimeSeconds) &&
      p.playTimeSeconds > 0
        ? p.playTimeSeconds
        : 0;
    out.songsCompleted = posInt(p.songsCompleted);
    out.songsFailed = posInt(p.songsFailed);
    out.bestCombo = posInt(p.bestCombo);
    if (isRecord(p.songPlays)) {
      for (const [k, v] of Object.entries(p.songPlays)) {
        const n = posInt(v);
        if (n > 0) out.songPlays[k] = n;
      }
    }
    out.taps = loadCountMap(p.taps);
    out.holds = loadCountMap(p.holds);
    out.dailySteps = loadDailySteps(p.dailySteps);
  }
  return out;
}

/** Keep only the most recent MAX_DAILY_STEPS day buckets (keys sort as dates). */
function pruneDailySteps(map: Record<string, number>): void {
  const keys = Object.keys(map);
  if (keys.length <= MAX_DAILY_STEPS) return;
  keys.sort();
  for (const k of keys.slice(0, keys.length - MAX_DAILY_STEPS)) delete map[k];
}

/** Persist, pruning the day log so it can't grow without bound. */
function saveStats(s: GlobalStats): void {
  pruneDailySteps(s.dailySteps);
  saveJson(STORAGE_KEY, s);
}

/** Fold `src` counts into `target` (both keyed by score enum), skipping junk. */
function addCounts(target: Record<number, number>, src: Record<number, number>): void {
  if (!isRecord(src)) return;
  for (const [k, v] of Object.entries(src)) {
    const nk = Number(k);
    const nv = posInt(v);
    if (Number.isInteger(nk) && nv > 0) target[nk] = (target[nk] ?? 0) + nv;
  }
}

/** Fold a session's hit steps into the lifetime counter and today's day bucket. */
export function addSteps(n: number): void {
  if (!Number.isFinite(n) || n <= 0) return;
  const s = loadStats();
  const add = Math.floor(n);
  s.steps += add;
  const key = dayKey();
  s.dailySteps[key] = (s.dailySteps[key] ?? 0) + add;
  saveStats(s);
}

/** Count one play start of a song (by songKey from app/favorites). */
export function addSongPlay(key: string): void {
  const s = loadStats();
  s.songPlays[key] = (s.songPlays[key] ?? 0) + 1;
  saveStats(s);
}

/** Fold everything a finished play reports into lifetime stats, in one write. */
export function recordPlayEnd(summary: {
  seconds: number;
  failed: boolean;
  counts: Record<number, number>;
  holdCounts: Record<number, number>;
  maxCombo: number;
}): void {
  const s = loadStats();
  if (Number.isFinite(summary.seconds) && summary.seconds > 0) {
    s.playTimeSeconds += summary.seconds;
  }
  if (summary.failed) s.songsFailed += 1;
  else s.songsCompleted += 1;
  addCounts(s.taps, summary.counts);
  addCounts(s.holds, summary.holdCounts);
  if (Number.isFinite(summary.maxCombo) && summary.maxCombo > s.bestCombo) {
    s.bestCombo = Math.floor(summary.maxCombo);
  }
  saveStats(s);
}
