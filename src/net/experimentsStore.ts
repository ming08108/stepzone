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

/** Honest-heartbeat object a box attaches to each push (v2 phase 1; additive).
 *  Distinct signals let the server tell "running" from "hung trainer on a live
 *  box" — the silent-staleness bug age-only status could never catch. All fields
 *  optional so an older pusher (no `hb`) still validates and falls back to age. */
export interface ExpHeartbeat {
  /** `pgrep -f '[s]cripts/train.py'` on the box; null when the box couldn't tell. */
  trainer_alive: boolean | null;
  /** mtime (unix seconds) of the newest TB events file — frozen ⇒ trainer hung. */
  tb_last_write: number | null;
  /** the run's current step (mirrors metrics.step; kept explicit in the hb). */
  step: number | null;
  /** sha1 (short hex) of the newest run's params/env.yaml, for drift detection. */
  config_hash: string | null;
  /** true when the run is intentionally stopped (idle, not failed) ⇒ status
   *  "paused". Absent/null on pushers that don't report it. */
  paused?: boolean | null;
}

/** The metrics + identity a training box pushes (validated in experimentsApi). */
export interface ExpPayload {
  metrics: Record<string, number>;
  history_natural: number[];
  ws_public: string | null;
  box: { gpu: string; dph: number };
  /** One-line "what is this run trying to do", pushed from the box's
   *  experiment.json `desc` (not hardcoded); null when the box doesn't set it. */
  desc?: string | null;
  /** Present when the pusher is v2-aware; absent on legacy pushers. */
  hb?: ExpHeartbeat | null;
}

/** A stored experiment row (payload flattened alongside id/name/updatedAt).
 *  `lastStep`/`stepChangedAt` are server-tracked across pushes so the list
 *  endpoint can see step *progress*, not just push freshness. */
export interface ExpRow {
  id: string;
  name: string;
  payload: ExpPayload;
  updatedAt: number; // epoch ms
  lastStep: number | null; // last step we saw for this id
  stepChangedAt: number | null; // epoch ms the step last advanced
}

/** One archived time-series sample (append-only; one per distinct step). */
export interface ExpSample {
  expId: string;
  ts: number; // epoch ms
  step: number | null;
  metrics: Record<string, number>;
}

export interface SampleQuery {
  ids: string[];
  fromStep?: number | null;
  toStep?: number | null;
  limit?: number; // cap on raw rows fetched (pre-bucketing)
}

export interface ExperimentsStore {
  /** Upsert the row; returns whether `step` advanced vs the stored value (drives
   *  the append to experiment_samples). `step` is resolved by the caller from
   *  the heartbeat/metrics. */
  upsert(
    id: string,
    name: string,
    payload: ExpPayload,
    step: number | null,
    now: number,
  ): Promise<{ stepChanged: boolean }>;
  /** All rows updated at or after `sinceMs`, newest first. */
  listRecent(sinceMs: number): Promise<ExpRow[]>;
  /** Append one time-series sample (idempotent on (exp_id, ts)). */
  insertSample(sample: ExpSample): Promise<void>;
  /** Raw samples for the history endpoint, ordered by (exp_id, step). */
  listSamples(q: SampleQuery): Promise<ExpSample[]>;
}

const SAMPLE_FETCH_CAP = 20_000;

/** Whether a value is a usable non-empty string. COALESCE guard: a blank/omitted
 *  desc/name/ws_public from a push must never wipe a previously-stored good value
 *  (a booting or minimal pusher would otherwise erase the run's description or its
 *  stream URL mid-run). */
function nonEmptyStr(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Merge a fresh push payload over the stored one, keeping the stored `desc` and
 *  `ws_public` whenever the incoming push omits/blanks them. Used by the Memory
 *  store; the Pg store does the equivalent COALESCE atomically in SQL. */
function coalescePayload(prev: ExpPayload | null, next: ExpPayload): ExpPayload {
  if (!prev) return next;
  return {
    ...next,
    desc: nonEmptyStr(next.desc) ? next.desc : (prev.desc ?? next.desc ?? null),
    ws_public: nonEmptyStr(next.ws_public) ? next.ws_public : (prev.ws_public ?? null),
  };
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
  // v2 phase 1: server-side step-progress tracking (additive columns).
  `ALTER TABLE experiments ADD COLUMN IF NOT EXISTS last_step BIGINT`,
  `ALTER TABLE experiments ADD COLUMN IF NOT EXISTS step_changed_at TIMESTAMPTZ`,
  // v2 phase 2: append-only time-series (schema-free metrics, like the row payload).
  `CREATE TABLE IF NOT EXISTS experiment_samples (
     exp_id  TEXT        NOT NULL,
     ts      TIMESTAMPTZ NOT NULL,
     step    BIGINT,
     metrics JSONB       NOT NULL,
     PRIMARY KEY (exp_id, ts)
   )`,
  `CREATE INDEX IF NOT EXISTS experiment_samples_exp_step
     ON experiment_samples (exp_id, step)`,
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

  async upsert(
    id: string,
    name: string,
    payload: ExpPayload,
    step: number | null,
    now: number,
  ): Promise<{ stepChanged: boolean }> {
    await this.ensureSchema();
    // step_changed_at advances to `now` only when the step differs from the
    // stored one (IS DISTINCT FROM handles nulls), so a frozen/hung box stops
    // updating it and the list endpoint can measure the freeze. We RETURN
    // whether that happened this push (step_changed_at == updated_at) so the
    // caller knows to append a samples row.
    // COALESCE guard (atomic, race-free): a push with a blank/omitted name, desc,
    // or ws_public must not overwrite a previously-stored non-empty value. name is
    // a column; desc/ws_public live inside the JSONB payload, so we take the new
    // payload and override just those two keys back to the stored value when the
    // incoming one is blank (btrim handles whitespace-only). Everything else on
    // the payload is replaced wholesale as before.
    const rows = (await this.sql.query(
      `INSERT INTO experiments (id, name, payload, updated_at, last_step, step_changed_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, to_timestamp($4 / 1000.0))
       ON CONFLICT (id) DO UPDATE SET
         name = CASE
           WHEN btrim(COALESCE(EXCLUDED.name, '')) <> '' THEN EXCLUDED.name
           ELSE experiments.name
         END,
         payload = EXCLUDED.payload
           || jsonb_build_object('desc', CASE
                WHEN btrim(COALESCE(EXCLUDED.payload->>'desc', '')) <> ''
                  THEN EXCLUDED.payload->'desc'
                ELSE experiments.payload->'desc'
              END)
           || jsonb_build_object('ws_public', CASE
                WHEN btrim(COALESCE(EXCLUDED.payload->>'ws_public', '')) <> ''
                  THEN EXCLUDED.payload->'ws_public'
                ELSE experiments.payload->'ws_public'
              END),
         updated_at = EXCLUDED.updated_at,
         last_step = EXCLUDED.last_step,
         step_changed_at = CASE
           WHEN experiments.last_step IS DISTINCT FROM EXCLUDED.last_step
             THEN EXCLUDED.updated_at
           ELSE experiments.step_changed_at
         END
       RETURNING (step_changed_at = updated_at) AS step_changed`,
      [id, name, JSON.stringify(payload), now, step],
    )) as { step_changed: boolean }[];
    return { stepChanged: Boolean(rows[0]?.step_changed) };
  }

  async listRecent(sinceMs: number): Promise<ExpRow[]> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `SELECT id, name, payload,
              EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms,
              last_step,
              EXTRACT(EPOCH FROM step_changed_at) * 1000 AS step_changed_ms
       FROM experiments
       WHERE updated_at >= to_timestamp($1 / 1000.0)
       ORDER BY updated_at DESC`,
      [sinceMs],
    )) as {
      id: string;
      name: string;
      payload: ExpPayload;
      updated_ms: string | number;
      last_step: string | number | null;
      step_changed_ms: string | number | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      payload: r.payload,
      updatedAt: Number(r.updated_ms),
      lastStep: r.last_step == null ? null : Number(r.last_step),
      stepChangedAt: r.step_changed_ms == null ? null : Number(r.step_changed_ms),
    }));
  }

  async insertSample(sample: ExpSample): Promise<void> {
    await this.ensureSchema();
    await this.sql.query(
      `INSERT INTO experiment_samples (exp_id, ts, step, metrics)
       VALUES ($1, to_timestamp($2 / 1000.0), $3, $4)
       ON CONFLICT (exp_id, ts) DO NOTHING`,
      [sample.expId, sample.ts, sample.step, JSON.stringify(sample.metrics)],
    );
  }

  async listSamples(q: SampleQuery): Promise<ExpSample[]> {
    await this.ensureSchema();
    const limit = Math.min(q.limit ?? SAMPLE_FETCH_CAP, SAMPLE_FETCH_CAP);
    const rows = (await this.sql.query(
      `SELECT exp_id, EXTRACT(EPOCH FROM ts) * 1000 AS ts_ms, step, metrics
       FROM experiment_samples
       WHERE exp_id = ANY($1)
         AND ($2::bigint IS NULL OR step >= $2)
         AND ($3::bigint IS NULL OR step <= $3)
       ORDER BY exp_id, step ASC NULLS LAST, ts ASC
       LIMIT $4`,
      [q.ids, q.fromStep ?? null, q.toStep ?? null, limit],
    )) as {
      exp_id: string;
      ts_ms: string | number;
      step: string | number | null;
      metrics: Record<string, number>;
    }[];
    return rows.map((r) => ({
      expId: r.exp_id,
      ts: Number(r.ts_ms),
      step: r.step == null ? null : Number(r.step),
      metrics: r.metrics ?? {},
    }));
  }
}

/** In-memory fallback for dev/preview (no DATABASE_URL). Not durable. */
export class MemoryExperimentsStore implements ExperimentsStore {
  private readonly rows = new Map<string, ExpRow>();
  private readonly samples: ExpSample[] = [];

  async upsert(
    id: string,
    name: string,
    payload: ExpPayload,
    step: number | null,
    now: number,
  ): Promise<{ stepChanged: boolean }> {
    const prev = this.rows.get(id);
    const stepChanged = !prev || prev.lastStep !== step;
    // Mirror the Pg store's COALESCE guard: a blank name/desc/ws_public never
    // clobbers a stored value.
    this.rows.set(id, {
      id,
      name: nonEmptyStr(name) ? name : (prev?.name ?? name),
      payload: coalescePayload(prev?.payload ?? null, payload),
      updatedAt: now,
      lastStep: step,
      stepChangedAt: stepChanged ? now : (prev?.stepChangedAt ?? now),
    });
    return { stepChanged };
  }

  async listRecent(sinceMs: number): Promise<ExpRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.updatedAt >= sinceMs)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async insertSample(sample: ExpSample): Promise<void> {
    if (this.samples.some((s) => s.expId === sample.expId && s.ts === sample.ts)) return;
    this.samples.push(sample);
  }

  async listSamples(q: SampleQuery): Promise<ExpSample[]> {
    const ids = new Set(q.ids);
    return this.samples
      .filter((s) => ids.has(s.expId))
      .filter((s) => q.fromStep == null || (s.step != null && s.step >= q.fromStep!))
      .filter((s) => q.toStep == null || (s.step != null && s.step <= q.toStep!))
      .sort(
        (a, b) => a.expId.localeCompare(b.expId) || (a.step ?? 0) - (b.step ?? 0) || a.ts - b.ts,
      )
      .slice(0, Math.min(q.limit ?? SAMPLE_FETCH_CAP, SAMPLE_FETCH_CAP));
  }
}
