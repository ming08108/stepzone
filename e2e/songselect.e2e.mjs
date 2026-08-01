/**
 * End-to-end suite for the song-select ↔ gameplay loop, driven through real
 * headless Chrome (system browser via playwright-core — no bundled binaries).
 * Starts its own Vite dev server on a spare port and always tears it down.
 *
 * What it pins that unit tests cannot:
 * - the full user flow: boot → song list → PLAY MODS → gameplay (audible clock
 *   advancing) → hold-to-quit → back to the list;
 * - the library store surviving screen unmounts (gameplay round-trips);
 * - blob-URL hygiene end to end: URL.createObjectURL/revokeObjectURL are
 *   wrapped in-page, a pack is loaded through the real drop path (banners +
 *   pack art actually minted), re-dropped (stale pack art must be revoked and
 *   replaced), and every blob URL still rendered as art must still decode.
 *
 * Run with `npm run e2e`. Requires Google Chrome on the machine.
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

// --- In-page fixtures -----------------------------------------------------------

const SSC = (title) =>
  `#TITLE:${title};\n#ARTIST:E2E;\n#BPMS:0.000=120.000;\n#BANNER:banner.png;\n` +
  `#NOTEDATA:;\n#STEPSTYPE:dance-single;\n#DIFFICULTY:Hard;\n#METER:5;\n` +
  `#NOTES:\n0000\n1000\n0000\n0001\n;\n`;

/** Build the E2E pack's Files and dispatch a real drop event on the app root. */
async function dropPack(page) {
  const mintedBefore = await page.evaluate(() => window.__urlLog.minted.length);
  await page.evaluate(
    ({ sscOne, sscTwo }) => {
      // 1×1 transparent PNG — a decodable image so blob art actually decodes.
      const PNG_B64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';
      const png = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
      // Small valid silent WAV (8 kHz mono 16-bit, 2 s) so songs are playable.
      const wav = (() => {
        const rate = 8000;
        const samples = rate * 2;
        const b = new ArrayBuffer(44 + samples * 2);
        const v = new DataView(b);
        const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
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
        return new Uint8Array(b);
      })();
      const fileAt = (path, content, type) => {
        const f = new File([content], path.split('/').pop(), { type });
        Object.defineProperty(f, 'webkitRelativePath', { value: path });
        return f;
      };
      const files = [
        fileAt('E2E Pack/Alpha Song/song.ssc', sscOne, 'text/plain'),
        fileAt('E2E Pack/Alpha Song/banner.png', png, 'image/png'),
        fileAt('E2E Pack/Alpha Song/song.wav', wav, 'audio/wav'),
        fileAt('E2E Pack/Beta Song/song.ssc', sscTwo, 'text/plain'),
        fileAt('E2E Pack/Beta Song/banner.png', png, 'image/png'),
        fileAt('E2E Pack/Beta Song/song.wav', wav, 'audio/wav'),
        fileAt('E2E Pack/banner.png', png, 'image/png'), // pack-root art
      ];
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      const root = document.querySelector('#root')?.firstElementChild;
      root.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
    },
    { sscOne: SSC('Alpha Song'), sscTwo: SSC('Beta Song') },
  );
  // The drop parses asynchronously; it is done once the pack's blob URLs land
  // (2 song banners + 1 pack art = at least 3 new mints).
  await page.waitForFunction(
    (before) => window.__urlLog.minted.length >= before + 3,
    mintedBefore,
    { timeout: 30_000 },
  );
}

/** The rail's pack-row art for a pack name. The redesigned rail paints art as
 *  a CSS background-image (no <img>), so read the computed style. */
const packRailArt = (page, pack) =>
  page.evaluate((name) => {
    for (const btn of document.querySelectorAll('button')) {
      if (!btn.textContent.includes(name)) continue;
      for (const el of btn.querySelectorAll('span')) {
        const m = getComputedStyle(el).backgroundImage.match(/url\("?(blob:[^")]+)"?\)/);
        if (m) return m[1];
      }
    }
    return null;
  }, pack);

/** Whether a blob URL still decodes as an image (a revoked URL errors). */
const urlDecodes = (page, url) =>
  page.evaluate(
    (u) =>
      new Promise((res) => {
        const img = new Image();
        img.onload = () => res(img.naturalWidth > 0);
        img.onerror = () => res(false);
        img.src = u;
      }),
    url,
  );

const bodyText = (page) => page.evaluate(() => document.body.innerText);

/** Wait until the rail shows blob art for the pack (and, if `notSrc` is given,
 *  a DIFFERENT url than before), then return the url. */
async function waitPackArt(page, pack, notSrc = null, timeout = 12_000) {
  await page
    .waitForFunction(
      ({ name, old }) => {
        for (const btn of document.querySelectorAll('button')) {
          if (!btn.textContent.includes(name)) continue;
          for (const el of btn.querySelectorAll('span')) {
            const m = getComputedStyle(el).backgroundImage.match(/url\("?(blob:[^")]+)"?\)/);
            if (m) return !old || m[1] !== old;
          }
        }
        return false;
      },
      { name: pack, old: notSrc },
      { timeout },
    )
    .catch(() => {});
  return packRailArt(page, pack);
}

/** Wait until the on-screen text contains `needle` (substring). */
const waitText = (page, needle, timeout = 20_000) =>
  page.waitForFunction((n) => document.body.innerText.includes(n), needle, { timeout });

/** Wait until the on-screen text changes from `prev` (for "the screen reacted"
 *  transitions where we don't have a stable target string). */
const waitChanged = (page, prev, timeout = 20_000) =>
  page.waitForFunction((p) => document.body.innerText !== p, prev, { timeout }).catch(() => {});

/** Press keys until we're back on the song-select screen. */
async function backToSongSelect(page) {
  for (let i = 0; i < 12; i++) {
    const txt = await bodyText(page);
    if (txt.includes('ALL SONGS') || txt.includes('LIBRARY')) return true;
    await page.keyboard.press(
      /WHERE THE POINTS WENT|RESULTS|GRADE|CLEARED|FAILED/i.test(txt) ? 'Enter' : 'Escape',
    );
    // Wait for the screen to react (text change) rather than a fixed delay.
    await waitChanged(page, txt, 8_000);
  }
  return false;
}

// --- Suite ----------------------------------------------------------------------

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
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      // Gameplay renders through WebGPU with no canvas fallback; unblock it in
      // headless/software environments (CI). Where no adapter exists at all,
      // the gameplay legs below are skipped.
      '--enable-unsafe-webgpu',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // This suite is about the library/gameplay loop — skip the first-load name
  // prompt (exercised by the leaderboard suite).
  await context.addInitScript(() => localStorage.setItem('notefield.net.namePrompted.v1', 'true'));
  // Wrap the object-URL API before any app code runs, so minted/revoked URLs
  // are observable from the tests.
  await context.addInitScript(() => {
    const log = { minted: [], revoked: [] };
    window.__urlLog = log;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (o) => {
      const u = create(o);
      log.minted.push(u);
      return u;
    };
    URL.revokeObjectURL = (u) => {
      log.revoked.push(u);
      revoke(u);
    };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));

  // 1. Boot: the 3-pane song select with the starter library.
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => document.body.innerText.includes('ALL SONGS'), null, {
    timeout: 30_000,
  });
  const boot = await bodyText(page);
  step('boots to song select with the starter library', boot.includes('Stepzone Starter'));

  // Gameplay needs a WebGPU adapter (no canvas fallback); probe once.
  const hasGpu = await page.evaluate(() =>
    navigator.gpu
      ? navigator.gpu
          .requestAdapter()
          .then((a) => !!a)
          .catch(() => false)
      : false,
  );

  // 2. Full gameplay round trip on a starter song (audible clock must run).
  if (hasGpu) {
    await page.keyboard.press('Enter'); // highlighted song → PLAY MODS
    await page.waitForFunction(() => /SCROLL SPEED/i.test(document.body.innerText), null, {
      timeout: 30_000,
    });
    step('reaches PLAY MODS', true);
    await page.keyboard.press('Enter'); // START
    await page.waitForFunction(() => !!window.__nfSession, null, { timeout: 30_000 });
    // Dev StrictMode can re-create the session shortly after mount; assert the
    // clock advances between two samples of the SAME session object.
    const advanced = await page.evaluate(async () => {
      for (let i = 0; i < 40; i++) {
        const s = window.__nfSession;
        const a = s.songNow;
        await new Promise((r) => setTimeout(r, 250));
        if (window.__nfSession === s && window.__nfSession.songNow > a + 0.1) {
          return `songNow ${a.toFixed(2)} → ${window.__nfSession.songNow.toFixed(2)}`;
        }
      }
      return null;
    });
    step('gameplay clock advances', advanced !== null, advanced ?? 'no advancing sample in 10s');
    // Hold-to-quit is durational (Back held past the threshold), so hold a fixed
    // span rather than waiting on a state.
    await page.keyboard.down('Escape');
    await page.waitForTimeout(1_500);
    await page.keyboard.up('Escape');
    step('hold-to-quit returns to song select', await backToSongSelect(page));
    const backTxt = await bodyText(page);
    step('library survives the gameplay round trip', /Stepzone Starter|ALL SONGS/.test(backTxt));
  } else {
    skip('gameplay round trip on a starter song', 'no WebGPU adapter in this environment');
  }

  // 3. Load a pack through the real drop path (mints banners + pack art).
  await dropPack(page);
  step('dropped pack appears in the rail', (await bodyText(page)).includes('E2E Pack'));
  const minted1 = await page.evaluate(() => window.__urlLog.minted.length);
  step('drop minted banner/pack-art blob URLs', minted1 >= 3, `${minted1} minted`);
  const art1 = await waitPackArt(page, 'E2E Pack'); // wait for the rail art
  step(
    'pack rail art renders from a blob URL',
    !!art1 && (await urlDecodes(page, art1)),
    art1 ?? 'no rail art',
  );

  // 4. Re-drop the same pack: fresh scan replaces pack art, stale URL revoked.
  await dropPack(page);
  // Wait for the rail row to re-render with a NEW blob url.
  const art2 = await waitPackArt(page, 'E2E Pack', art1 ?? null);
  const revoked = await page.evaluate(() => window.__urlLog.revoked);
  step('re-drop replaces the pack art URL', !!art2 && !!art1 && art2 !== art1);
  step('stale pack art URL was revoked', !!art1 && revoked.includes(art1));
  step('replacement art still decodes', !!art2 && (await urlDecodes(page, art2)));

  // 5. Play a dropped song end to end (real parse → charts → audio → clock).
  if (hasGpu) {
    await page.keyboard.press('Escape'); // list pane → collection rail
    await page.keyboard.press('ArrowDown'); // All songs → E2E Pack (first pack)
    await page.keyboard.press('Enter'); // show the pack's songs (back to list)
    await waitText(page, 'Alpha Song');
    await page.keyboard.press('ArrowRight'); // the E2E charts are HARD-only; move the diff cursor
    await page.keyboard.press('Enter'); // Alpha Song → PLAY MODS
    await page.waitForFunction(() => /SCROLL SPEED/i.test(document.body.innerText), null, {
      timeout: 30_000,
    });
    await page.keyboard.press('Enter'); // START
    await page.waitForFunction(() => !!window.__nfSession, null, { timeout: 30_000 });
    step('a dropped song starts gameplay', true);
    step('back to song select after the dropped song', await backToSongSelect(page));
  } else {
    skip('gameplay on a dropped song', 'no WebGPU adapter in this environment');
  }

  // 6. Hygiene: every revoked URL was minted; every blob URL still painted as
  //    art (CSS background-image) must still decode.
  const log = await page.evaluate(() => window.__urlLog);
  step(
    'every revoked URL was one we minted',
    log.revoked.every((u) => log.minted.includes(u)),
  );
  const painted = await page.evaluate(() => {
    const urls = new Set();
    for (const el of document.querySelectorAll('*')) {
      const m = getComputedStyle(el).backgroundImage.match(/url\("?(blob:[^")]+)"?\)/);
      if (m) urls.add(m[1]);
    }
    return [...urls];
  });
  const broken = [];
  for (const u of painted) if (!(await urlDecodes(page, u))) broken.push(u);
  step(
    'no painted blob art is broken (revoked/leaked src)',
    broken.length === 0,
    broken.join(', '),
  );

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
console.log('\nall e2e checks passed');
