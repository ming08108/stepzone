#!/usr/bin/env node
/**
 * Generate a notefield song-server catalog.json from a pack folder.
 *
 *   node scripts/make-catalog.mjs "<songs-dir>" [outfile]
 *
 * Scans each immediate subfolder for a simfile (.ssc/.sma/.sm) and an optional
 * banner, and writes a catalog.json (default: <songs-dir>/catalog.json). Host
 * the folder over HTTP (with permissive CORS if it's a different origin than the
 * app) and paste the catalog.json URL into notefield's "Load from server" box.
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SIM = ['.ssc', '.sma', '.sm'];
const BANNER = ['.png', '.jpg', '.jpeg'];
const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/make-catalog.mjs "<songs-dir>" [outfile]');
  process.exit(1);
}
const out = process.argv[3] ?? join(dir, 'catalog.json');

const ext = (n) => {
  const i = n.lastIndexOf('.');
  return i >= 0 ? n.slice(i).toLowerCase() : '';
};

const songs = [];
for (const name of readdirSync(dir)) {
  const sub = join(dir, name);
  let files;
  try {
    if (!statSync(sub).isDirectory()) continue;
    files = readdirSync(sub);
  } catch {
    continue;
  }
  let sm;
  for (const e of SIM) {
    sm = files.find((f) => ext(f) === e);
    if (sm) break;
  }
  if (!sm) continue;
  const banner = files.find((f) => /(banner|-bn|jacket)/i.test(f) && BANNER.includes(ext(f)));
  songs.push({ dir: name, sm, ...(banner ? { banner } : {}) });
}

songs.sort((a, b) => a.dir.localeCompare(b.dir));
writeFileSync(out, JSON.stringify({ name: dir.split(/[\\/]/).pop(), songs }, null, 2));
console.log(`Wrote ${out} with ${songs.length} songs.`);
