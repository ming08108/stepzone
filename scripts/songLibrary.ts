/**
 * Node-side song library helpers shared by the integrated Vite dev middleware
 * (vite.config.ts) and the standalone server (song-server.ts): scan a Songs tree
 * into a catalog, and serve files with correct MIME types + HTTP Range.
 *
 * Runs under plain `node` with type stripping (Node >= 22.6) — no TS enums may
 * be imported here, which is why the difficulty tables live in the enum-free
 * src/song/difficultyAliases.ts.
 */
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { basename, extname, join, relative, sep } from 'node:path';
import type { RemoteCatalog, RemoteSong } from '../src/io/catalog';
import { difficultyAliasToSlot } from '../src/song/difficultyAliases.ts';

/**
 * Resolve the Songs root shared by vite.config.ts and song-server.ts: an
 * explicit override (e.g. a CLI argument) wins, then the SONGS_DIR env var,
 * then the committed dev-machine default.
 */
export function resolveSongsRoot(override?: string): string {
  return (override || process.env.SONGS_DIR || 'C:/Games/ITGmania/Songs').replace(/[\\/]+$/, '');
}

const MAX_DEPTH = 6;
const IMG = new Set(['.png', '.jpg', '.jpeg']);

/**
 * Simfile preference order for a song folder. Must match `findSimfile` in
 * src/io/songFiles.ts (asserted by tests/songLibrary.test.ts).
 */
export const SIMFILE_PREFERENCE: readonly string[] = ['.ssc', '.sma', '.sm'];

/** Pick the preferred simfile from a folder's file names, or undefined. */
export function pickSimfile(names: readonly string[]): string | undefined {
  for (const wanted of SIMFILE_PREFERENCE) {
    const found = names.find((n) => ext(n) === wanted);
    if (found) return found;
  }
  return undefined;
}

export const MIME: Record<string, string> = {
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

interface SongMeta {
  title: string;
  artist: string;
  bpm: string;
  levels: Array<number | null>;
}

/**
 * Catalog slot for a chart difficulty name: the engine's shared alias table,
 * with Edit folded into the Challenge slot — catalog `levels` arrays have five
 * slots (Beginner, Easy, Medium, Hard, Challenge). Returns -1 when unknown.
 */
function catalogSlot(diff: string): number {
  const slot = difficultyAliasToSlot(diff);
  return slot < 0 ? -1 : Math.min(slot, 4);
}

/** Read title/artist, display BPM, and dance-single meters from a simfile. */
function readSongMeta(file: string): SongMeta {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { title: '', artist: '', bpm: '', levels: [null, null, null, null, null] };
  }
  const grab = (tag: string): string => {
    const m = new RegExp(`#${tag}:([^;\\r\\n]*)`, 'i').exec(text);
    return m ? m[1].trim() : '';
  };

  // BPM range from #BPMS (beat=bpm,...).
  const bpmVals = grab('BPMS')
    .split(',')
    .map((p) => parseFloat(p.split('=')[1]))
    .filter((v) => Number.isFinite(v) && v > 0);
  let bpm = '';
  if (bpmVals.length) {
    const lo = Math.round(Math.min(...bpmVals));
    const hi = Math.round(Math.max(...bpmVals));
    bpm = lo === hi ? String(hi) : `${lo}–${hi}`;
  }

  // dance-single meters, mapped to difficulty slots (keep the hardest per slot).
  const levels: Array<number | null> = [null, null, null, null, null];
  const set = (diff: string, meter: number) => {
    const slot = catalogSlot(diff);
    if (slot >= 0 && (levels[slot] == null || meter > (levels[slot] as number)))
      levels[slot] = meter;
  };
  for (const m of text.matchAll(/#NOTES:\s*dance-single\s*:[^:]*:\s*([^:]+?)\s*:\s*(\d+)\s*:/gi)) {
    set(m[1], parseInt(m[2], 10));
  }
  for (const block of text.split(/#NOTEDATA/i).slice(1)) {
    if (!/#STEPSTYPE:\s*dance-single/i.test(block)) continue;
    const d = /#DIFFICULTY:\s*([^;]+);/i.exec(block);
    const mt = /#METER:\s*(\d+)/i.exec(block);
    if (d && mt) set(d[1], parseInt(mt[1], 10));
  }

  return { title: grab('TITLE'), artist: grab('ARTIST'), bpm, levels };
}

/** Walk the tree; a folder holding a simfile is a song (don't descend further). */
function scan(root: string, dir: string, depth: number, songs: RemoteSong[]): void {
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
      /* unreadable; skip */
    }
  }
  const sm = pickSimfile(files);
  if (sm) {
    const rel = relative(root, dir).split(sep).join('/');
    const banner = files.find((f) => /(banner|-bn|jacket)/i.test(f) && IMG.has(ext(f)));
    const meta = readSongMeta(join(dir, sm));
    songs.push({
      dir: rel,
      sm,
      ...(banner ? { banner } : {}),
      title: meta.title || basename(rel),
      artist: meta.artist,
      bpm: meta.bpm,
      levels: meta.levels,
      pack: rel.split('/')[0] || '',
    });
    return;
  }
  for (const s of subdirs) scan(root, join(dir, s), depth + 1, songs);
}

const warnedMissingRoots = new Set<string>();

/** Build a catalog for a Songs root (empty if the root is missing/unreadable). */
export function scanCatalog(root: string): RemoteCatalog {
  let rootIsDir = false;
  try {
    rootIsDir = statSync(root).isDirectory();
  } catch {
    /* missing */
  }
  if (!rootIsDir && !warnedMissingRoots.has(root)) {
    warnedMissingRoots.add(root);
    console.warn(
      `[stepzone] Songs root not found: "${root}" — serving an empty catalog. ` +
        'Set the SONGS_DIR env var (or pass a directory to song-server.ts) to point at your Songs folder.',
    );
  }
  const songs: RemoteSong[] = [];
  scan(root, root, 0, songs);
  songs.sort((a, b) => (a.dir ?? '').localeCompare(b.dir ?? ''));
  return { name: basename(root), count: songs.length, songs };
}

/** Resolve a request path to an absolute file inside `root`, or null if unsafe. */
export function safePath(root: string, urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch {
    return null; // malformed %-encoding — would otherwise throw (and kill the server)
  }
  const abs = join(root, rel);
  const within = relative(root, abs);
  if (within.startsWith('..') || within.includes(`..${sep}`)) return null;
  return abs;
}

/**
 * Parse an HTTP Range header against a file of `size` bytes. Returns the byte
 * range to serve, null when there is no usable Range header (serve the whole
 * file), or 'unsatisfiable' (respond 416). Mirrors the server's long-standing
 * behavior: a suffix range (`bytes=-N`) is served as `0-N`, not as the
 * RFC 7233 "last N bytes".
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const m = header ? /bytes=(\d*)-(\d*)/.exec(header) : null;
  if (!m) return null;
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size)
    return 'unsatisfiable';
  return { start, end };
}

/** Pipe a file (or byte range) to the response, surviving mid-stream errors. */
function pipeFile(res: ServerResponse, file: string, range?: { start: number; end: number }): void {
  const stream = range ? createReadStream(file, range) : createReadStream(file);
  stream.on('error', () => {
    // Don't let a bad read crash the long-lived server. Headers (and part of
    // the body) may already be out; then the only honest move is to kill the
    // connection so the client sees a failed transfer, not a truncated one.
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('read error');
    }
  });
  // If the client goes away, stop reading from disk.
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** Stream a file to a Node response with MIME + Range support. */
export function sendFile(
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
  const type = MIME[ext(file)] ?? 'application/octet-stream';
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  if (range) {
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': range.end - range.start + 1,
    });
    if (req.method !== 'HEAD') pipeFile(res, file, range);
    else res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  if (req.method !== 'HEAD') pipeFile(res, file);
  else res.end();
}

/** Minimal request shape shared by node:http and Vite's connect middleware. */
export interface SongServerRequest {
  method?: string;
  url?: string;
  headers: { range?: string };
}

/** `scanCatalog` behind a cache so directory rescans don't hit every request. */
export function createCatalogCache(root: string, ttlMs = 60_000): () => RemoteCatalog {
  let cache: RemoteCatalog | null = null;
  let cacheAt = 0;
  return () => {
    const now = Date.now();
    if (cache && now - cacheAt < ttlMs) return cache;
    cache = scanCatalog(root);
    cacheAt = now;
    return cache;
  };
}

/**
 * Handle one song-library request: `/` or `/catalog.json` -> catalog JSON,
 * anything else -> safe-resolved file with MIME + Range support. Shared by the
 * Vite middleware and the standalone server (which layers CORS/OPTIONS on
 * top). `urlPath` is the request path with any mount prefix (e.g. `/songs`)
 * already stripped; it defaults to `req.url`.
 */
export function handleSongRequest(
  req: SongServerRequest,
  res: ServerResponse,
  root: string,
  catalog: () => RemoteCatalog,
  urlPath: string = req.url ?? '/',
): void {
  const path = urlPath.split('?')[0] || '/';
  if (path === '/' || path === '/catalog.json') {
    const body = JSON.stringify(catalog());
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  const file = safePath(root, path);
  if (!file) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  sendFile(req, res, file);
}
