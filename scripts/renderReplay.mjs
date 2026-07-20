/**
 * renderReplay.mjs — batch video capture for the ?replaydancer showcase renderer.
 *
 * Loads the replay page in headless system Chrome (playwright-core, the repo's
 * verify convention — no bundled browser), plays a recorded rollout in real time,
 * and records the composited canvas with in-page MediaRecorder
 * (canvas.captureStream(fps)) to a high-bitrate .webm.
 *
 * Usage:
 *   node scripts/renderReplay.mjs <replay.json> [more.json …] [options]
 *
 * Options:
 *   --out <path|dir>   output .webm (single input) or output directory (multiple)
 *   --width  <px>      capture width  (default 1920)
 *   --height <px>      capture height (default 1080)
 *   --fps <60|120>     output frame rate (default 60; 120 = interpolated master)
 *   --rate <x>         playback rate (default 1.0; e.g. 0.5 over-cranked = slow-mo)
 *   --headful          show the browser (better GPU; default headless)
 *   --rebuild          force a fresh `vite build` (else reuse dist/ if present)
 *
 * The renderer interpolates poses (positions lerp, quaternions slerp), so both
 * 30Hz and 60Hz replays stay smooth, and 120fps / rate!=1 masters stay crisp.
 *
 * Requires Google Chrome on the machine. Builds the app once and serves it via
 * `vite preview` (a built bundle loads far faster/more reliably headless than the
 * dev server's on-demand transform of the heavy three/webgpu graph).
 */
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';
import { readFileSync, copyFileSync, rmSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function parseArgs(argv) {
  const files = [];
  const opts = {
    width: 1920,
    height: 1080,
    fps: 60,
    rate: 1,
    headful: false,
    out: null,
    rebuild: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--width') opts.width = parseInt(argv[++i], 10);
    else if (a === '--height') opts.height = parseInt(argv[++i], 10);
    else if (a === '--fps') opts.fps = parseInt(argv[++i], 10);
    else if (a === '--rate') opts.rate = parseFloat(argv[++i]);
    else if (a === '--headful') opts.headful = true;
    else if (a === '--rebuild') opts.rebuild = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else files.push(a);
  }
  if (!files.length) throw new Error('no replay files given');
  if (![60, 120].includes(opts.fps)) throw new Error('--fps must be 60 or 120');
  return { files, opts };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function outPathFor(input, opts, single) {
  if (opts.out && single && extname(opts.out) === '.webm') return resolve(opts.out);
  const dir = opts.out ? resolve(opts.out) : join(ROOT, 'outputs');
  mkdirSync(dir, { recursive: true });
  return join(dir, basename(input).replace(/\.json$/i, '') + '.webm');
}

async function main() {
  const { files, opts } = parseArgs(process.argv.slice(2));

  // Serve a PRODUCTION build via `vite preview`, not the dev server: the dev
  // server transforms + first-load dep-optimizes the heavy three/webgpu + three-vrm
  // graph on demand, which is slow/flaky under load. A built bundle loads fast and
  // deterministically — the right footing for a batch render tool. `resolvedUrls`
  // give the exact reachable base (the repo's e2e pattern; avoids loopback-host
  // guessing).
  const distIndex = join(ROOT, 'dist', 'index.html');
  if (opts.rebuild || !existsSync(distIndex)) {
    console.log('▶ building app (vite build)…');
    await build({ root: ROOT, logLevel: 'warn' });
  } else {
    console.log('▶ reusing existing dist/ (pass --rebuild to force)');
  }
  console.log('▶ starting preview server…');
  const vite = await preview({ root: ROOT, preview: { strictPort: false } });
  const base = (vite.resolvedUrls?.local[0] ?? 'http://localhost:4173/').replace(/\/$/, '');
  console.log(`  serving ${base}`);

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !opts.headful,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--ignore-gpu-blocklist',
      `--window-size=${opts.width},${opts.height}`,
    ],
  });

  let failures = 0;
  try {
    const context = await browser.newContext({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 1,
      acceptDownloads: true,
    });
    const servedName = '__replay_capture.json';
    const servedPath = join(ROOT, 'dist', servedName);

    for (let idx = 0; idx < files.length; idx++) {
      const input = resolve(files[idx]);
      const out = outPathFor(input, opts, files.length === 1);
      const label = basename(input);
      console.log(`\n[${idx + 1}/${files.length}] ${label} → ${out}`);

      // Serve this replay from /public so the page can fetch it by URL.
      copyFileSync(input, servedPath);
      // Basic sanity: parse it so a bad file fails fast with a clear message.
      let expectDur = 0;
      try {
        const rep = JSON.parse(readFileSync(input, 'utf8'));
        const fps = rep.fps > 0 ? rep.fps : 30;
        const poseDur = Array.isArray(rep.frames) ? (rep.frames.length - 1) / fps : 0;
        const notes = rep.chart?.notes ?? [];
        const lastNote = notes.length ? notes[notes.length - 1].t + 0.5 : 0;
        expectDur = Math.max(poseDur, lastNote);
      } catch (e) {
        console.error(`  ✗ not valid JSON: ${e.message}`);
        failures++;
        continue;
      }
      const wallSeconds = expectDur / opts.rate;
      console.log(
        `  content ${expectDur.toFixed(1)}s · rate ${opts.rate}× · ${opts.fps}fps → ~${wallSeconds.toFixed(1)}s capture`,
      );

      const page = await context.newPage();
      page.on('pageerror', (e) => console.error(`  [page error] ${e.message}`));
      // Attach the download waiter early, but swallow its rejection so a failure
      // elsewhere (goto/ready) surfaces its own error instead of this one.
      const downloadP = page.waitForEvent('download', { timeout: (wallSeconds + 60) * 1000 });
      downloadP.catch(() => {});

      const url =
        `${base}/?replaydancer&capture=1` +
        `&replayUrl=/${servedName}` +
        `&capfps=${opts.fps}&caprate=${opts.rate}` +
        `&capw=${opts.width}&caph=${opts.height}`;

      let ticker;
      try {
        // First navigation can be slow: Vite holds the response while it does the
        // one-time dep-optimize of the heavy three/webgpu + three-vrm graph.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        // Wait for the dancer + replay to be ready (VRM load).
        await page.waitForFunction(() => window.__replayReady === true, { timeout: 40_000 });
        console.log('  ready — recording…');

        // Progress ticker until capture completes.
        let lastPct = -1;
        ticker = setInterval(async () => {
          try {
            const p = await page.evaluate(() => window.__captureProgress ?? 0);
            const pct = Math.round(p * 100);
            if (pct !== lastPct && pct % 5 === 0) {
              lastPct = pct;
              process.stdout.write(`\r  progress ${pct}%   `);
            }
          } catch {
            /* page navigating / closed */
          }
        }, 400);

        const download = await downloadP;
        clearInterval(ticker);
        process.stdout.write('\r  progress 100%  \n');
        await download.saveAs(out);
      } catch (e) {
        if (ticker) clearInterval(ticker);
        console.error(`\n  ✗ capture failed: ${e.message.split('\n')[0]}`);
        failures++;
        await page.close().catch(() => {});
        continue;
      }
      await page.close();

      const bytes = statSync(out).size;
      const mb = bytes / (1024 * 1024);
      const ok = mb > 0.5;
      console.log(
        `  ${ok ? '✓' : '✗'} wrote ${out} — ${mb.toFixed(2)} MB` +
          ` (expected ~${expectDur.toFixed(1)}s content @ ${opts.fps}fps)`,
      );
      if (!ok) {
        console.error('  ✗ output is under 0.5 MB — likely a render/record failure');
        failures++;
      }
    }

    if (existsSync(servedPath)) rmSync(servedPath, { force: true });
    await context.close();
  } finally {
    await browser.close();
    if (typeof vite.close === 'function') await vite.close();
    else vite.httpServer?.close();
  }

  if (failures) {
    console.error(`\n${failures} file(s) failed.`);
    process.exit(1);
  }
  console.log('\n✓ all replays rendered.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
