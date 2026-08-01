/** Per-chart best scores + play stats, persisted to localStorage (todo #13). */

import type { Song } from '../song/song';
import type { Steps } from '../song/steps';
import { chartContentHash } from '../song/chartHash';
import { isRecord, loadJson, saveJson } from './storage';

/** The best-play fields mergeBest folds. */
export interface ChartScoreCore {
  percent: number;
  grade: string;
  maxCombo: number;
  /** TapNoteScore -> count, for the best play. */
  counts: Record<number, number>;
  /** The best play failed out. Records written before this field existed load
   *  as false — an old record is far more likely to be a clear than a fail. */
  failed: boolean;
  plays: number;
  updated: number;
}

/**
 * A stored record. Keyed by chart content hash (song/chartHash), so the song
 * and chart labels the UI groups/displays by ride along on the record itself;
 * they are refreshed on every play (a retitled simfile keeps its records and
 * catches up on the next play).
 */
export interface ChartScore extends ChartScoreCore {
  title: string;
  artist: string;
  /** Difficulty enum value (song/difficulty). */
  difficulty: number;
  meter: number;
  /** The last few plays' percents, oldest first (this best included) — the
   *  results screen's attempt-history strip. Capped at HISTORY_LIMIT. */
  history: number[];
}

/** How many recent attempt percents a record keeps. */
export const HISTORY_LIMIT = 20;

const STORAGE_KEY = 'notefield.scores.v2';

/** Score-storage key: content identity, stable across metadata/sync edits. */
export function chartKey(song: Song, chart: Steps): string {
  return chartContentHash(song, chart);
}

const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate one persisted entry; null drops malformed ones instead of throwing. */
function sanitizeScore(v: unknown): ChartScore | null {
  if (!isRecord(v)) return null;
  if (!finiteNum(v.percent) || typeof v.grade !== 'string') return null;
  if (!finiteNum(v.maxCombo) || !finiteNum(v.plays)) return null;
  if (typeof v.title !== 'string' || typeof v.artist !== 'string') return null;
  if (!finiteNum(v.difficulty) || !finiteNum(v.meter)) return null;
  const counts: Record<number, number> = {};
  if (isRecord(v.counts)) {
    for (const [k, n] of Object.entries(v.counts)) {
      const tns = Number(k);
      if (Number.isFinite(tns) && finiteNum(n)) counts[tns] = n;
    }
  }
  return {
    percent: v.percent,
    grade: v.grade,
    maxCombo: v.maxCombo,
    counts,
    failed: typeof v.failed === 'boolean' ? v.failed : false,
    plays: v.plays,
    updated: finiteNum(v.updated) ? v.updated : 0,
    title: v.title,
    artist: v.artist,
    difficulty: v.difficulty,
    meter: v.meter,
    history: Array.isArray(v.history)
      ? v.history.filter((h): h is number => finiteNum(h) && h >= 0 && h <= 1).slice(-HISTORY_LIMIT)
      : [],
  };
}

export function loadScores(): Record<string, ChartScore> {
  const parsed = loadJson<unknown>(STORAGE_KEY);
  const out: Record<string, ChartScore> = {};
  if (isRecord(parsed)) {
    for (const [key, entry] of Object.entries(parsed)) {
      const score = sanitizeScore(entry);
      if (score) out[key] = score;
    }
  }
  return out;
}

function save(map: Record<string, ChartScore>): void {
  saveJson(STORAGE_KEY, map);
}

export interface RecordInput {
  percent: number;
  grade: string;
  maxCombo: number;
  counts: Record<number, number>;
  /** This play failed out (life hit zero). */
  failed: boolean;
}

/**
 * Pure best-merge policy: fold a finished play into the stored best.
 * A new record is strictly-better percent (or a first play); percent and
 * maxCombo merge independently as maxes; grade/counts/failed follow the better
 * percent; plays always increments.
 */
export function mergeBest(
  prev: ChartScoreCore | undefined,
  r: RecordInput,
  now: number = Date.now(),
): { best: ChartScoreCore; isNewRecord: boolean } {
  const isNewRecord = !prev || r.percent > prev.percent;
  const best: ChartScoreCore = {
    percent: Math.max(r.percent, prev?.percent ?? 0),
    grade: prev && prev.percent >= r.percent ? prev.grade : r.grade,
    maxCombo: Math.max(r.maxCombo, prev?.maxCombo ?? 0),
    counts: isNewRecord ? r.counts : (prev?.counts ?? r.counts),
    failed: prev && prev.percent >= r.percent ? prev.failed : r.failed,
    plays: (prev?.plays ?? 0) + 1,
    updated: now,
  };
  return { best, isNewRecord };
}

/** Merge a finished play into the stored best; returns the best + whether it beat it. */
export function recordPlay(
  song: Song,
  chart: Steps,
  r: RecordInput,
): { best: ChartScore; isNewRecord: boolean } {
  const map = loadScores();
  const key = chartKey(song, chart);
  const { best: core, isNewRecord } = mergeBest(map[key], r);
  const best: ChartScore = {
    ...core,
    title: song.displayFullTitle,
    artist: song.artist,
    difficulty: chart.difficulty,
    meter: chart.meter,
    // Every attempt lands in the ring (best or not) — the results screen's
    // "last N attempts" strip needs the misses too.
    history: [...(map[key]?.history ?? []), r.percent].slice(-HISTORY_LIMIT),
  };
  map[key] = best;
  save(map);
  return { best, isNewRecord };
}

/** Global stats across all charts. */
export function totalStats(): { plays: number; charts: number } {
  const map = loadScores();
  let plays = 0;
  for (const s of Object.values(map)) plays += s.plays;
  return { plays, charts: Object.keys(map).length };
}
