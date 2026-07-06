#!/usr/bin/env node
/**
 * STEPZONE leaderboard server — a tiny, zero-dependency score board so a
 * group of players can share rankings. Charts are identified by their content
 * hash (src/song/chartHash.ts), so everyone's copy of a song maps to the same
 * board no matter where it lives on disk or what the file is called.
 *
 * Run:            npm run leaderboard          (defaults to port 8791)
 *                 PORT=9000 npm run leaderboard
 * Point the game: OPTIONS → LEADERBOARD → SERVER URL, e.g. http://host:8791
 *
 * API (JSON, permissive CORS — this is a friends-and-LAN service, not a bank):
 *   POST /api/scores                 { chartHash, player, percent, grade,
 *                                      maxCombo }  → LeaderboardView
 *   GET  /api/scores/:hash?player=P               → LeaderboardView
 *
 * LeaderboardView: { total, rank|null (the named player's), entries: top 10
 * of { rank, player, percent, grade, maxCombo, plays } by percent }.
 *
 * One best entry per (chart, player), merged like the local score store:
 * percent/maxCombo as maxes, grade follows the better percent, plays counts
 * submissions. State persists to a JSON file with a debounced write.
 */

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOP_N = 10;
const SAVE_DEBOUNCE_MS = 500;

const isHash = (v) => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Sanitize an inbound player name: control chars out, trimmed, 1-16 chars. */
function cleanPlayer(v) {
  if (typeof v !== 'string') return null;
  const p = [...v]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 16);
  return p.length > 0 ? p : null;
}

/** Create the leaderboard HTTP server. `dataFile: null` keeps state in memory. */
export function createLeaderboard({ dataFile = null } = {}) {
  /** chartHash -> player -> { percent, grade, maxCombo, plays, at } */
  let boards = new Map();
  let saveTimer = null;

  async function load() {
    if (!dataFile) return;
    try {
      const parsed = JSON.parse(await readFile(dataFile, 'utf8'));
      boards = new Map(Object.entries(parsed).map(([k, v]) => [k, new Map(Object.entries(v))]));
    } catch {
      // first run (no file) or corrupt data — start empty
    }
  }

  function scheduleSave() {
    if (!dataFile || saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      const obj = Object.fromEntries([...boards].map(([k, v]) => [k, Object.fromEntries(v)]));
      try {
        await mkdir(dirname(dataFile), { recursive: true });
        await writeFile(dataFile, JSON.stringify(obj));
      } catch (err) {
        console.warn('[leaderboard] save failed:', err.message);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  /** Ranked view of one chart's board, from `player`'s perspective. */
  function view(chartHash, player) {
    const board = boards.get(chartHash) ?? new Map();
    const ranked = [...board.entries()]
      .map(([name, s]) => ({ player: name, ...s }))
      .sort((a, b) => b.percent - a.percent || a.at - b.at);
    const idx = player ? ranked.findIndex((e) => e.player === player) : -1;
    return {
      total: ranked.length,
      rank: idx >= 0 ? idx + 1 : null,
      entries: ranked.slice(0, TOP_N).map((e, i) => ({
        rank: i + 1,
        player: e.player,
        percent: e.percent,
        grade: e.grade,
        maxCombo: e.maxCombo,
        plays: e.plays,
      })),
    };
  }

  /** Merge one submission into the board (same policy as app/scores mergeBest). */
  function submit({ chartHash, player, percent, grade, maxCombo }) {
    let board = boards.get(chartHash);
    if (!board) boards.set(chartHash, (board = new Map()));
    const prev = board.get(player);
    board.set(player, {
      percent: Math.max(percent, prev?.percent ?? 0),
      grade: prev && prev.percent >= percent ? prev.grade : grade,
      maxCombo: Math.max(maxCombo, prev?.maxCombo ?? 0),
      plays: (prev?.plays ?? 0) + 1,
      at: prev && prev.percent >= percent ? prev.at : Date.now(),
    });
    scheduleSave();
  }

  const json = (res, status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return json(res, 204, {});

    if (req.method === 'POST' && url.pathname === '/api/scores') {
      let body;
      try {
        const chunks = [];
        for await (const c of req) {
          chunks.push(c);
          if (chunks.reduce((n, b) => n + b.length, 0) > 4096) throw new Error('too large');
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(res, 400, { error: 'bad body' });
      }
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
        return json(res, 400, { error: 'bad score' });
      }
      submit({
        chartHash: body.chartHash,
        player,
        percent: body.percent,
        grade: body.grade,
        maxCombo: Math.floor(body.maxCombo),
      });
      return json(res, 200, view(body.chartHash, player));
    }

    const get = url.pathname.match(/^\/api\/scores\/([0-9a-f]{16})$/);
    if (req.method === 'GET' && get) {
      return json(res, 200, view(get[1], cleanPlayer(url.searchParams.get('player') ?? '')));
    }

    return json(res, 404, { error: 'not found' });
  });

  server.ready = load();
  return server;
}

// Run directly: serve on PORT (default 8791), persisting next to this file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8791;
  const dataFile = new URL('./leaderboard-data.json', import.meta.url);
  const server = createLeaderboard({ dataFile: fileURLToPath(dataFile) });
  await server.ready;
  server.listen(port, () => {
    console.log(`stepzone leaderboard listening on http://localhost:${port}`);
    console.log(`scores persist to ${fileURLToPath(dataFile)}`);
  });
}
