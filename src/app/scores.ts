/** Per-chart best scores + play stats, persisted to localStorage (todo #13). */

import type { Song } from '../song/song';
import type { Steps } from '../song/steps';
import { songKey } from './favorites';
import { isRecord, loadJson, saveJson } from './storage';

export interface ChartScore {
  percent: number;
  grade: string;
  maxCombo: number;
  /** TapNoteScore -> count, for the best play. */
  counts: Record<number, number>;
  plays: number;
  updated: number;
}

const STORAGE_KEY = 'notefield.scores.v1';

export function chartKey(song: Song, chart: Steps): string {
  return `${songKey(song.displayFullTitle, song.artist)}·${chart.stepsType}·${chart.difficulty}·${chart.meter}`;
}

const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate one persisted entry; null drops malformed ones instead of throwing. */
function sanitizeScore(v: unknown): ChartScore | null {
  if (!isRecord(v)) return null;
  if (!finiteNum(v.percent) || typeof v.grade !== 'string') return null;
  if (!finiteNum(v.maxCombo) || !finiteNum(v.plays)) return null;
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
    plays: v.plays,
    updated: finiteNum(v.updated) ? v.updated : 0,
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
}

/**
 * Pure best-merge policy: fold a finished play into the stored best.
 * A new record is strictly-better percent (or a first play); percent and
 * maxCombo merge independently as maxes; grade/counts follow the better
 * percent; plays always increments.
 */
export function mergeBest(
  prev: ChartScore | undefined,
  r: RecordInput,
  now: number = Date.now(),
): { best: ChartScore; isNewRecord: boolean } {
  const isNewRecord = !prev || r.percent > prev.percent;
  const best: ChartScore = {
    percent: Math.max(r.percent, prev?.percent ?? 0),
    grade: prev && prev.percent >= r.percent ? prev.grade : r.grade,
    maxCombo: Math.max(r.maxCombo, prev?.maxCombo ?? 0),
    counts: isNewRecord ? r.counts : (prev?.counts ?? r.counts),
    plays: (prev?.plays ?? 0) + 1,
    updated: now,
  };
  return { best, isNewRecord };
}

/** Merge a finished play into the stored best; returns the best + whether it beat it. */
export function recordPlay(
  key: string,
  r: RecordInput,
): { best: ChartScore; isNewRecord: boolean } {
  const map = loadScores();
  const result = mergeBest(map[key], r);
  map[key] = result.best;
  save(map);
  return result;
}

/** Global stats across all charts. */
export function totalStats(): { plays: number; charts: number } {
  const map = loadScores();
  let plays = 0;
  for (const s of Object.values(map)) plays += s.plays;
  return { plays, charts: Object.keys(map).length };
}
