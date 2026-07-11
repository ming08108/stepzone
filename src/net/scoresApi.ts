/**
 * The scores API handlers — Web-standard (Request -> Response), so the same
 * code runs as a Vercel Function (api/scores.ts) and under vitest by calling
 * the handlers directly with constructed Requests. All input is hostile:
 * everything goes through net/protocol.ts validators; secrets are hashed
 * before they reach the store.
 *
 * Routes (mounted at /api/scores):
 *   GET  ?chartHash=..&rate=1&limit=20        -> LeaderboardResponse
 *   GET  ?chartHash=..&rate=1&ghostOf=player  -> GhostResponse (404 if none)
 *   POST SubmitScoreRequest                   -> SubmitScoreResponse
 */

import { parseSubmitScoreRequest } from './protocol';
import type { ScoreStore } from './scoreStore';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Submissions are small even with a full ghost timeline (~45 KB at the
 *  frame cap); anything bigger than this is not a score. */
const MAX_BODY_BYTES = 128 * 1024;

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function error(status: number, code: string, message: string): Response {
  return json(status, { ok: false, code, message });
}

export interface ScoresHandlers {
  GET(req: Request): Promise<Response>;
  POST(req: Request): Promise<Response>;
}

export function createHandlers(store: ScoreStore, now: () => number = Date.now): ScoresHandlers {
  return {
    async GET(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const chartHash = url.searchParams.get('chartHash');
      if (!chartHash || chartHash.length > 64) {
        return error(400, 'bad_request', 'chartHash is required');
      }
      const rate = Number(url.searchParams.get('rate') ?? '1');
      if (!Number.isFinite(rate) || rate < 0.5 || rate > 3) {
        return error(400, 'bad_request', 'rate out of range');
      }
      const ghostOf = url.searchParams.get('ghostOf');
      if (ghostOf) {
        if (ghostOf.length > 64) return error(400, 'bad_request', 'ghostOf too long');
        const ghost = await store.ghost(chartHash, rate, ghostOf);
        if (!ghost) return error(404, 'not_found', 'no ghost stored for this player');
        return json(200, { ghost });
      }
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(
          1,
          Math.floor(Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT) || DEFAULT_LIMIT),
        ),
      );
      return json(200, await store.top(chartHash, rate, limit));
    },

    async POST(req: Request): Promise<Response> {
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return error(413, 'too_large', 'body too large');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return error(400, 'bad_request', 'invalid JSON');
      }
      const sub = parseSubmitScoreRequest(parsed);
      if (!sub) return error(400, 'bad_request', 'invalid submission');
      const outcome = await store.submit(sub, await sha256Hex(sub.secret), now());
      if (!outcome.ok) return error(403, outcome.code, 'secret does not match this playerId');
      return json(200, { ok: true, rank: outcome.rank, isPersonalBest: outcome.isPersonalBest });
    },
  };
}
