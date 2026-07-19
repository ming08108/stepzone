/**
 * Vercel Function source: /api/experiments-push — a training box self-reports
 * its metrics here (docs: PUSH architecture for the DDR RL fleet). Thin entry;
 * routing/validation live in experimentsApi.ts so tests hit the same handlers.
 *
 * NOT deployed as-is: scripts/buildApi.mjs esbuild-bundles this into the
 * self-contained api/experiments-push.js that Vercel runs (see scoresEntry.ts
 * for why a raw TS entry reaching outside api/ crashes at runtime).
 *
 * Fail-closed: the whole experiments feed is gated on EXPERIMENTS_PUSH_TOKEN.
 * Until that env var is set in Vercel, this returns 503 with a clear message —
 * a leaked token only ever lets someone POST fake metrics, nothing else, and
 * training boxes hold ONLY this token (no DATABASE_URL, no account creds).
 * Storage: Neon Postgres when DATABASE_URL is set (schema self-bootstraps),
 * else an in-memory store keeps previews alive (not durable, by design).
 */

import { createPushHandler } from './experimentsApi';
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
  ? createPushHandler(
      databaseUrl ? new PgExperimentsStore(databaseUrl) : new MemoryExperimentsStore(),
      token,
    )
  : null;

export const POST = handler ? handler.POST : unavailable;
