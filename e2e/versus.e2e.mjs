/**
 * End-to-end leg for live P2P versus (docs/VERSUS.md): two real browser
 * contexts (separate identities) race each other through the whole flow —
 * host creates a room from the SELECT menu, the joiner enters the 6-arrow
 * code BY PRESSING THE ARROWS (the pad path), WebRTC connects through the dev
 * signaling middleware, both ready up, and gameplay starts on BOTH machines
 * within a synced window. The opponent bar streams live, and a mid-song
 * disconnect shows up on the rival's screen.
 *
 * Needs WebGPU for gameplay (skips those legs where absent, like the other
 * suites). Run with `node e2e/versus.e2e.mjs`.
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
const skip = (name, why) => console.log(`SKIP ${name} — ${why}`);

const bodyText = (page) => page.evaluate(() => document.body.innerText);

/** A context with a fixed online identity (so the two players have names). */
async function playerPage(browser, base, name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((n) => {
    localStorage.setItem(
      'notefield.net.identity.v1',
      JSON.stringify({ playerId: `e2e-${n}`, secret: `s-${n}`, name: n }),
    );
  }, name);
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message}`));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.innerText.includes('ALL SONGS'), null, {
    timeout: 20_000,
  });
  await page.keyboard.press('Enter'); // open ALL SONGS
  await page.waitForFunction(() => /▲▼ SONG/.test(document.body.innerText), null, {
    timeout: 10_000,
  });
  return page;
}

/** SELECT menu -> VERSUS row (BACK 0, VERSUS 1) -> panel. The menu rows are
 *  always-rendered filter-strip buttons, so wait on the hint text that ONLY
 *  renders while the overlay is open — otherwise the arrow presses can race
 *  the overlay and land on the song list instead. */
async function openVersusPanel(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.body.innerText.includes('SELECT — CLOSE'), null, {
    timeout: 5_000,
  });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.body.innerText.includes('CREATE ROOM'), null, {
    timeout: 5_000,
  });
}

const pageErrors = [];

const vite = await createServer({ root: ROOT, server: { port: 5199, strictPort: false } });
await vite.listen();
let browser = null;
try {
  const base = vite.resolvedUrls?.local[0] ?? 'http://localhost:5199/';
  console.log(`vite at ${base}`);
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--enable-unsafe-webgpu'],
  });

  const alpha = await playerPage(browser, base, 'ALPHA');
  const hasGpu = await alpha.evaluate(() =>
    navigator.gpu
      ? navigator.gpu
          .requestAdapter()
          .then((a) => !!a)
          .catch(() => false)
      : false,
  );
  if (!hasGpu) {
    skip('live versus flow', 'no WebGPU adapter in this environment');
  } else {
    const bravo = await playerPage(browser, base, 'BRAVO');

    // 1. ALPHA hosts a room on the highlighted starter chart.
    await openVersusPanel(alpha);
    await alpha.keyboard.press('Enter'); // CREATE ROOM
    await alpha.waitForFunction(() => document.body.innerText.includes('ROOM CODE'), null, {
      timeout: 15_000,
    });
    const codeGlyphs = (await bodyText(alpha)).match(/([←↓↑→](?:\s[←↓↑→]){5})/)?.[1];
    step('host shows a 6-arrow room code', !!codeGlyphs, codeGlyphs ?? 'none found');

    // 2. BRAVO joins by pressing those arrows (the pad-only path).
    await openVersusPanel(bravo);
    await bravo.keyboard.press('ArrowDown'); // JOIN WITH CODE
    await bravo.keyboard.press('Enter');
    await bravo.waitForFunction(() => document.body.innerText.includes('ENTER ROOM CODE'), null, {
      timeout: 5_000,
    });
    const KEY = { '←': 'ArrowLeft', '↓': 'ArrowDown', '↑': 'ArrowUp', '→': 'ArrowRight' };
    for (const glyph of codeGlyphs.split(' ')) {
      await bravo.keyboard.press(KEY[glyph]);
      await bravo.waitForTimeout(80);
    }

    // 3. WebRTC connects; both land in the lobby with both names.
    for (const [page, who] of [
      [alpha, 'host'],
      [bravo, 'joiner'],
    ]) {
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('READY') && document.body.innerText.includes('ALPHA'),
        null,
        { timeout: 30_000 },
      );
      const txt = await bodyText(page);
      step(`${who} lobby shows both players`, txt.includes('ALPHA') && txt.includes('BRAVO'));
    }

    // 4. Both ready up -> load -> synced go -> gameplay on BOTH machines.
    await alpha.keyboard.press('Enter');
    await bravo.keyboard.press('Enter');
    await alpha.waitForFunction(() => !!window.__nfSession, null, { timeout: 30_000 });
    await bravo.waitForFunction(() => !!window.__nfSession, null, { timeout: 30_000 });
    await alpha.waitForFunction(() => window.__nfSession.songNow > -2.5, null, {
      timeout: 20_000,
    });
    step('both sessions exist after the synced start', true);

    // 5. The clocks advance together (same wall instant, per-machine audio).
    await alpha.waitForTimeout(1_500);
    const [tA, tB] = await Promise.all([
      alpha.evaluate(() => window.__nfSession.songNow),
      bravo.evaluate(() => window.__nfSession.songNow),
    ]);
    step(
      'song clocks are in sync across the two players',
      Math.abs(tA - tB) < 0.35,
      `alpha ${tA.toFixed(3)}s vs bravo ${tB.toFixed(3)}s`,
    );
    const advanced = await alpha.evaluate(async () => {
      const a = window.__nfSession.songNow;
      await new Promise((r) => setTimeout(r, 500));
      return window.__nfSession.songNow > a + 0.3;
    });
    step('gameplay clock advances', advanced);

    // 6. The live opponent bar streams on both screens. Generous timeout —
    // two headless WebGPU sessions can run single-digit FPS on CI-ish
    // machines; dump the visible text on failure so a miss is diagnosable.
    let barsOk = true;
    let barDump = '';
    for (const [page, rival] of [
      [alpha, 'BRAVO'],
      [bravo, 'ALPHA'],
    ]) {
      const ok = await page
        .waitForFunction((r) => new RegExp(`${r} .*%`).test(document.body.innerText), rival, {
          timeout: 30_000,
        })
        .then(
          () => true,
          () => false,
        );
      if (!ok) {
        barsOk = false;
        barDump += ` | ${rival}'s screen: ${JSON.stringify((await bodyText(page)).slice(0, 200))}`;
      }
    }
    step('opponent bars stream live on both machines', barsOk, barDump);

    // 7. BRAVO quits mid-song; ALPHA sees the disconnect and keeps playing.
    await bravo.keyboard.down('Escape');
    await bravo.waitForTimeout(1_500);
    await bravo.keyboard.up('Escape');
    await alpha.waitForFunction(() => document.body.innerText.includes('DISCONNECTED'), null, {
      timeout: 15_000,
    });
    const stillPlaying = await alpha.evaluate(() => window.__nfSession.songNow > 0);
    step('rival disconnect shows while the local game keeps running', stillPlaying);

    // 8. ALPHA leaves too; both back on song select.
    await alpha.keyboard.down('Escape');
    await alpha.waitForTimeout(1_500);
    await alpha.keyboard.up('Escape');
    await alpha.waitForFunction(() => /▲▼ SONG|ALL SONGS/.test(document.body.innerText), null, {
      timeout: 15_000,
    });
    step('host exits cleanly to song select', true);
  }

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
console.log('\nall versus e2e checks passed');
