---
name: verify
description: How to build, launch, and drive stepzone (this repo's web app) to verify changes at the real UI surface.
---

# Verifying stepzone changes

Vite + React web app; the surface is the browser. No test-runner shortcuts —
drive the actual screens.

## Launch

```bash
npm run dev        # Vite; prints the port (5173, or next free — READ the output)
```

## Drive (headless Chrome via playwright-core)

No Playwright in this repo's deps and no downloaded browsers; use system
Chrome through `playwright-core` (install it in the scratchpad, not here):

```js
import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
```

- Headless runs get a fresh profile each launch — localStorage settings
  changes don't pollute the user's real browser, but they also don't persist
  between runs.
- Audio (AudioContext clock) runs fine headless with the autoplay flag; the
  bundled starter songs load with no local folder setup.

## Flows and hooks

- Song select → `Enter` picks the highlighted song → PLAYER OPTIONS.
- PLAYER OPTIONS is keyboard-driven: `ArrowUp/Down` rows, `ArrowLeft/Right`
  adjust, `Enter` = START. Row list is dynamic (ADVANCED header expands;
  PRACTICE LOOP adds rows).
- In gameplay (dev builds only), `window.__nfSession` is the live GameSession:
  `__nfSession.songNow` is the audible song position in seconds — the handle
  for asserting clock behavior (loops, seeks, rate).
- Song select ignores untrusted key events (`e.isTrusted` check) — Playwright
  CDP keys are trusted, `page.evaluate` dispatchEvent is not.

## Gotchas

- Port 5173 is often taken by the user's own dev server; parse the Vite banner.
- `npm run build` = `tsc --noEmit && vite build`; prettier is enforced
  (`npm run format:check`).
