/**
 * Shared plumbing for the serverless leaderboard functions (api/scores.mjs,
 * api/scores/[hash].mjs) — the Vercel deployment of the same API the
 * standalone server (server/leaderboard.mjs) serves.
 *
 * Serverless has no process lifetime and no shared filesystem, so state lives
 * in Upstash Redis (Vercel Marketplace storage), reached over its REST API —
 * plain fetch, no npm dependency. A chart's board is a sorted set
 * (lb:{hash}: member = player, score = best percent — ZADD GT does the
 * "keep the best" merge atomically), with grade/combo details in
 * lb:{hash}:meta and play counts in lb:{hash}:plays.
 *
 * Env (either pair; both are injected by the Upstash/KV integrations):
 *   KV_REST_API_URL + KV_REST_API_TOKEN
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 * Unconfigured -> the routes answer 503 and the game silently shows nothing.
 */

import { TOP_N } from '../server/validate.mjs';

export function redisEnv() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

/** Run a pipeline of redis commands; array of results (throws on transport error). */
export async function redis(commands) {
  const env = redisEnv();
  const res = await fetch(`${env.url}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.token}` },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  const out = await res.json();
  return out.map((r) => r.result);
}

export function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

/**
 * Assemble the LeaderboardView the client expects: total, the asking player's
 * 1-based rank, and the top entries with their details.
 */
export async function boardView(chartHash, player) {
  const key = `lb:${chartHash}`;
  const [total, rank, flat] = await redis([
    ['ZCARD', key],
    ...(player ? [['ZREVRANK', key, player]] : [['ECHO', 'x']]),
    ['ZRANGE', key, '0', String(TOP_N - 1), 'REV', 'WITHSCORES'],
  ]);
  // flat = [player, score, player, score, ...]
  const names = [];
  const percents = [];
  for (let i = 0; i < flat.length; i += 2) {
    names.push(flat[i]);
    percents.push(Number(flat[i + 1]));
  }
  let metas = [];
  let plays = [];
  if (names.length > 0) {
    [metas, plays] = await redis([
      ['HMGET', `${key}:meta`, ...names],
      ['HMGET', `${key}:plays`, ...names],
    ]);
  }
  return {
    total: total ?? 0,
    rank: typeof rank === 'number' ? rank + 1 : null,
    entries: names.map((name, i) => {
      let meta = {};
      try {
        meta = JSON.parse(metas[i] ?? '{}');
      } catch {
        // corrupt meta — entry still renders from the sorted set
      }
      return {
        rank: i + 1,
        player: name,
        percent: percents[i],
        grade: typeof meta.grade === 'string' ? meta.grade : '?',
        maxCombo: typeof meta.maxCombo === 'number' ? meta.maxCombo : 0,
        plays: Number(plays[i]) || 0,
      };
    }),
  };
}
