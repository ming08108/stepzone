/**
 * End-to-end leg for live P2P versus (docs/VERSUS.md), on the PLAYER OPTIONS
 * flow: the host picks a song and turns on LIVE VERSUS from the options rows;
 * the joiner starts at the PACK GRID (SELECT — no song needed, the room
 * defines it), enters the 6-arrow code BY PRESSING THE ARROWS, resolves the
 * song by hash, and lands on their own PLAYER OPTIONS with the lobby dock.
 * Each player keeps their own difficulty (the picks relay live), both ready
 * up, and gameplay starts on BOTH machines within a synced window. The
 * opponent bar streams live, and a mid-song disconnect shows on the rival's
 * screen.
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

/** A context with a fixed online identity; joiners stay on the pack grid. */
async function playerPage(browser, base, name, { stayOnGrid = false } = {}) {
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
  if (!stayOnGrid) {
    await page.keyboard.press('Enter'); // open ALL SONGS
    await page.waitForFunction(() => /▲▼ SONG/.test(document.body.innerText), null, {
      timeout: 10_000,
    });
  }
  return page;
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
    const bravo = await playerPage(browser, base, 'BRAVO', { stayOnGrid: true });

    // 1. ALPHA: song -> PLAYER OPTIONS -> LIVE VERSUS row (4 below DIFFICULTY)
    //    -> toggle ON -> the lobby dock shows the room code.
    await alpha.keyboard.press('Enter');
    await alpha.waitForFunction(() => /PLAYER OPTIONS/i.test(document.body.innerText), null, {
      timeout: 10_000,
    });
    for (let i = 0; i < 4; i++) await alpha.keyboard.press('ArrowDown');
    await alpha.keyboard.press('ArrowRight'); // LIVE VERSUS: OFF -> hosting
    await alpha.waitForFunction(
      () => document.body.innerText.includes('WAITING FOR A RIVAL'),
      null,
      { timeout: 15_000 },
    );
    const codeGlyphs = (await bodyText(alpha)).match(/([←↓↑→](?:\s[←↓↑→]){5})/)?.[1];
    step('host shows a 6-arrow room code on PLAYER OPTIONS', !!codeGlyphs, codeGlyphs ?? 'none');

    // 2. BRAVO joins from the PACK GRID — no song selection needed.
    await bravo.keyboard.press('Escape'); // SELECT — JOIN VERSUS (root screen)
    await bravo.waitForFunction(() => document.body.innerText.includes('ENTER ROOM CODE'), null, {
      timeout: 10_000,
    });
    const KEY = { '←': 'ArrowLeft', '↓': 'ArrowDown', '↑': 'ArrowUp', '→': 'ArrowRight' };
    for (const glyph of codeGlyphs.split(' ')) {
      await bravo.keyboard.press(KEY[glyph]);
      await bravo.waitForTimeout(80);
    }

    // 3. The joiner resolves the song by hash and lands on PLAYER OPTIONS;
    //    both lobbies show both names.
    await bravo.waitForFunction(
      () =>
        /PLAYER OPTIONS/i.test(document.body.innerText) &&
        document.body.innerText.includes('ALPHA'),
      null,
      { timeout: 30_000 },
    );
    step('joiner lands on PLAYER OPTIONS with the lobby', true);
    for (const [page, who] of [
      [alpha, 'host'],
      [bravo, 'joiner'],
    ]) {
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('ALPHA') && document.body.innerText.includes('BRAVO'),
        null,
        { timeout: 15_000 },
      );
      step(`${who} lobby shows both players`, true);
    }

    // 4. Per-player difficulty: the host is on the song-select default
    //    (MEDIUM), the joiner defaults to the first hash match — the rival's
    //    pick must show up in each lobby.
    const alphaLobby = await bodyText(alpha);
    step(
      'per-player difficulty picks relay to the rival lobby',
      /BEGINNER|EASY/.test(alphaLobby) && (await bodyText(bravo)).includes('MEDIUM'),
    );

    // 5. Both ready up (START pins each pick) -> load -> synced go.
    await alpha.keyboard.press('Enter');
    await bravo.keyboard.press('Enter');
    await alpha.waitForFunction(() => !!window.__nfSession, null, { timeout: 30_000 });
    await bravo.waitForFunction(() => !!window.__nfSession, null, { timeout: 30_000 });
    await alpha.waitForFunction(() => window.__nfSession.songNow > -2.5, null, {
      timeout: 20_000,
    });
    step('both sessions exist after the synced start', true);

    // 6. The clocks advance together (same wall instant, per-machine audio).
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

    // 7. The live opponent bar streams on both screens. Generous timeout —
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

    // 7b. Arcade 2P: the rival's playfield panel renders beside the local
    // field on both machines (a second canvas driven by the note feed).
    const [cA, cB] = await Promise.all(
      [alpha, bravo].map((p) => p.evaluate(() => document.querySelectorAll('canvas').length)),
    );
    step(
      'rival playfields render side by side on both machines',
      cA >= 2 && cB >= 2,
      `alpha ${cA} canvases, bravo ${cB}`,
    );

    // 8. BRAVO quits mid-song; ALPHA sees the disconnect and keeps playing.
    await bravo.keyboard.down('Escape');
    await bravo.waitForTimeout(1_500);
    await bravo.keyboard.up('Escape');
    await alpha.waitForFunction(() => document.body.innerText.includes('DISCONNECTED'), null, {
      timeout: 15_000,
    });
    const stillPlaying = await alpha.evaluate(() => window.__nfSession.songNow > 0);
    step('rival disconnect shows while the local game keeps running', stillPlaying);

    // 9. ALPHA leaves too; back on song select.
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
