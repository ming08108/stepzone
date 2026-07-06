/**
 * Score-submission validation shared by both leaderboard backends: the
 * standalone Node server (server/leaderboard.mjs, LAN/self-hosted) and the
 * Vercel serverless functions (api/, Upstash Redis). One definition of what a
 * well-formed submission is, so the two deployments can't drift.
 */

export const TOP_N = 10;

export const isHash = (v) => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Sanitize an inbound player name: control chars out, trimmed, 1-16 chars. */
export function cleanPlayer(v) {
  if (typeof v !== 'string') return null;
  const p = [...v]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 16);
  return p.length > 0 ? p : null;
}

/** Validate a submission body; a clean {chartHash, player, percent, grade, maxCombo} or null. */
export function validScore(body) {
  if (typeof body !== 'object' || body === null) return null;
  const player = cleanPlayer(body.player);
  if (
    !isHash(body.chartHash) ||
    !player ||
    !isNum(body.percent) ||
    body.percent < 0 ||
    body.percent > 1 ||
    typeof body.grade !== 'string' ||
    body.grade.length > 4 ||
    !isNum(body.maxCombo) ||
    body.maxCombo < 0
  ) {
    return null;
  }
  return {
    chartHash: body.chartHash,
    player,
    percent: body.percent,
    grade: body.grade,
    maxCombo: Math.floor(body.maxCombo),
  };
}
