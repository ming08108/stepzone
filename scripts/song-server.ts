#!/usr/bin/env node
/**
 * notefield song server — serves a StepMania/ITGmania Songs library (packs of
 * song folders) over HTTP with a dynamic catalog, CORS, and HTTP Range support,
 * so notefield can browse and stream it (and cache it locally for offline play).
 *
 *   node scripts/song-server.ts [songsDir] [port]      (Node ≥ 22.6, strips types)
 *   npm run song-server -- [songsDir] [port]
 *
 * Defaults: songsDir = $SONGS_DIR or "C:/Games/ITGmania/Songs", port = 8760.
 * Paste  http://localhost:8760/catalog.json  into notefield's "Load from server"
 * box. CORS headers are sent, so a different origin works too.
 */
import { createServer, type ServerResponse } from 'node:http';
import { closeSync, createReadStream, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import type { RemoteCatalog, RemoteSong } from '../src/io/catalog';

const ROOT: string = (
  process.argv[2] ||
  process.env.SONGS_DIR ||
  'C:/Games/ITGmania/Songs'
).replace(/[\\/]+$/, '');
const PORT = Number(process.argv[3] || process.env.PORT || 8760);
const MAX_DEPTH = 6;

const SIM = new Set(['.sm', '.ssc', '.sma']);
const IMG = new Set(['.png', '.jpg', '.jpeg']);
const TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.sm': 'text/plain; charset=utf-8',
  '.ssc': 'text/plain; charset=utf-8',
  '.sma': 'text/plain; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.avi': 'video/x-msvideo',
};
const ext = (n: string): string => extname(n).toLowerCase();

/** Cheaply read #TITLE / #ARTIST from a simfile header (first 8 KB). */
function readMeta(file: string): { title: string; artist: string } {
  try {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    closeSync(fd);
    const text = buf.subarray(0, n).toString('utf8');
    const grab = (tag: string): string => {
      const m = new RegExp(`#${tag}:([^;\\r\\n]*)`, 'i').exec(text);
      return m ? m[1].trim() : '';
    };
    return { title: grab('TITLE'), artist: grab('ARTIST') };
  } catch {
    return { title: '', artist: '' };
  }
}

/** Walk the tree; a folder holding a simfile is a song (don't descend further). */
function scan(dir: string, depth: number, songs: RemoteSong[]): void {
  if (depth > MAX_DEPTH) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const files: string[] = [];
  const subdirs: string[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    try {
      if (statSync(join(dir, name)).isDirectory()) subdirs.push(name);
      else files.push(name);
    } catch {
      // unreadable entry; skip
    }
  }
  const sm =
    files.find((f) => ext(f) === '.ssc') ??
    files.find((f) => ext(f) === '.sma') ??
    files.find((f) => ext(f) === '.sm');
  if (sm && SIM.has(ext(sm))) {
    const rel = relative(ROOT, dir).split(sep).join('/');
    const banner = files.find((f) => /(banner|-bn|jacket)/i.test(f) && IMG.has(ext(f)));
    const { title, artist } = readMeta(join(dir, sm));
    songs.push({
      dir: rel,
      sm,
      ...(banner ? { banner } : {}),
      title: title || basename(rel),
      artist,
      pack: rel.split('/')[0] || '',
    });
    return; // a song folder isn't scanned for nested songs
  }
  for (const s of subdirs) scan(join(dir, s), depth + 1, songs);
}

let cache: RemoteCatalog | null = null;
let cacheAt = 0;
function catalog(): RemoteCatalog {
  const now = Date.now();
  if (cache && now - cacheAt < 60_000) return cache;
  const songs: RemoteSong[] = [];
  scan(ROOT, 0, songs);
  songs.sort((a, b) => (a.dir ?? '').localeCompare(b.dir ?? ''));
  cache = { name: basename(ROOT), count: songs.length, songs };
  cacheAt = now;
  return cache;
}

/** Resolve a request path to an absolute file inside ROOT, or null if unsafe. */
function safePath(urlPath: string): string | null {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const abs = join(ROOT, rel);
  const within = relative(ROOT, abs);
  if (within.startsWith('..') || within.includes(`..${sep}`)) return null;
  return abs;
}

function sendFile(
  req: { method?: string; headers: { range?: string } },
  res: ServerResponse,
  file: string,
): void {
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error('dir');
    size = st.size;
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const type = TYPES[ext(file)] ?? 'application/octet-stream';
  const m = req.headers.range ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    if (req.method !== 'HEAD') createReadStream(file, { start, end }).pipe(res);
    else res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  if (req.method !== 'HEAD') createReadStream(file).pipe(res);
  else res.end();
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
      'Content-Type': TYPES['.json'],
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  const file = safePath(path);
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
