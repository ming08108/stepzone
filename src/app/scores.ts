/** Per-chart best scores + play stats, persisted to localStorage (todo #13). */

import type { Song } from '../song/song';
import type { Steps } from '../song/steps';
import { songKey } from './favorites';

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
  return `${songKey(song.title, song.artist)}·${chart.stepsType}·${chart.difficulty}·${chart.meter}`;
}

export function loadScores(): Record<string, ChartScore> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ChartScore>) : {};
  } catch {
    return {};
  }
}

function save(map: Record<string, ChartScore>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export interface RecordInput {
  percent: number;
  grade: string;
  maxCombo: number;
  counts: Record<number, number>;
}

/** Merge a finished play into the stored best; returns the best + whether it beat it. */
export function recordPlay(
  key: string,
  r: RecordInput,
): { best: ChartScore; isNewRecord: boolean } {
  const map = loadScores();
  const prev = map[key];
  const isNewRecord = !prev || r.percent > prev.percent;
  const best: ChartScore = {
    percent: Math.max(r.percent, prev?.percent ?? 0),
    grade: prev && prev.percent >= r.percent ? prev.grade : r.grade,
    maxCombo: Math.max(r.maxCombo, prev?.maxCombo ?? 0),
    counts: isNewRecord ? r.counts : (prev?.counts ?? r.counts),
    plays: (prev?.plays ?? 0) + 1,
    updated: Date.now(),
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
