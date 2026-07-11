/**
 * Neon Postgres ScoreStore — the production store behind api/scores.ts.
 * Uses Neon's HTTP driver (one fetch per statement, no pooling to manage),
 * which fits Vercel Functions. Schema bootstraps lazily on the first call of
 * a cold start (CREATE TABLE IF NOT EXISTS is cheap and idempotent).
 *
 * Merge/rank semantics live in net/scoreStore.ts (mergeStoredBest) so this
 * store and the in-memory one can never disagree; SQL here is only
 * read-row / write-row / count-better. Races between concurrent submits are
 * benign at this scale (worst case: a lost plays increment).
 *
 * Server-only: imported by api/scores.ts, never by client code.
 */

import { neon } from '@neondatabase/serverless';
import type { GhostFrame, LeaderboardResponse, SubmitScoreRequest } from './protocol';
import { rateKey } from './protocol';
import type { ScoreStore, StoredBest, SubmitOutcome } from './scoreStore';
import { mergeStoredBest } from './scoreStore';

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
     PRIMARY KEY (chart_hash, rate_key, player_id)
   )`,
  // Databases bootstrapped before the ghost column existed.
  `ALTER TABLE net_scores ADD COLUMN IF NOT EXISTS ghost JSONB`,
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
  counts: Record<number, number>;
  hold_counts: Record<number, number>;
  plays: number;
  updated_at: string | number;
  ghost: GhostFrame[] | null;
}

function toStoredBest(row: ScoreRow): StoredBest {
  const best: StoredBest = {
    playerId: row.player_id,
    playerName: row.name,
    result: {
      percent: row.percent,
      grade: row.grade,
      maxCombo: row.max_combo,
      failed: row.failed,
      counts: row.counts,
      holdCounts: row.hold_counts,
    },
    plays: row.plays,
    updatedAt: Number(row.updated_at),
  };
  if (row.ghost && row.ghost.length > 0) best.ghost = row.ghost;
  return best;
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

    // Independent statements (the SELECT's joined p.name is never read below —
    // mergeStoredBest always takes req.playerName), so they run concurrently.
    const [, prevRowsRaw] = await Promise.all([
      sql.query(`UPDATE net_players SET name = $2 WHERE player_id = $1`, [
        req.playerId,
        req.playerName,
      ]),
      sql.query(
        `SELECT s.player_id, p.name, s.percent, s.grade, s.max_combo, s.failed,
                s.counts, s.hold_counts, s.plays, s.updated_at, s.ghost
         FROM net_scores s JOIN net_players p USING (player_id)
         WHERE s.chart_hash = $1 AND s.rate_key = $2 AND s.player_id = $3`,
        [req.chart.chartHash, rk, req.playerId],
      ),
    ]);
    const prevRows = prevRowsRaw as unknown as ScoreRow[];
    const { next, isPersonalBest } = mergeStoredBest(
      prevRows[0] ? toStoredBest(prevRows[0]) : undefined,
      req,
      now,
    );

    await sql.query(
      `INSERT INTO net_scores (chart_hash, rate_key, player_id, percent, grade, max_combo,
                               failed, counts, hold_counts, chart_meta, plays, updated_at,
                               ghost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (chart_hash, rate_key, player_id) DO UPDATE SET
         percent = EXCLUDED.percent, grade = EXCLUDED.grade,
         max_combo = EXCLUDED.max_combo, failed = EXCLUDED.failed,
         counts = EXCLUDED.counts, hold_counts = EXCLUDED.hold_counts,
         chart_meta = EXCLUDED.chart_meta, plays = EXCLUDED.plays,
         updated_at = EXCLUDED.updated_at, ghost = EXCLUDED.ghost`,
      [
        req.chart.chartHash,
        rk,
        req.playerId,
        next.result.percent,
        next.result.grade,
        next.result.maxCombo,
        next.result.failed,
        JSON.stringify(next.result.counts),
        JSON.stringify(next.result.holdCounts),
        JSON.stringify(req.chart),
        next.plays,
        next.updatedAt,
        next.ghost ? JSON.stringify(next.ghost) : null,
      ],
    );

    const better = (await sql.query(
      `SELECT COUNT(*)::int AS n FROM net_scores
       WHERE chart_hash = $1 AND rate_key = $2 AND percent > $3`,
      [req.chart.chartHash, rk, next.result.percent],
    )) as { n: number }[];
    return { ok: true, isPersonalBest, rank: (better[0]?.n ?? 0) + 1 };
  }

  async top(chartHash: string, rate: number, limit: number): Promise<LeaderboardResponse> {
    await this.ensureSchema();
    const rk = rateKey(rate);
    const rows = (await this.sql.query(
      `SELECT s.player_id, p.name, s.percent, s.grade, s.max_combo, s.failed,
              s.counts, s.hold_counts, s.plays, s.updated_at,
              (COALESCE(jsonb_array_length(s.ghost), 0) > 0) AS has_ghost
       FROM net_scores s JOIN net_players p USING (player_id)
       WHERE s.chart_hash = $1 AND s.rate_key = $2
       ORDER BY s.percent DESC, s.updated_at ASC
       LIMIT $3`,
      [chartHash, rk, limit],
    )) as (ScoreRow & { has_ghost: boolean })[];
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
          hasGhost: row.has_ghost,
        };
      }),
      total: totals[0]?.n ?? 0,
    };
  }

  async ghost(chartHash: string, rate: number, playerId: string): Promise<GhostFrame[] | null> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `SELECT ghost FROM net_scores
       WHERE chart_hash = $1 AND rate_key = $2 AND player_id = $3`,
      [chartHash, rateKey(rate), playerId],
    )) as { ghost: GhostFrame[] | null }[];
    const g = rows[0]?.ghost;
    return g && g.length > 0 ? g : null;
  }
}
