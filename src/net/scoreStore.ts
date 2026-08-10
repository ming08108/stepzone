/**
 * Leaderboard storage behind the scores API — the seam that lets the API
 * handlers (net/scoresApi.ts) run against an in-memory store in tests/dev and
 * Neon Postgres in production (net/pgScoreStore.ts).
 *
 * Semantics, shared by every implementation:
 *  - Identity is claim-on-first-submit: an unknown playerId is bound to the
 *    presented secret hash; a known one must present the matching hash.
 *  - One stored row per (chartHash, rateKey, player): the player's best.
 *    Merging follows app/scores.ts mergeBest — percent and maxCombo fold as
 *    independent maxes, grade/counts/failed follow the better percent, plays
 *    always increments.
 *  - Rank is 1 + the number of players on the board with a strictly better
 *    percent (ties share a rank).
 */

import type { ChartRef, LeaderboardResponse, PlayResult, SubmitScoreRequest } from './protocol';
import { rateKey } from './protocol';

export interface StoredBest {
  playerId: string;
  playerName: string;
  result: PlayResult;
  plays: number;
  /** Unix ms of the play that set the current best. */
  updatedAt: number;
}

export type SubmitOutcome =
  { ok: true; isPersonalBest: boolean; rank: number } | { ok: false; code: 'bad_secret' };

export interface ScoreStore {
  /** Fixed-window admission control for one privacy-preserving actor hash. */
  consumeSubmissionBudget(actorHash: string, now: number): Promise<boolean>;
  /** Fold one validated play into the board; claims the playerId if new. */
  submit(req: SubmitScoreRequest, secretHash: string, now: number): Promise<SubmitOutcome>;
  /** Top rows for one board, best first. */
  top(chartHash: string, rate: number, limit: number): Promise<LeaderboardResponse>;
}

export const SUBMISSION_WINDOW_MS = 60_000;
export const SUBMISSION_LIMIT = 12;

/** The mergeBest policy applied to a stored row (pure; shared by stores). */
export function mergeStoredBest(
  prev: StoredBest | undefined,
  req: SubmitScoreRequest,
  now: number,
): { next: StoredBest; isPersonalBest: boolean } {
  const r = req.result;
  const isPersonalBest = !prev || r.percent > prev.result.percent;
  const better = isPersonalBest ? r : prev.result;
  const next: StoredBest = {
    playerId: req.playerId,
    playerName: req.playerName,
    result: {
      percent: Math.max(r.percent, prev?.result.percent ?? 0),
      grade: better.grade,
      maxCombo: Math.max(r.maxCombo, prev?.result.maxCombo ?? 0),
      failed: better.failed,
      counts: better.counts,
      holdCounts: better.holdCounts,
    },
    plays: (prev?.plays ?? 0) + 1,
    updatedAt: isPersonalBest ? now : (prev?.updatedAt ?? now),
  };
  return { next, isPersonalBest };
}

/** Best-first board order: percent desc, earlier achiever wins ties. */
export function compareBests(a: StoredBest, b: StoredBest): number {
  if (a.result.percent !== b.result.percent) return b.result.percent - a.result.percent;
  return a.updatedAt - b.updatedAt;
}

interface PlayerRecord {
  secretHash: string;
  name: string;
}

/** In-memory store for tests, local dev, and previews without a database.
 *  State lives only as long as the process — by design. */
export class MemoryScoreStore implements ScoreStore {
  private readonly players = new Map<string, PlayerRecord>();
  private readonly boards = new Map<string, Map<string, StoredBest>>();
  /** Chart metadata by hash (display only; last write wins). */
  private readonly charts = new Map<string, ChartRef>();
  private readonly budgets = new Map<string, { windowStart: number; hits: number }>();

  consumeSubmissionBudget(actorHash: string, now: number): Promise<boolean> {
    const current = this.budgets.get(actorHash);
    if (!current || now - current.windowStart >= SUBMISSION_WINDOW_MS) {
      this.budgets.set(actorHash, { windowStart: now, hits: 1 });
      return Promise.resolve(true);
    }
    if (current.hits >= SUBMISSION_LIMIT) return Promise.resolve(false);
    current.hits++;
    return Promise.resolve(true);
  }

  private board(chartHash: string, rk: number): Map<string, StoredBest> {
    const key = `${chartHash}·${rk}`;
    let b = this.boards.get(key);
    if (!b) {
      b = new Map();
      this.boards.set(key, b);
    }
    return b;
  }

  submit(req: SubmitScoreRequest, secretHash: string, now: number): Promise<SubmitOutcome> {
    const player = this.players.get(req.playerId);
    if (player && player.secretHash !== secretHash) {
      return Promise.resolve({ ok: false, code: 'bad_secret' });
    }
    this.players.set(req.playerId, { secretHash, name: req.playerName });
    this.charts.set(req.chart.chartHash, req.chart);

    const board = this.board(req.chart.chartHash, rateKey(req.musicRate));
    const { next, isPersonalBest } = mergeStoredBest(board.get(req.playerId), req, now);
    board.set(req.playerId, next);

    let better = 0;
    for (const row of board.values()) {
      if (row.result.percent > next.result.percent) better++;
    }
    return Promise.resolve({ ok: true, isPersonalBest, rank: better + 1 });
  }

  top(chartHash: string, rate: number, limit: number): Promise<LeaderboardResponse> {
    const board = this.board(chartHash, rateKey(rate));
    const sorted = [...board.values()].sort(compareBests).slice(0, limit);
    // Ties share a rank (same rule as submit()'s strictly-better count).
    let rank = 0;
    let prevPercent = Number.POSITIVE_INFINITY;
    const rows = sorted.map((row, i) => {
      if (row.result.percent < prevPercent) {
        rank = i + 1;
        prevPercent = row.result.percent;
      }
      return {
        rank,
        playerId: row.playerId,
        playerName: row.playerName,
        percent: row.result.percent,
        grade: row.result.grade,
        maxCombo: row.result.maxCombo,
        failed: row.result.failed,
        at: row.updatedAt,
      };
    });
    return Promise.resolve({ rows, total: board.size });
  }
}
