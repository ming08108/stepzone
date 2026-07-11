/**
 * End-to-end leg for the online-leaderboard surfaces (docs/LEADERBOARDS.md),
 * driven through real headless Chrome against the dev API middleware (the
 * same handlers the Vercel Function runs, on an in-memory store).
 *
 * What it pins that unit tests cannot:
 * - the app's own board fetch (GlobalBest) targets a real starter chart hash;
 * - seeding scores through the real POST /api/scores makes the WORLD line
 *   appear in the song-select header;
 * - the RANKS panel opens from the SELECT menu, lists the seeded rows (ghost
 *   marker included), and closes — all on the pad key proxy (arrows/Enter/
 *   Escape), i.e. the exact code path a dance pad drives.
 *
 * Run with `node e2e/leaderboard.e2e.mjs`. Requires Google Chrome.
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const failures = [];
const step = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures.push(name);
};

const bodyText = (page) => page.evaluate(() => document.body.innerText);

/** Boot to the pack grid and open ALL SONGS (first card, default highlight). */
async function openAllSongs(page, base) {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.innerText.includes('ALL SONGS'), null, {
    timeout: 20_000,
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /▲▼ SONG/.test(document.body.innerText), null, {
    timeout: 10_000,
  });
}

const vite = await createServer({ root: ROOT, server: { port: 5199, strictPort: false } });
await vite.listen();
let browser = null;
try {
  const base = vite.resolvedUrls?.local[0] ?? 'http://localhost:5199/';
  console.log(`vite at ${base}`);
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));

  // 1. Boot to the song list; the header's GlobalBest readout fetches the
  //    board for the highlighted starter chart — capture that chart hash.
  const boardRequest = page.waitForRequest((r) => r.url().includes('/api/scores?'), {
    timeout: 15_000,
  });
  await openAllSongs(page, base);
  const reqUrl = new URL((await boardRequest).url());
  const chartHash = reqUrl.searchParams.get('chartHash');
  const rate = reqUrl.searchParams.get('rate') ?? '1';
  step('song select queries the board for the highlighted chart', !!chartHash, `hash ${chartHash}`);

  // 2. Seed two players through the real POST endpoint (RIVAL has a ghost).
  const submit = (playerId, playerName, percent, ghost) =>
    fetch(`${base}api/scores`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: 1,
        playerId,
        secret: `secret-${playerId}`,
        playerName,
        chart: {
          chartHash,
          title: 'Seeded',
          artist: 'E2E',
          stepsType: 'dance-single',
          difficulty: 3,
          meter: 5,
        },
        musicRate: Number(rate),
        result: {
          percent,
          grade: 'AA',
          maxCombo: 50,
          failed: false,
          counts: { 9: 50 },
          holdCounts: {},
        },
        ...(ghost ? { ghost } : {}),
      }),
    });
  const r1 = await submit('rival-1', 'RIVAL', 0.97, [
    { atSong: 0, percent: 0, combo: 0, life: 0.5 },
    { atSong: 1, percent: 0.5, combo: 5, life: 0.8 },
  ]);
  const r2 = await submit('bronze-1', 'BRONZE', 0.8);
  step('seed submissions accepted', r1.status === 200 && r2.status === 200);

  // 3. Fresh page (module caches reset) — the WORLD line shows the seeded top.
  await openAllSongs(page, base);
  await page.waitForFunction(() => document.body.innerText.includes('WORLD'), null, {
    timeout: 10_000,
  });
  const header = await bodyText(page);
  step('WORLD best appears in the header', /WORLD\s*97\.00% RIVAL/.test(header));

  // 4. SELECT menu → RANKS (BACK is row 0, RANKS row 1) → panel lists rows.
  await page.keyboard.press('Escape'); // SELECT — open the menu
  await page.waitForFunction(() => document.body.innerText.includes('RANKS'), null, {
    timeout: 5_000,
  });
  await page.keyboard.press('ArrowRight'); // BACK → RANKS
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /#1/.test(document.body.innerText), null, { timeout: 10_000 });
  const panel = await bodyText(page);
  step('RANKS panel lists the seeded board', /#1\s*RIVAL/.test(panel) && /#2\s*BRONZE/.test(panel));
  step('percent/grade render', /97\.00%/.test(panel) && /80\.00%/.test(panel));
  step('ghost marker shows on the racable row', panel.includes('▶'));

  // 5. SELECT closes the panel and the list is navigable again.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !/START \/ SELECT — CLOSE/.test(document.body.innerText), null, {
    timeout: 5_000,
  });
  step('panel closes back to the song list', /▲▼ SONG/.test(await bodyText(page)));

  step('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  step('suite completed', false, String(err));
} finally {
  if (browser) await browser.close();
  await vite.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nall leaderboard e2e checks passed');
