/**
 * The scores API handlers — Web-standard (Request -> Response), so the same
 * code runs as a Vercel Function (api/scores.ts) and under vitest by calling
 * the handlers directly with constructed Requests. All input is hostile:
 * everything goes through net/protocol.ts validators; secrets are hashed
 * before they reach the store.
 *
 * Routes (mounted at /api/scores):
 *   GET  ?chartHash=..&rate=1&limit=20        -> LeaderboardResponse
 *   GET  ?chartHash=..&rate=1&ghostOf=player  -> { ghost } (404 if none)
 *   POST SubmitScoreRequest                   -> SubmitScoreResponse
 */

import { error, json } from './httpResponse';
import { parseSubmitScoreRequest, type SubmitScoreRequest } from './protocol';
import { verifyReplay } from '../gameplay/replayVerify';
import type { ScoreStore } from './scoreStore';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** A submission now carries the full replay (up to MAX_REPLAY_EVENTS); a long
 *  run's log dominates the body, so the ceiling is generous. Anything past it
 *  is not a plausible score. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** A replay must span at least this long once the play has real length. */
const MIN_REPLAY_SPAN_SECONDS = 5;
/** Below this many judged taps, a play is too short to demand a span. */
const MIN_TAPS_FOR_SPAN = 20;

/**
 * A cheap pre-filter before the (heavier) re-simulation: an empty or instant
 * replay can't have played anything, so reject it without rebuilding the chart.
 * The authoritative check is verifyReplay — this only trims obvious garbage.
 * Returns a rejection reason, or null to proceed to re-simulation.
 */
function degenerateReplay(sub: SubmitScoreRequest): string | null {
  if (sub.replay.length === 0) return 'empty replay';
  let firstT = Infinity;
  let lastT = -Infinity;
  let judgedTaps = 0;
  for (let k = 5; k <= 9; k++) judgedTaps += sub.result.counts[k] ?? 0;
  for (const e of sub.replay) {
    if (e.t < firstT) firstT = e.t;
    if (e.t > lastT) lastT = e.t;
  }
  // A play claiming real length must span real time — an instant log is forged.
  if (judgedTaps >= MIN_TAPS_FOR_SPAN && lastT - firstT < MIN_REPLAY_SPAN_SECONDS) {
    return 'replay span too short';
  }
  return null;
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
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
      const degenerate = degenerateReplay(sub);
      if (degenerate) return error(400, 'bad_request', degenerate);
      // The real anti-cheat: re-run the replay against the shipped chart (bound
      // to the board by content hash) and RANK ON WHAT IT PRODUCES, not on the
      // client's self-reported result. A forged score is scored as it plays.
      const verified = verifyReplay(sub.chartData, sub.chart.chartHash, sub.replay, sub.musicRate);
      if ('reject' in verified) return error(400, 'bad_request', verified.reject);
      const authoritative: SubmitScoreRequest = { ...sub, result: verified.result };
      const outcome = await store.submit(authoritative, await sha256Hex(sub.secret), now());
      if (!outcome.ok) return error(403, outcome.code, 'secret does not match this playerId');
      return json(200, { ok: true, rank: outcome.rank, isPersonalBest: outcome.isPersonalBest });
    },
  };
}
