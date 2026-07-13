/**
 * End-to-end leg for persistent multiplayer rooms (docs/VERSUS.md): the host
 * opens a room from PLAYER OPTIONS (no rival yet — the song is announced to
 * the room automatically), a guest joins from the PACK GRID by pressing the
 * 6-arrow code, auto-follows the host's pick onto their own PLAYER OPTIONS,
 * both ready up, and gameplay starts on both machines within a synced window.
 * A mid-song quit is a DNF (the room survives); the SAME room then plays a
 * SECOND song the guests don't have — the files travel P2P (simfile + audio),
 * a third player joins mid-room via the ?join= link, and the three-way race
 * ends on the animated standings, room still alive.
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

/** Thrown to bail out of the rendering-dependent legs when THIS environment's
 *  WebGPU device is lost under the sustained two-page multi-field versus load.
 *  A software renderer (CI has no GPU) can hand out an adapter — so the up-front
 *  `hasGpu` probe passes and single-field gameplay runs — yet lose the device
 *  once two headless pages render rival fields at once. That's an environment
 *  limit, not a regression, so we SKIP those legs (like an absent adapter). The
 *  app announces the loss with its own RENDERING FAILED banner; a snapshot-stream
 *  miss WITHOUT that banner is a real failure and still fails. */
class GpuLostSkip extends Error {}

/** Whether any page is showing the app's WebGPU-lost banner right now. */
const bannerShowing = async (pages) =>
  (
    await Promise.all(
      pages.map((p) => p.evaluate(() => /RENDERING FAILED/i.test(document.body.innerText))),
    )
  ).some(Boolean);

/** Poll briefly for the WebGPU-lost banner (it can take a moment to paint after
 *  the device drops), so a device loss is recognised as an environment skip
 *  rather than mistaken for a snapshot-stream regression. */
const renderLost = async (pages, ms = 5000) => {
  const deadline = Date.now() + ms;
  do {
    if (await bannerShowing(pages)) return true;
    await pages[0].waitForTimeout(300);
  } while (Date.now() < deadline);
  return false;
};

const bodyText = (page) => page.evaluate(() => document.body.innerText);
const KEY = { L: 'ArrowLeft', D: 'ArrowDown', U: 'ArrowUp', R: 'ArrowRight' };

/** The room code, read as its L/D/U/R letters from the arrow glyphs' data-arrow
 *  attributes (the code renders as rotated SVG arrows, not text). On the host's
 *  PLAYER OPTIONS the only such arrows are the 6-arrow dock code. */
const readCode = async (pg) =>
  (await pg.$$eval('[data-arrow]', (els) => els.map((e) => e.getAttribute('data-arrow')))).join('');

/** A context with a fixed online identity; guests stay on the pack grid. */
async function playerPage(browser, base, name, { stayOnGrid = false, query = '' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((n) => {
    localStorage.setItem(
      'notefield.net.identity.v1',
      JSON.stringify({ playerId: `e2e-${n}`, secret: `s-${n}`, name: n }),
    );
    // Both peers are on localhost — skip STUN so ICE connects instantly via host
    // candidates (no network round-trip / gather latency to flake on).
    window.__e2eRtc = { iceServers: [] };
  }, name);
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message}`));
  await page.goto(base + query, { waitUntil: 'load' });
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

/** Hold-to-quit a live song. The quit is durational (Back must be held past the
 *  threshold), so this genuinely holds for a fixed span — not a state we can wait
 *  on. */
async function quitSong(page) {
  await page.keyboard.down('Escape');
  await page.waitForTimeout(1_500);
  await page.keyboard.up('Escape');
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
    skip('room multiplayer flow', 'no WebGPU adapter in this environment');
  } else {
    const bravo = await playerPage(browser, base, 'BRAVO', { stayOnGrid: true });

    // 1. ALPHA: song -> PLAYER OPTIONS -> MULTIPLAYER row (4 below DIFFICULTY)
    //    -> HOST A ROOM. The dock shows the arrow code, and the song is
    //    announced to the room automatically.
    await alpha.keyboard.press('Enter');
    await alpha.waitForFunction(() => /PLAYER OPTIONS/i.test(document.body.innerText), null, {
      timeout: 10_000,
    });
    for (let i = 0; i < 4; i++) await alpha.keyboard.press('ArrowDown');
    await alpha.keyboard.press('ArrowRight'); // MULTIPLAYER: HOST A ROOM
    await alpha.waitForFunction(
      () => document.body.innerText.includes('WAITING FOR PLAYERS'),
      null,
      { timeout: 15_000 },
    );
    const codeLdur = await readCode(alpha);
    step(
      'host shows a 6-arrow room code on PLAYER OPTIONS',
      /^[LDUR]{6}$/.test(codeLdur),
      codeLdur || 'none',
    );

    // 2. BRAVO joins from the PACK GRID: SELECT -> MULTIPLAYER panel ->
    //    JOIN WITH CODE -> press the 6 arrows.
    await bravo.keyboard.press('Escape');
    await bravo.waitForFunction(() => document.body.innerText.includes('HOST A ROOM'), null, {
      timeout: 10_000,
    });
    await bravo.keyboard.press('ArrowDown'); // JOIN WITH CODE
    await bravo.keyboard.press('Enter');
    await bravo.waitForFunction(() => document.body.innerText.includes('ENTER ROOM CODE'), null, {
      timeout: 10_000,
    });
    for (const letter of codeLdur) {
      await bravo.keyboard.press(KEY[letter]);
      await bravo.waitForTimeout(80);
    }

    // 3. The guest auto-follows the host's announced song (resolved by hash)
    //    onto PLAYER OPTIONS; both docks show both names.
    await bravo.waitForFunction(
      () =>
        /PLAYER OPTIONS/i.test(document.body.innerText) &&
        document.body.innerText.includes('ALPHA'),
      null,
      { timeout: 30_000 },
    );
    step('guest auto-follows onto PLAYER OPTIONS with the room dock', true);
    for (const [page, who] of [
      [alpha, 'host'],
      [bravo, 'guest'],
    ]) {
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('ALPHA') && document.body.innerText.includes('BRAVO'),
        null,
        { timeout: 15_000 },
      );
      step(`${who} dock shows both players`, true);
    }

    // 4. Per-player difficulty: the host is on the song-select default
    //    (MEDIUM), the guest defaults to the first hash match — each pick
    //    must show on the OTHER machine's roster.
    const alphaLobby = await bodyText(alpha);
    step(
      'per-player difficulty picks relay to every roster',
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

    // 7. Each peer's live snapshot streams into the other's room state — the
    // data the fields draw from and the standings tally (the in-play rival
    // overlay was removed). Generous timeout: two headless WebGPU sessions can
    // run single-digit FPS on CI-ish machines. Dump the room roster on failure
    // so a miss is diagnosable.
    let barsOk = true;
    let barDump = '';
    for (const [page, rival] of [
      [alpha, 'BRAVO'],
      [bravo, 'ALPHA'],
    ]) {
      const ok = await page
        .waitForFunction(
          (r) => {
            const room = window.__nfRoom;
            const p = room && room.players.find((x) => x.name === r);
            return !!(p && p.snap);
          },
          rival,
          { timeout: 30_000 },
        )
        .then(
          () => true,
          () => false,
        );
      if (!ok) {
        barsOk = false;
        const roster = await page.evaluate(() => {
          const r = window.__nfRoom;
          return r
            ? r.players.map((p) => ({ name: p.name, snap: p.snap, result: p.result, left: p.left }))
            : null;
        });
        barDump += ` | ${rival}'s room: ${JSON.stringify(roster).slice(0, 200)}`;
      }
    }
    // A miss because this environment's WebGPU device was lost (the app shows
    // RENDERING FAILED) is an environment limit — skip the rest of the
    // rendering-heavy legs rather than fail. A miss with a live field is real.
    if (!barsOk && (await renderLost([alpha, bravo]))) {
      throw new GpuLostSkip('WebGPU device lost under the two-page versus render (no GPU here)');
    }
    step('rival snapshots stream into room state on both machines', barsOk, barDump);

    // 7b. Arcade 2P: ONE canvas renders both players' fields (uniform shared
    // background); the session exposes the rival view for testing.
    const [dualA, dualB] = await Promise.all(
      [alpha, bravo].map((p) =>
        p.evaluate(
          () =>
            document.querySelectorAll('canvas').length === 1 &&
            window.__nfSession.hasRival === true,
        ),
      ),
    );
    step('one canvas renders both fields on both machines', dualA && dualB);

    // 8. BRAVO quits mid-song — that's a DNF, not a room end: ALPHA sees the
    // finish on the bar and keeps playing; BRAVO lands back on song select
    // with the room dock still up.
    await quitSong(bravo);
    // ALPHA sees BRAVO's DNF land in room state (the quitter's result/done is
    // set), and keeps playing — the quit ends BRAVO's leg, not the room.
    await alpha.waitForFunction(
      () => {
        const p = window.__nfRoom?.players.find((x) => x.name === 'BRAVO');
        return !!(p && (p.result || p.done || p.left));
      },
      null,
      { timeout: 15_000 },
    );
    const stillPlaying = await alpha.evaluate(() => window.__nfSession.songNow > 0);
    step('a quit shows as a DNF while the local game keeps running', stillPlaying);
    await bravo.waitForFunction(
      () =>
        document.body.innerText.includes('ALL SONGS') &&
        // The global room dock still lists the host — the room survived the quit.
        document.body.innerText.includes('ALPHA'),
      null,
      { timeout: 15_000 },
    );
    step('the quitter is back on song select with the room dock alive', true);

    // 9. ALPHA quits too; the cycle ends and BOTH stay in the same room.
    await quitSong(alpha);
    await alpha.waitForFunction(
      () =>
        /▲▼ SONG|ALL SONGS/.test(document.body.innerText) &&
        document.body.innerText.includes('PICK A SONG FOR THE ROOM'),
      null,
      { timeout: 15_000 },
    );
    step('host exits to song select, room intact and asking for the next song', true);

    // ---- Scenario 2: the SAME room, next song — one the guests lack. ----
    // ALPHA drops a pack only it has and picks it; the announcement pulls the
    // files P2P to every guest. CHARLIE also joins mid-room via the invite
    // link, making it a 3-player race that ends on the standings.
    await alpha.evaluate(() => {
      const ssc = [
        '#TITLE:Transfer Test;',
        '#ARTIST:E2E;',
        '#MUSIC:song.wav;',
        '#OFFSET:0;',
        '#BPMS:0.000=120.000;',
        '#NOTEDATA:;',
        '#STEPSTYPE:dance-single;',
        '#DIFFICULTY:Hard;',
        '#METER:6;',
        '#NOTES:',
        '1000',
        '0100',
        '0010',
        '0001',
        ';',
      ].join('\n');
      // Small valid silent WAV (8 kHz mono 16-bit, 2 s).
      const rate = 8000;
      const samples = rate * 2;
      const b = new ArrayBuffer(44 + samples * 2);
      const v = new DataView(b);
      const w = (o, s2) => [...s2].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF');
      v.setUint32(4, 36 + samples * 2, true);
      w(8, 'WAVEfmt ');
      v.setUint32(16, 16, true);
      v.setUint16(20, 1, true);
      v.setUint16(22, 1, true);
      v.setUint32(24, rate, true);
      v.setUint32(28, rate * 2, true);
      v.setUint16(32, 2, true);
      v.setUint16(34, 16, true);
      w(36, 'data');
      v.setUint32(40, samples * 2, true);
      const fileAt = (path, content, type) => {
        const f = new File([content], path.split('/').pop(), { type });
        Object.defineProperty(f, 'webkitRelativePath', { value: path });
        return f;
      };
      const dt = new DataTransfer();
      dt.items.add(fileAt('Transfer Pack/Transfer Test/song.ssc', ssc, 'text/plain'));
      dt.items.add(fileAt('Transfer Pack/Transfer Test/song.wav', new Uint8Array(b), 'audio/wav'));
      const root = document.querySelector('#root')?.firstElementChild;
      root.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
    });
    await alpha.waitForFunction(() => document.body.innerText.includes('Transfer Test'), null, {
      timeout: 15_000,
    });
    // Walk the list until the dropped song is highlighted (BPM 120 is unique).
    for (let i = 0; i < 12; i++) {
      if (await alpha.evaluate(() => document.body.innerText.includes('BPM 120'))) break;
      await alpha.keyboard.press('ArrowDown');
      await alpha.waitForTimeout(150);
    }
    step(
      'host highlights the dropped song',
      await alpha.evaluate(() => document.body.innerText.includes('BPM 120')),
    );

    // CHARLIE joins the live room via the invite link (no song, no panel).
    const charlie = await playerPage(browser, base, 'CHARLIE', {
      stayOnGrid: true,
      query: `?join=${codeLdur}`,
    });
    await charlie.waitForFunction(() => document.body.innerText.includes('ALPHA'), null, {
      timeout: 30_000,
    });
    step('a third player joins the live room via the ?join= link', true);

    // ALPHA picks the new song — announced to the room; the guests pull the
    // files over the data channels and land on PLAYER OPTIONS.
    await alpha.keyboard.press('ArrowRight'); // the chart is HARD-only; move the diff cursor
    await alpha.waitForTimeout(200);
    await alpha.keyboard.press('Enter');
    await alpha.waitForFunction(() => /PLAYER OPTIONS/i.test(document.body.innerText), null, {
      timeout: 20_000,
    });
    for (const [page, who] of [
      [bravo, 'guest'],
      [charlie, 'third player'],
    ]) {
      await page.waitForFunction(
        () =>
          /PLAYER OPTIONS/i.test(document.body.innerText) &&
          document.body.innerText.includes('Transfer Test'),
        null,
        { timeout: 45_000 },
      );
      step(`${who} receives the song over P2P and reaches the room options`, true);
    }

    // Everyone readies; the 2 s song plays out to the standings reveal.
    await alpha.keyboard.press('Enter');
    await bravo.keyboard.press('Enter');
    await charlie.keyboard.press('Enter');
    for (const [page, who] of [
      [alpha, 'host'],
      [bravo, 'guest'],
      [charlie, 'third player'],
    ]) {
      await page.waitForFunction(() => /STANDINGS/.test(document.body.innerText), null, {
        timeout: 90_000,
      });
      step(`${who} reaches the standings`, true);
    }
    // The reveal is skippable: one confirm jumps to the final table (the
    // START — SKIP hint disappears once the show is over).
    await alpha.keyboard.press('Enter');
    await alpha.waitForFunction(
      () =>
        !document.body.innerText.includes('START — SKIP') && /WINNER/.test(document.body.innerText),
      null,
      { timeout: 10_000 },
    );
    step('standings reveal skips to the final table on confirm', true);
    // All three players are on everyone's standings.
    const standings = await bodyText(alpha);
    step(
      'standings list the whole room',
      ['ALPHA', 'BRAVO', 'CHARLIE'].every((n) => standings.includes(n)),
    );

    // CONTINUE returns to song select with the room STILL alive.
    await alpha.keyboard.press('Enter');
    const survived = await alpha
      .waitForFunction(
        () =>
          /▲▼ SONG|ALL SONGS/.test(document.body.innerText) &&
          document.body.innerText.includes('PICK A SONG FOR THE ROOM'),
        null,
        { timeout: 15_000 },
      )
      .then(
        () => true,
        () => false,
      );
    step(
      'the room survives a full race, ready for the next song',
      survived,
      survived ? '' : JSON.stringify((await bodyText(alpha)).slice(0, 200)),
    );
  }

  step('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  if (err instanceof GpuLostSkip) {
    skip(
      'gameplay rendering legs (rival snapshots, dual field, DNF, transfer, standings)',
      err.message,
    );
    // The device loss itself logs WebGPU errors — ignore those, still flag any
    // unrelated page error so real regressions in the legs that DID run surface.
    const other = pageErrors.filter((e) => !/webgpu|gpu|device.*lost|adapter/i.test(e));
    step('no unrelated page errors', other.length === 0, other.join(' | '));
  } else {
    step('suite completed', false, String(err));
  }
} finally {
  if (browser) await browser.close();
  await vite.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nall versus e2e checks passed');
