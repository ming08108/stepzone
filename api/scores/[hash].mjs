/**
 * GET /api/scores/:hash?player=NAME — serverless board fetch (see
 * api/_lib.mjs). Response contract matches the standalone server.
 */

import { boardView, cors, redisEnv } from '../_lib.mjs';
import { cleanPlayer, isHash } from '../../server/validate.mjs';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(404).json({ error: 'not found' });
  if (!redisEnv()) return res.status(503).json({ error: 'no storage configured' });

  const hash = req.query.hash;
  if (!isHash(hash)) return res.status(400).json({ error: 'bad hash' });

  try {
    const player = cleanPlayer(String(req.query.player ?? ''));
    return res.status(200).json(await boardView(hash, player));
  } catch (err) {
    console.error('[leaderboard] fetch failed:', err);
    return res.status(502).json({ error: 'storage unavailable' });
  }
}
