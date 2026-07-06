/**
 * POST /api/scores — serverless score submission (see api/_lib.mjs).
 * Body/response contract matches the standalone server exactly, so the game
 * client can't tell the deployments apart.
 */

import { boardView, cors, redis, redisEnv } from './_lib.mjs';
import { validScore } from '../server/validate.mjs';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(404).json({ error: 'not found' });
  if (!redisEnv()) return res.status(503).json({ error: 'no storage configured' });

  const score = validScore(req.body);
  if (!score) return res.status(400).json({ error: 'bad score' });

  const key = `lb:${score.chartHash}`;
  try {
    // ZADD GT CH: adds the player or raises their score, atomically — the
    // "keep the best" merge without a read-modify-write race. `changed` = 1
    // when this run is a new entry or a new best.
    const [changed] = await redis([
      ['ZADD', key, 'GT', 'CH', String(score.percent), score.player],
      ['HINCRBY', `${key}:plays`, score.player, '1'],
    ]);
    if (changed === 1) {
      await redis([
        [
          'HSET',
          `${key}:meta`,
          score.player,
          JSON.stringify({ grade: score.grade, maxCombo: score.maxCombo, at: Date.now() }),
        ],
      ]);
    }
    return res.status(200).json(await boardView(score.chartHash, score.player));
  } catch (err) {
    console.error('[leaderboard] submit failed:', err);
    return res.status(502).json({ error: 'storage unavailable' });
  }
}
