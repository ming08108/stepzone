/**
 * Neon Postgres ScoreStore — the production store behind api/scores.ts.
 * Uses Neon's HTTP driver (one fetch per statement, no pooling to manage),
 * which fits Vercel Functions. Schema bootstraps lazily on the first call of
 * a cold start (CREATE TABLE IF NOT EXISTS is cheap and idempotent).
 *
 * The best-score fold is one atomic ON CONFLICT statement, so concurrent
 * submissions cannot overwrite a better score or lose a plays increment.
 *
 * Server-only: imported by api/scores.ts, never by client code.
 */

import { neon } from '@neondatabase/serverless';
import type { LeaderboardResponse, SubmitScoreRequest } from './protocol';
import { rateKey } from './protocol';
import type { ScoreStore, SubmitOutcome } from './scoreStore';
import { SUBMISSION_LIMIT, SUBMISSION_WINDOW_MS } from './scoreStore';
import { randomToken } from './crypto';

type Sql = ReturnType<typeof neon>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS net_players (
     player_id   TEXT PRIMARY KEY,
     secret_hash TEXT NOT NULL,
     name        TEXT NOT NULL,
     created_at  BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS net_scores (
     chart_hash  TEXT NOT NULL,
     rate_key    INT NOT NULL,
     player_id   TEXT NOT NULL REFERENCES net_players(player_id),
     percent     DOUBLE PRECISION NOT NULL,
     grade       TEXT NOT NULL,
     max_combo   INT NOT NULL,
     failed      BOOLEAN NOT NULL,
     counts      JSONB NOT NULL,
     hold_counts JSONB NOT NULL,
     chart_meta  JSONB NOT NULL,
     plays       INT NOT NULL,
     updated_at  BIGINT NOT NULL,
     ghost       JSONB,
     best_token  TEXT,
     PRIMARY KEY (chart_hash, rate_key, player_id)
   )`,
  // Databases bootstrapped before the ghost column existed.
  `ALTER TABLE net_scores ADD COLUMN IF NOT EXISTS ghost JSONB`,
  `ALTER TABLE net_scores ADD COLUMN IF NOT EXISTS best_token TEXT`,
  `CREATE TABLE IF NOT EXISTS net_score_rate_limits (
     actor_hash   TEXT PRIMARY KEY,
     window_start BIGINT NOT NULL,
     hits         INT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS net_scores_board
     ON net_scores (chart_hash, rate_key, percent DESC, updated_at ASC)`,
];

interface ScoreRow {
  player_id: string;
  name: string;
  percent: number;
  grade: string;
  max_combo: number;
  failed: boolean;
  updated_at: string | number;
}

export class PgScoreStore implements ScoreStore {
  private readonly sql: Sql;
  private schemaReady: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  private ensureSchema(): Promise<void> {
    this.schemaReady ??= (async () => {
      for (const stmt of SCHEMA) await this.sql.query(stmt);
    })();
    return this.schemaReady;
  }

  async consumeSubmissionBudget(actorHash: string, now: number): Promise<boolean> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `INSERT INTO net_score_rate_limits (actor_hash, window_start, hits)
       VALUES ($1, $2, 1)
       ON CONFLICT (actor_hash) DO UPDATE SET
         window_start = CASE
           WHEN net_score_rate_limits.window_start <= $3 THEN EXCLUDED.window_start
           ELSE net_score_rate_limits.window_start
         END,
         hits = CASE
           WHEN net_score_rate_limits.window_start <= $3 THEN 1
           ELSE net_score_rate_limits.hits + 1
         END
       WHERE net_score_rate_limits.window_start <= $3
          OR net_score_rate_limits.hits < $4
       RETURNING hits`,
      [actorHash, now, now - SUBMISSION_WINDOW_MS, SUBMISSION_LIMIT],
    )) as { hits: number }[];
    return rows.length > 0;
  }

  async submit(req: SubmitScoreRequest, secretHash: string, now: number): Promise<SubmitOutcome> {
    await this.ensureSchema();
    const sql = this.sql;
    const rk = rateKey(req.musicRate);

    // Claim-on-first-submit: insert wins the id; whoever holds the matching
    // secret afterwards is the owner (the re-select covers a concurrent claim).
    await sql.query(
      `INSERT INTO net_players (player_id, secret_hash, name, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (player_id) DO NOTHING`,
      [req.playerId, secretHash, req.playerName, now],
    );
    const players = (await sql.query(`SELECT secret_hash FROM net_players WHERE player_id = $1`, [
      req.playerId,
    ])) as { secret_hash: string }[];
    if (players[0]?.secret_hash !== secretHash) return { ok: false, code: 'bad_secret' };

    await sql.query(`UPDATE net_players SET name = $2 WHERE player_id = $1`, [
      req.playerId,
      req.playerName,
    ]);

    // A unique marker records whether this submission owns the stored best.
    // Unlike comparing timestamps, it stays correct when two writes share a ms.
    const bestToken = randomToken();
    const stored = (await sql.query(
      `INSERT INTO net_scores (chart_hash, rate_key, player_id, percent, grade, max_combo,
                               failed, counts, hold_counts, chart_meta, plays, updated_at,
                               best_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $12)
       ON CONFLICT (chart_hash, rate_key, player_id) DO UPDATE SET
         percent = GREATEST(net_scores.percent, EXCLUDED.percent),
         grade = CASE WHEN EXCLUDED.percent > net_scores.percent THEN EXCLUDED.grade ELSE net_scores.grade END,
         max_combo = GREATEST(net_scores.max_combo, EXCLUDED.max_combo),
         failed = CASE WHEN EXCLUDED.percent > net_scores.percent THEN EXCLUDED.failed ELSE net_scores.failed END,
         counts = CASE WHEN EXCLUDED.percent > net_scores.percent THEN EXCLUDED.counts ELSE net_scores.counts END,
         hold_counts = CASE WHEN EXCLUDED.percent > net_scores.percent THEN EXCLUDED.hold_counts ELSE net_scores.hold_counts END,
         chart_meta = EXCLUDED.chart_meta,
         plays = net_scores.plays + 1,
         updated_at = CASE WHEN EXCLUDED.percent > net_scores.percent THEN EXCLUDED.updated_at ELSE net_scores.updated_at END,
         best_token = CASE WHEN EXCLUDED.percent > net_scores.percent THEN EXCLUDED.best_token ELSE net_scores.best_token END
       RETURNING percent, best_token`,
      [
        req.chart.chartHash,
        rk,
        req.playerId,
        req.result.percent,
        req.result.grade,
        req.result.maxCombo,
        req.result.failed,
        JSON.stringify(req.result.counts),
        JSON.stringify(req.result.holdCounts),
        JSON.stringify(req.chart),
        now,
        bestToken,
      ],
    )) as { percent: number; best_token: string | null }[];
    const best = stored[0];
    const storedPercent = best?.percent ?? req.result.percent;
    const isPersonalBest = best?.best_token === bestToken;

    const better = (await sql.query(
      `SELECT COUNT(*)::int AS n FROM net_scores
       WHERE chart_hash = $1 AND rate_key = $2 AND percent > $3`,
      [req.chart.chartHash, rk, storedPercent],
    )) as { n: number }[];
    return { ok: true, isPersonalBest, rank: (better[0]?.n ?? 0) + 1 };
  }

  async top(chartHash: string, rate: number, limit: number): Promise<LeaderboardResponse> {
    await this.ensureSchema();
    const rk = rateKey(rate);
    const rows = (await this.sql.query(
      `SELECT s.player_id, p.name, s.percent, s.grade, s.max_combo, s.failed,
              s.updated_at
       FROM net_scores s JOIN net_players p USING (player_id)
       WHERE s.chart_hash = $1 AND s.rate_key = $2
       ORDER BY s.percent DESC, s.updated_at ASC
       LIMIT $3`,
      [chartHash, rk, limit],
    )) as ScoreRow[];
    const totals = (await this.sql.query(
      `SELECT COUNT(*)::int AS n FROM net_scores WHERE chart_hash = $1 AND rate_key = $2`,
      [chartHash, rk],
    )) as { n: number }[];

    let rank = 0;
    let prevPercent = Number.POSITIVE_INFINITY;
    return {
      rows: rows.map((row, i) => {
        if (row.percent < prevPercent) {
          rank = i + 1;
          prevPercent = row.percent;
        }
        return {
          rank,
          playerId: row.player_id,
          playerName: row.name,
          percent: row.percent,
          grade: row.grade,
          maxCombo: row.max_combo,
          failed: row.failed,
          at: Number(row.updated_at),
        };
      }),
      total: totals[0]?.n ?? 0,
    };
  }
}
