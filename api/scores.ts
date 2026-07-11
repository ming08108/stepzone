/**
 * Vercel Function: /api/scores — the async-leaderboard endpoint
 * (docs/ONLINE-MULTIPLAYER.md M1). Thin entry only: routing/validation live
 * in src/net/scoresApi.ts so tests exercise the identical handlers.
 *
 * Storage: Neon Postgres when DATABASE_URL is set (Vercel Marketplace ->
 * Neon; the schema bootstraps itself). Without it, an in-memory store keeps
 * the endpoint alive for previews — scores then last only as long as the
 * function instance, by design.
 */

import { createHandlers } from '../src/net/scoresApi';
import { MemoryScoreStore } from '../src/net/scoreStore';
import { PgScoreStore } from '../src/net/pgScoreStore';

const databaseUrl = process.env.DATABASE_URL;
const handlers = createHandlers(
  databaseUrl ? new PgScoreStore(databaseUrl) : new MemoryScoreStore(),
);

export const GET = handlers.GET;
export const POST = handlers.POST;
