/**
 * Node-side song library helpers shared by the integrated Vite dev middleware
 * (vite.config.ts) and the standalone server (song-server.ts): scan a Songs tree
 * into a catalog, and serve files with correct MIME types + HTTP Range.
 */
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { basename, extname, join, relative, sep } from 'node:path';
import type { RemoteCatalog, RemoteSong } from '../src/io/catalog';

/** Difficulty name → STEPLINE slot (Beginner, Easy, Medium, Hard, Expert). */
const DIFF_SLOT: Record<string, number> = {
  beginner: 0,
  novice: 0,
  easy: 1,
  basic: 1,
  light: 1,
  medium: 2,
  another: 2,
  standard: 2,
  trick: 2,
  difficult: 2,
  hard: 3,
  maniac: 3,
  heavy: 3,
  ssr: 3,
  challenge: 4,
  expert: 4,
  oni: 4,
  smaniac: 4,
  edit: 4,
};

const MAX_DEPTH = 6;
const SIM = new Set(['.sm', '.ssc', '.sma']);
const IMG = new Set(['.png', '.jpg', '.jpeg']);

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
    const slot = DIFF_SLOT[diff.trim().toLowerCase()];
    if (slot != null && (levels[slot] == null || meter > (levels[slot] as number)))
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
  const sm =
    files.find((f) => ext(f) === '.ssc') ??
    files.find((f) => ext(f) === '.sma') ??
    files.find((f) => ext(f) === '.sm');
  if (sm && SIM.has(ext(sm))) {
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

/** Build a catalog for a Songs root (empty if the root is missing/unreadable). */
export function scanCatalog(root: string): RemoteCatalog {
  const songs: RemoteSong[] = [];
  scan(root, root, 0, songs);
  songs.sort((a, b) => (a.dir ?? '').localeCompare(b.dir ?? ''));
  return { name: basename(root), count: songs.length, songs };
}

/** Resolve a request path to an absolute file inside `root`, or null if unsafe. */
export function safePath(root: string, urlPath: string): string | null {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const abs = join(root, rel);
  const within = relative(root, abs);
  if (within.startsWith('..') || within.includes(`..${sep}`)) return null;
  return abs;
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
