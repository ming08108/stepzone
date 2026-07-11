/**
 * Vercel Function source: /api/scores — the async-leaderboard endpoint
 * (docs/ONLINE-MULTIPLAYER.md M1). Thin entry only: routing/validation live
 * in scoresApi.ts so tests exercise the identical handlers.
 *
 * NOT deployed as-is: scripts/buildApi.mjs esbuild-bundles this file into the
 * self-contained api/scores.js that Vercel runs (the Node builder does not
 * bundle imports reaching outside api/, so a raw TS entry there crashes with
 * ERR_MODULE_NOT_FOUND at runtime).
 *
 * Storage: Neon Postgres when DATABASE_URL is set (Vercel Marketplace ->
 * Neon; the schema bootstraps itself). Without it, an in-memory store keeps
 * the endpoint alive for previews — scores then last only as long as the
 * function instance, by design.
 */

import { createHandlers } from './scoresApi';
import { MemoryScoreStore } from './scoreStore';
import { PgScoreStore } from './pgScoreStore';

const databaseUrl = process.env.DATABASE_URL;
const handlers = createHandlers(
  databaseUrl ? new PgScoreStore(databaseUrl) : new MemoryScoreStore(),
);

export const GET = handlers.GET;
export const POST = handlers.POST;
