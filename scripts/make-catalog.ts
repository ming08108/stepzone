#!/usr/bin/env node
/**
 * Generate a static notefield catalog.json from a Songs library (packs of song
 * folders). Use this for static hosting (GitHub Pages, S3, …); for a live server
 * use `song-server.ts` instead.
 *
 *   node scripts/make-catalog.ts "<songs-dir>" [outfile]
 *
 * Writes to <songs-dir>/catalog.json by default. Host the folder over HTTP (with
 * permissive CORS if it's a different origin) and paste the catalog.json URL into
 * notefield's "Load from server" box.
 */
import { closeSync, openSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import type { RemoteCatalog, RemoteSong } from '../src/io/catalog';

const SIM = new Set(['.ssc', '.sma', '.sm']);
const IMG = new Set(['.png', '.jpg', '.jpeg']);
const ext = (n: string): string => extname(n).toLowerCase();

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/make-catalog.ts "<songs-dir>" [outfile]');
  process.exit(1);
}
const ROOT = dir.replace(/[\\/]+$/, '');
const out = process.argv[3] ?? join(ROOT, 'catalog.json');

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

function scan(d: string, depth: number, songs: RemoteSong[]): void {
  if (depth > 6) return;
  let names: string[];
  try {
    names = readdirSync(d);
  } catch {
    return;
  }
  const files: string[] = [];
  const subdirs: string[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    try {
      if (statSync(join(d, name)).isDirectory()) subdirs.push(name);
      else files.push(name);
    } catch {
      /* skip */
    }
  }
  const sm =
    files.find((f) => ext(f) === '.ssc') ??
    files.find((f) => ext(f) === '.sma') ??
    files.find((f) => ext(f) === '.sm');
  if (sm && SIM.has(ext(sm))) {
    const rel = relative(ROOT, d).split(sep).join('/');
    const banner = files.find((f) => /(banner|-bn|jacket)/i.test(f) && IMG.has(ext(f)));
    const { title, artist } = readMeta(join(d, sm));
    songs.push({
      dir: rel,
      sm,
      ...(banner ? { banner } : {}),
      title: title || basename(rel),
      artist,
      pack: rel.split('/')[0] || '',
    });
    return;
  }
  for (const s of subdirs) scan(join(d, s), depth + 1, songs);
}

const songs: RemoteSong[] = [];
scan(ROOT, 0, songs);
songs.sort((a, b) => (a.dir ?? '').localeCompare(b.dir ?? ''));
const cat: RemoteCatalog = { name: basename(ROOT), count: songs.length, songs };
writeFileSync(out, JSON.stringify(cat, null, 2));
console.log(`Wrote ${out} with ${songs.length} songs.`);
