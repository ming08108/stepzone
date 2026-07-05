#!/usr/bin/env node
/**
 * Standalone stepzone song server — the same library served by the dev server
 * (see the `songs` plugin in vite.config.ts), but as its own process for sharing
 * a library over the network or serving a production build.
 *
 *   node scripts/song-server.ts [songsDir] [port]      (Node ≥ 22.6, strips types)
 *   npm run song-server -- [songsDir] [port]
 *
 * Defaults: songsDir = $SONGS_DIR or "C:/Games/ITGmania/Songs", port = 8760.
 * When you run stepzone's own dev server your local library loads automatically
 * — this is only needed to serve a library to *other* machines.
 */
import { createServer } from 'node:http';
import { createCatalogCache, handleSongRequest, resolveSongsRoot } from './songLibrary.ts';

const ROOT: string = resolveSongsRoot(process.argv[2]);
const PORT = Number(process.argv[3] || process.env.PORT || 8760);
const catalog = createCatalogCache(ROOT);

createServer((req, res) => {
  // CORS layer for cross-origin clients; the shared handler does the rest.
  // (The Vite middleware serves same-origin and doesn't need this.)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  handleSongRequest(req, res, ROOT, catalog);
}).listen(PORT, () => {
  const n = catalog().count;
  console.log('stepzone song server');
  console.log(`  serving ${ROOT}`);
  console.log(`  ${n} songs found`);
  console.log(`  → paste this into stepzone: http://localhost:${PORT}/catalog.json`);
});
