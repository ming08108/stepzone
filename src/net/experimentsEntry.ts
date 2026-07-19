/**
 * Vercel Function source: /api/experiments — public read of the DDR RL fleet
 * feed for the ?experiments dashboard (metrics only, no auth). Thin entry;
 * status computation lives in experimentsApi.ts. Bundled to api/experiments.js
 * by scripts/buildApi.mjs (see scoresEntry.ts for why).
 *
 * Fail-closed like the push endpoint: the feed is gated on EXPERIMENTS_PUSH_TOKEN
 * so the whole feature is off (503) until Ming sets the secret in Vercel. Once
 * on, it returns {generated_at, experiments:[...]} — the exact shape the
 * dashboard already reads from the local experiments.json — for rows updated
 * within 24 h, each tagged running/stale/dead by age.
 */

import { createListHandler } from './experimentsApi';
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
  ? createListHandler(
      databaseUrl ? new PgExperimentsStore(databaseUrl) : new MemoryExperimentsStore(),
    )
  : null;

export const GET = handler ? handler.GET : unavailable;
