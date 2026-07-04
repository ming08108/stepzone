#!/usr/bin/env node
/**
 * Generate a static notefield catalog.json from a Songs library. Use this for
 * static hosting (GitHub Pages, S3, …); for a live server use `song-server.ts`,
 * and for local dev the library loads automatically (no catalog needed).
 *
 *   node scripts/make-catalog.ts "<songs-dir>" [outfile]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanCatalog } from './songLibrary.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/make-catalog.ts "<songs-dir>" [outfile]');
  process.exit(1);
}
const ROOT = dir.replace(/[\\/]+$/, '');
const out = process.argv[3] ?? join(ROOT, 'catalog.json');
const cat = scanCatalog(ROOT);
writeFileSync(out, JSON.stringify(cat, null, 2));
console.log(`Wrote ${out} with ${cat.count} songs.`);
