/**
 * Vercel Function source: /api/versus — WebRTC signaling for live versus
 * (docs/VERSUS.md). Bundled to api/versus.js by scripts/buildApi.mjs (see
 * scoresEntry.ts for why). Handshake state must survive across serverless
 * invocations, so this endpoint requires the database; without DATABASE_URL
 * it reports unavailable (the client shows versus as offline). Dev servers
 * get an in-memory store from the Vite middleware instead.
 */

import { createSignalHandlers } from './signalApi';
import { PgSignalStore } from './pgSignalStore';

const databaseUrl = process.env.DATABASE_URL;
const handlers = databaseUrl ? createSignalHandlers(new PgSignalStore(databaseUrl)) : null;

const unavailable = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({ ok: false, code: 'no_database', message: 'versus needs DATABASE_URL' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ),
  );

export const GET = handlers ? handlers.GET : unavailable;
export const POST = handlers ? handlers.POST : unavailable;
