/**
 * DDR RL experiments feed — storage behind /api/experiments (GET, public read)
 * and /api/experiments-push (POST, token-authed). Training boxes self-report
 * metrics with a per-fleet push token; nobody holds account credentials.
 *
 * One row per experiment (upserted by id). The row keeps `name` as a column
 * and everything else — metrics, natural-rate history, stream URL, box info —
 * in a `payload` JSONB blob, so the pusher schema can grow without migrations.
 *
 * Neon Postgres when DATABASE_URL is set (schema bootstraps lazily, like
 * pgScoreStore); an in-memory fallback keeps dev/preview alive. Server-only:
 * imported by the api/experiments*.js bundles, never by client code.
 */

import { neon } from '@neondatabase/serverless';

type Sql = ReturnType<typeof neon>;

/** The metrics + identity a training box pushes (validated in experimentsApi). */
export interface ExpPayload {
  metrics: Record<string, number>;
  history_natural: number[];
  ws_public: string | null;
  box: { gpu: string; dph: number };
}

/** A stored experiment row (payload flattened alongside id/name/updatedAt). */
export interface ExpRow {
  id: string;
  name: string;
  payload: ExpPayload;
  updatedAt: number; // epoch ms
}

export interface ExperimentsStore {
  upsert(id: string, name: string, payload: ExpPayload, now: number): Promise<void>;
  /** All rows updated at or after `sinceMs`, newest first. */
  listRecent(sinceMs: number): Promise<ExpRow[]>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS experiments (
     id         TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     payload    JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS experiments_updated
     ON experiments (updated_at DESC)`,
];

export class PgExperimentsStore implements ExperimentsStore {
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

  async upsert(id: string, name: string, payload: ExpPayload, now: number): Promise<void> {
    await this.ensureSchema();
    await this.sql.query(
      `INSERT INTO experiments (id, name, payload, updated_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         payload = EXCLUDED.payload,
         updated_at = EXCLUDED.updated_at`,
      [id, name, JSON.stringify(payload), now],
    );
  }

  async listRecent(sinceMs: number): Promise<ExpRow[]> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `SELECT id, name, payload, EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms
       FROM experiments
       WHERE updated_at >= to_timestamp($1 / 1000.0)
       ORDER BY updated_at DESC`,
      [sinceMs],
    )) as { id: string; name: string; payload: ExpPayload; updated_ms: string | number }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      payload: r.payload,
      updatedAt: Number(r.updated_ms),
    }));
  }
}

/** In-memory fallback for dev/preview (no DATABASE_URL). Not durable. */
export class MemoryExperimentsStore implements ExperimentsStore {
  private readonly rows = new Map<string, ExpRow>();

  async upsert(id: string, name: string, payload: ExpPayload, now: number): Promise<void> {
    this.rows.set(id, { id, name, payload, updatedAt: now });
  }

  async listRecent(sinceMs: number): Promise<ExpRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.updatedAt >= sinceMs)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
