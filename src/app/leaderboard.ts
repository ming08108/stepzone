/**
 * Client for the shared leaderboard server (server/leaderboard.mjs). Charts
 * are keyed by content hash (src/song/chartHash.ts) so every player's copy of
 * a song lands on the same board. Fully optional: no server URL configured,
 * an unreachable host, or a malformed reply all resolve to null — the game
 * never blocks or errors on the network (same silent contract as the song
 * preview player).
 */

import { isRecord } from './storage';

export interface LeaderboardEntry {
  rank: number;
  player: string;
  percent: number;
  grade: string;
  maxCombo: number;
  plays: number;
}

export interface LeaderboardView {
  /** Players on this chart's board. */
  total: number;
  /** The submitting/asking player's 1-based rank, or null if absent. */
  rank: number | null;
  /** Top of the board, best percent first. */
  entries: LeaderboardEntry[];
}

const TIMEOUT_MS = 4000;

const api = (base: string, path: string) => `${base.replace(/\/+$/, '')}/api${path}`;

/** Coerce an untrusted server reply into a well-formed view, or null. */
function sanitizeView(v: unknown): LeaderboardView | null {
  if (!isRecord(v) || !Array.isArray(v.entries)) return null;
  const entries: LeaderboardEntry[] = [];
  for (const e of v.entries) {
    if (!isRecord(e) || typeof e.player !== 'string' || typeof e.percent !== 'number') continue;
    entries.push({
      rank: typeof e.rank === 'number' ? e.rank : entries.length + 1,
      player: e.player.slice(0, 16),
      percent: Math.max(0, Math.min(1, e.percent)),
      grade: typeof e.grade === 'string' ? e.grade.slice(0, 4) : '?',
      maxCombo: typeof e.maxCombo === 'number' ? e.maxCombo : 0,
      plays: typeof e.plays === 'number' ? e.plays : 0,
    });
  }
  return {
    total: typeof v.total === 'number' ? v.total : entries.length,
    rank: typeof v.rank === 'number' ? v.rank : null,
    entries,
  };
}

async function request(url: string, init?: RequestInit): Promise<LeaderboardView | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return sanitizeView(await res.json());
  } catch {
    return null; // offline / bad host / timeout — leaderboards just don't show
  }
}

export interface ScoreSubmission {
  chartHash: string;
  player: string;
  percent: number;
  grade: string;
  maxCombo: number;
}

/** Submit a finished play; resolves to the updated board (or null, silently). */
export function submitScore(baseUrl: string, score: ScoreSubmission) {
  return request(api(baseUrl, '/scores'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(score),
  });
}

/** Fetch a chart's board; `player` marks whose rank to report. */
export function fetchLeaderboard(baseUrl: string, chartHash: string, player?: string) {
  const q = player ? `?player=${encodeURIComponent(player)}` : '';
  return request(api(baseUrl, `/scores/${chartHash}${q}`));
}
