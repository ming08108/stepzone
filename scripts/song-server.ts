#!/usr/bin/env node
/**
 * Standalone notefield song server — the same library served by the dev server
 * (see the `songs` plugin in vite.config.ts), but as its own process for sharing
 * a library over the network or serving a production build.
 *
 *   node scripts/song-server.ts [songsDir] [port]      (Node ≥ 22.6, strips types)
 *   npm run song-server -- [songsDir] [port]
 *
 * Defaults: songsDir = $SONGS_DIR or "C:/Games/ITGmania/Songs", port = 8760.
 * When you run notefield's own dev server your local library loads automatically
 * — this is only needed to serve a library to *other* machines.
 */
import { createServer } from 'node:http';
import type { RemoteCatalog } from '../src/io/catalog';
import { MIME, safePath, scanCatalog, sendFile } from './songLibrary.ts';

const ROOT: string = (
  process.argv[2] ||
  process.env.SONGS_DIR ||
  'C:/Games/ITGmania/Songs'
).replace(/[\\/]+$/, '');
const PORT = Number(process.argv[3] || process.env.PORT || 8760);

let cache: RemoteCatalog | null = null;
let cacheAt = 0;
function catalog(): RemoteCatalog {
  const now = Date.now();
  if (cache && now - cacheAt < 60_000) return cache;
  cache = scanCatalog(ROOT);
  cacheAt = now;
  return cache;
}

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const path = (req.url || '/').split('?')[0];
  if (path === '/catalog.json' || path === '/') {
    const body = JSON.stringify(catalog());
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  const file = safePath(ROOT, path);
  if (!file) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  sendFile(req, res, file);
}).listen(PORT, () => {
  const n = catalog().count;
  console.log('notefield song server');
  console.log(`  serving ${ROOT}`);
  console.log(`  ${n} songs found`);
  console.log(`  → paste this into notefield: http://localhost:${PORT}/catalog.json`);
});
