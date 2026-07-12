/**
 * Runs the e2e suites in sequence, retrying a suite that fails. The suites drive
 * a real browser + WebGPU + WebRTC P2P, and each spins up its own Vite server, so
 * they can flake transiently (a slow decode, a WebGPU adapter hiccup, P2P/ICE
 * timing) — the kind of environmental noise Playwright's own runner retries past.
 * Each suite is deterministic in isolation, so a fresh-process retry clears the
 * occasional flake without masking a real, reproducible failure (which fails
 * every attempt). A short settle between runs lets the prior browser/server fully
 * release before the next starts.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const suites = ['songselect', 'leaderboard', 'versus'];
const ATTEMPTS = 3;
const sleep = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`]);

let failed = false;
for (const suite of suites) {
  let ok = false;
  for (let attempt = 1; attempt <= ATTEMPTS && !ok; attempt++) {
    if (attempt > 1) {
      console.log(`\n↻ retry ${suite} (attempt ${attempt}/${ATTEMPTS})\n`);
      sleep(2000); // let the prior run's browser/server fully release
    }
    const r = spawnSync('node', [join(here, `${suite}.e2e.mjs`)], { stdio: 'inherit' });
    ok = r.status === 0;
  }
  if (!ok) {
    failed = true;
    console.log(`✗ ${suite} failed after ${ATTEMPTS} attempts`);
  }
}
process.exit(failed ? 1 : 0);
