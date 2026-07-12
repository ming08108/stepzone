/**
 * Runs the e2e suites in sequence, retrying a suite once if it fails. The suites
 * drive a real browser + WebGPU and each spins up its own Vite server, so back to
 * back under load they can flake transiently (a slow decode, a font request, a
 * WebGPU adapter hiccup). Each suite is deterministic in isolation, so a single
 * fresh-process retry clears the occasional load-induced flake without masking a
 * real, reproducible failure (which fails both attempts).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const suites = ['songselect', 'leaderboard', 'versus'];
const ATTEMPTS = 2;

let failed = false;
for (const suite of suites) {
  let ok = false;
  for (let attempt = 1; attempt <= ATTEMPTS && !ok; attempt++) {
    if (attempt > 1) console.log(`\n↻ retry ${suite} (attempt ${attempt}/${ATTEMPTS})\n`);
    const r = spawnSync('node', [join(here, `${suite}.e2e.mjs`)], { stdio: 'inherit' });
    ok = r.status === 0;
  }
  if (!ok) {
    failed = true;
    console.log(`✗ ${suite} failed after ${ATTEMPTS} attempts`);
  }
}
process.exit(failed ? 1 : 0);
