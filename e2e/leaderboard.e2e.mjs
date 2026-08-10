/**
 * End-to-end leg for the online-leaderboard surfaces (docs/LEADERBOARDS.md),
 * driven through real headless Chrome against the dev API middleware (the
 * same handlers the Vercel Function runs, on an in-memory store).
 *
 * What it pins that unit tests cannot:
 * - the app's own board fetch (song-select inspector) targets a real starter
 *   chart hash;
 * - seeding scores through the real POST /api/scores makes the WORLD tile and
 *   the RANKS rows appear in the inspector pane;
 * - the whole surface stays on the pad key proxy (arrows/Enter/Escape), i.e.
 *   the exact code path a dance pad drives.
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

/** Boot to the 3-pane song select (the list pane owns the pad by default).
 *  The very first boot gets the name prompt — type a name and confirm. */
async function bootSongSelect(page, base) {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => document.body.innerText.includes('ALL SONGS'), null, {
    timeout: 20_000,
  });
  if ((await bodyText(page)).includes('WELCOME TO STEPZONE')) {
    await page.keyboard.type('CHAMP');
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => !document.body.innerText.includes('WELCOME TO STEPZONE'),
      null,
      { timeout: 12_000 },
    );
    const savedName = await page.evaluate(
      () => JSON.parse(localStorage.getItem('notefield.net.identity.v1') ?? '{}').name,
    );
    step('first-load prompt saves the player name', savedName === 'CHAMP', `name ${savedName}`);
  }
}

const vite = await createServer({
  root: ROOT,
  // Explicit IPv4 loopback: on some machines vite binds IPv6-only while the
  // browser resolves localhost to 127.0.0.1 first — pin both to one family.
  server: { port: 5199, strictPort: false, host: '127.0.0.1' },
});
await vite.listen();
let browser = null;
try {
  const base = vite.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5199/';
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

  // 1. Boot to song select; the inspector's WORLD readout fetches the board
  //    for the highlighted starter chart — capture that chart hash.
  const boardRequest = page.waitForRequest((r) => r.url().includes('/api/scores?'), {
    timeout: 120_000, // a cold dev-server boot can take most of a minute
  });
  boardRequest.catch(() => {}); // never an unhandled rejection while boot awaits
  await bootSongSelect(page, base);
  const reqUrl = new URL((await boardRequest).url());
  const chartHash = reqUrl.searchParams.get('chartHash');
  const rate = reqUrl.searchParams.get('rate') ?? '1';
  step('song select queries the board for the highlighted chart', !!chartHash, `hash ${chartHash}`);

  // 2. v4 verification: the server RE-SIMULATES every submitted replay against
  //    the submitted chart and ranks on what it scores, ignoring the claimed
  //    result. A seed must therefore ship the genuine chart the board is keyed
  //    on plus a replay that actually plays it — which the harness gets from
  //    the DEV-only `window.__seedChartData()` hook for the highlighted chart.
  await page.waitForFunction(() => typeof window.__seedChartData === 'function', null, {
    timeout: 20_000,
  });
  const seed = await page.evaluate(() => window.__seedChartData());
  step(
    'dev seed hook yields the highlighted chart (hash + chartData + replay)',
    !!seed && seed.chartHash === chartHash && Array.isArray(seed.perfectReplay),
    `hash ${seed?.chartHash} notes ${seed?.perfectReplay?.length}`,
  );

  // The claimed result is ignored by the re-sim, so keep it minimal (few judged
  // taps => no minimum-span rule) — the stored score is whatever the replay
  // scores. RIVAL plays the full ideal replay (~100%); BRONZE plays only the
  // first half (the rest miss), so RIVAL must outrank BRONZE on the re-sim.
  const submit = (playerId, playerName, replay) =>
    fetch(`${base}api/scores`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: 4,
        chartData: seed.chartData,
        replay,
        playerId,
        secret: `secret-${playerId}`,
        playerName,
        chart: {
          chartHash,
          title: 'Seeded',
          artist: 'E2E',
          stepsType: seed.chartData.stepsType,
          difficulty: 3,
          meter: 5,
        },
        musicRate: Number(rate),
        result: {
          percent: 0.5,
          grade: 'A',
          maxCombo: 5,
          failed: false,
          counts: { 9: 5 },
          holdCounts: {},
        },
      }),
    });
  const full = seed.perfectReplay;
  const half = full.slice(0, Math.max(2, Math.floor(full.length / 2)));
  const r1 = await submit('rival-1', 'RIVAL', full);
  const r2 = await submit('bronze-1', 'BRONZE', half);
  step('seed submissions accepted', r1.status === 200 && r2.status === 200);

  // Read back the re-simulated board at the API level: RIVAL (full replay) must
  // rank above BRONZE (half replay). The stored percents drive the UI regexes.
  const boardRows = await (
    await fetch(
      `${base}api/scores?chartHash=${encodeURIComponent(chartHash)}&rate=${rate}&limit=10`,
    )
  ).json();
  const rival = boardRows.rows?.find((r) => r.playerId === 'rival-1');
  const bronze = boardRows.rows?.find((r) => r.playerId === 'bronze-1');
  step(
    're-sim ranks the full replay above the partial',
    !!rival && !!bronze && rival.rank === 1 && rival.percent > bronze.percent,
    `rival ${(rival?.percent * 100).toFixed(2)}% > bronze ${(bronze?.percent * 100).toFixed(2)}%`,
  );
  const pct = (p) => (p * 100).toFixed(2);
  const rivalPct = pct(rival.percent);
  const bronzePct = pct(bronze.percent);

  // 3. Fresh page (server store persists) — the WORLD tile shows the seeded top.
  await bootSongSelect(page, base);
  await page.waitForFunction(() => document.body.innerText.includes('WORLD'), null, {
    timeout: 20_000,
  });
  await page.waitForFunction((p) => document.body.innerText.includes(`${p}%`), rivalPct, {
    timeout: 20_000,
  });
  const header = await bodyText(page);
  step(
    'WORLD best appears in the inspector',
    new RegExp(`WORLD[\\s\\S]{0,40}?${rivalPct.replace('.', '\\.')}%\\s*RIVAL`).test(header),
    `expected ${rivalPct}% RIVAL — text: ${header.replace(/\s+/g, ' ').slice(0, 160)}`,
  );

  // 4. The RANKS rows render in the inspector beside the list — no menu
  //    navigation needed (the pane is always visible on wide viewports).
  await page.waitForFunction(() => /#1\s*RIVAL/.test(document.body.innerText), null, {
    timeout: 20_000,
  });
  const panel = await bodyText(page);
  step('inspector lists the seeded board', /#1\s*RIVAL/.test(panel) && /#2\s*BRONZE/.test(panel));
  step(
    'percent/grade render',
    panel.includes(`${rivalPct}%`) && panel.includes(`${bronzePct}%`),
    `rival ${rivalPct}% bronze ${bronzePct}%`,
  );
  step('list stays navigable alongside the inspector', /▲▼\s*SONG/.test(panel));

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
