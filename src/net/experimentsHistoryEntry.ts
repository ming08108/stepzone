/**
 * Vercel Function source: /api/experiments-history — public read of the DDR RL
 * per-experiment time-series for the dashboard charts (metrics only, no auth).
 * Thin entry; bucketing lives in experimentsApi.ts. Bundled to
 * api/experiments-history.js by scripts/buildApi.mjs (see scoresEntry.ts for why).
 *
 * Fail-closed like the rest of the experiments feed: gated on
 * EXPERIMENTS_PUSH_TOKEN so the endpoint is 503 until the secret is set. Reads the
 * append-only experiment_samples table (populated by the push handler on each
 * step change); falls back to an in-memory store in preview (no DATABASE_URL).
 */

import { createHistoryHandler } from './experimentsApi';
import { MemoryExperimentsStore, PgExperimentsStore } from './experimentsStore';

const token = process.env.EXPERIMENTS_PUSH_TOKEN;
const databaseUrl = process.env.DATABASE_URL;

const unavailable = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        ok: false,
        code: 'no_token',
        message: 'experiments feed disabled: set EXPERIMENTS_PUSH_TOKEN in the environment',
      }),
      { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    ),
  );

const handler = token
  ? createHistoryHandler(
      databaseUrl ? new PgExperimentsStore(databaseUrl) : new MemoryExperimentsStore(),
    )
  : null;

export const GET = handler ? handler.GET : unavailable;
