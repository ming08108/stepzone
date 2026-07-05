# Code Review — Maintainability & Quality Suggestions

_Generated 2026-07-04 by a multi-agent Claude Code review (12 independent reviewers → 118 raw findings → consolidated to 45 → every finding adversarially re-verified against the code → +5 more from a completeness pass; 0 findings failed verification)._

_Scope: maintainability and code quality — **no code was changed**. Verified against `master` @ `7d6e951` (review started on the `notefield-todos2` worktree, which was merged/removed mid-review; all line numbers were re-confirmed against `master` and may drift a few lines as work continues)._

## Status (fix pass, 2026-07-04 evening)

A fix pass addressed every finding that stays clear of the in-flight theme work (song-select/Play/PlayerOptions screens and `noteField.ts`). Full suite green afterwards: 190 tests / 24 files, `tsc --noEmit` clean with the two new strictness flags.

- **Fixed:** #6 (was already fixed in-tree), #9, #10, #12, #13, #19, #21, #26, #30, #31, #32, #35, #36, #37, #38, #41, #42, #43, #44, #46, #47, #49, and the non-UI test targets of #4 (scoring, scores merge, judge branches, delays/fakes, ssc split timing, parse warnings, remoteLibrary, songLibrary safePath/Range, settings validation).
- **Partially fixed:** #3 (shared `src/input/gamepadEdges.ts` + both hooks; ~~Play/GamepadSettings/session adoption pending~~ → completed by the input unification pass below), #14 (decode failure now logs a warning; UI notice pending), #15 (`src/app/storage.ts` + four sites routed; gamepad persistence since unified into the settings store — see below; PlayerOptions + catalogUrl pending), #16 (shared `src/game/playOptions.ts`; `SessionConfig` is now that exact type — a `toSessionConfig` helper in Play pending), #20 (warnings reach the loader boundary; UI surfacing pending), #33 (CI workflow + `noUnusedParameters`/`verbatimModuleSyntax` flipped; linter pending), #45 (`WindowKey` exported; `scale`/`add` knobs left as-is), #48 (background-extension whitelist shared; `formatBpmRange` pending).
- **Fixed (theme refactor pass, 2026-07-04 night):** #5 (pure scroll/cull module `src/render/scroll.ts` + `tests/scroll.test.ts`), #11 (the shared passes — cursor advance, holds, note loop, receptors, explosions, combo pop-state — live once in the `NoteFieldRenderer` orchestrator; the two looks are `Theme` implementations under `src/render/themes/`), #24 (single `NoteFieldConfig` whose defaults derive from `DEFAULT_PLAY_OPTIONS`; `applyConfig()`/`resize()` reset the cull cursor on geometry changes; the 200-BPM fallback is one constant via `songMaxBpm()`), #25 (design-grid constants named, the 1280×720 comment corrected, `ANGLES` deleted in favor of `columnAnglesFor`), and the renderer side of #22 (all Judge note-state reads centralized in scroll.ts's read-only helpers; `judge.ts` untouched). The 'arcade' skin is now a procedural DDR A3 theme and the default noteSkin; 'itg' (Simply Love) extracted verbatim. Suite after: 213 tests / 25 files, `tsc --noEmit` clean.
- **Deferred (theme-agent collision risk — UI/renderer files under active edit):** #1, #2, #7, #8, #17, #18, #23, #27, #28, #29, #34 (zip may be an active design reference; todo files in use), #39, #40, #50.
- Behavior change worth knowing: `'novice'` now maps to Beginner in **both** engine and catalog (#9); engine previously returned `Invalid`. Verified against ITGmania's `Difficulty.cpp` conventions and covered by tests.
- **Fixed (input unification pass, 2026-07-04 night):** #3 **complete** — keyboard and gamepad are one role-based system. `src/input/controls.ts` defines the shared `ControlRole` vocabulary (+ role↔column style table + the ONE `Bindings` model, persisted inside `notefield.settings.v1` with one-time migration from the old `keybindings` field and `notefield.gamepadBindings.v1` key, legacy key deleted after write-back); `src/input/inputBus.ts` is the single input subsystem (keyboard listeners with real timestamps + THE one shared rAF gamepad poll via a new `createTransitionDetector` in gamepadEdges.ts, running only while subscribed). `session.ts` no longer polls the pad at all — the engine is device-agnostic, driven purely by `press()`/`release()`. Converted consumers: Play (gameplay columns + ready/done overlays), `useMenuNav` (both devices through the bus), `useGamepadKeys` (now a thin bus→synthetic-key adapter for the entrenched SongSelectStepline/PlayerOptions keydown handlers). `GamepadSettings.tsx` deleted: Options has ONE CONTROLS section where every role shows its keyboard key(s) and pad button, both press-to-bind (`pressedGamepadButtons()` capture only runs while binding; the bus is muted during capture). `input/gamepad.ts` is now a stateless reader (bindings passed in); `input/keymap.ts` deleted (its table lives in controls.ts — closes the rest of #32). Also the gamepad-persistence leftover of #15 (all binds now live in the settings store; `stepline.options` + catalogUrl still pending). New tests: controls, inputBus, transition detector, bindings migration. Suite after: 252 tests / 28 files, `tsc --noEmit` + `vite build` clean.

- **Fixed (settings-split pass, 2026-07-04 night):** #2 **complete** — `src/app/settings.ts` is the single owner of scroll speed / background: the `stepline.options` store is deleted; PlayerOptions reads/writes the one settings store through `useSettings()` (changes apply live, persist, and drive the shared `NoteFieldPreview`), so START no longer copies values around. `loadSettings` performs a one-time migration mapping legacy `{scrollType, cmod, xmod (or pre-rename speed), bg}` onto `scrollMode`/`scrollValue`/`bgMode` (old `loadOpts` semantics; an out-of-range bg index is dropped instead of persisting `bgMode: undefined`), then removes the key; the drifted CMod clamps (100–1000 / 100–1200) unify on `normalizeSettings`' 50–2000. This also closes the `stepline.options` leftover of #15 (catalogUrl still pending). The screens were re-split on a global-vs-per-play principle: **Options** keeps only system settings (SYNC / OFFSET + calibrate, DISPLAY with the WebGPU aurora, the unified CONTROLS table) and **Player Options** owns every DDR-style play mod — SCROLL TYPE (now including MMod), SPACING, DIFFICULTY, TURN, SCROLL DIR, APPEARANCE, NOTE SKIN, MUSIC RATE, BACKGROUND — each a ◀▶ row with help text for the highlighted option; no setting appears on both screens. Migration covered by six new tests in `tests/settings.test.ts`. Suite after: 258 tests / 28 files, `tsc --noEmit` + `vite build` clean.

## Themes

1. **The STEPLINE rewrite left dead twins behind.** The old `SongSelect.tsx` (509 lines) still ships but is unreachable, and it was the only consumer of favorites, best-score display, `PadIcon`, the Inspector entry point, and song-select error surfacing — so those features silently regressed out of the app while their code still looks live.
2. **Copy-paste is the dominant pattern.** The same logic exists in 2–5 places across: gamepad edge-detection, the two noteskin draw paths, the `.sm`/`.ssc` header parsers, difficulty-slot mapping, theme colors, Settings↔SessionConfig, keymaps, the scripts vs. engine parsers, and localStorage plumbing. Several pairs have **already drifted**.
3. **Persistence is fragmented.** Five hand-rolled localStorage sites, three key conventions, two competing persisted stores for scroll speed/background, and validation applied inconsistently at load boundaries.
4. **Tests cover parsing/timing well but not policy or UI logic.** Grades, score merging, judge edge branches, split timing, the song-server path-traversal guard, and all pure logic trapped inside components are untested.
5. **Missing guardrails.** No CI, no linter, no React error boundary, free tsconfig strictness flags left off, and a handful of comments/docs that describe code that doesn't exist.

---

## High priority

### 1. Delete the dead `SongSelect.tsx` and rescue the features stranded in it

`src/ui/SongSelect.tsx:87` — `App.tsx:5` imports `SongSelect` from `./SongSelectStepline`; nothing imports `./SongSelect`. The 509-line orphan duplicates the live screen (`mergeEntries` byte-identical; the difficulty palette has already drifted) and exports the same component name, so auto-import can resurrect the wrong file. It is the **sole consumer** of `PadIcon.tsx`, `loadFavorites`/`saveFavorites` (`src/app/favorites.ts`), and `loadScores`/`totalStats` (`src/app/scores.ts`) — favorites and per-song best-score display are currently unreachable while `Play.tsx` still records scores.
**Suggestion:** Delete `SongSelect.tsx`; port favorites, best-score display, error surfacing, and the catalog-URL input into `SongSelectStepline` (or delete their orphaned dependencies); consider renaming `SongSelectStepline.tsx` → `SongSelect.tsx` afterwards.

### 2. Make `src/app/settings.ts` the single owner of scroll speed / background

`src/ui/PlayerOptions.tsx:204` — PlayerOptions keeps its own `{speed, bg}` in the unversioned localStorage key `stepline.options`, separate from `notefield.settings.v1` which already owns `scrollMode`/`scrollValue`/`bgMode`. On START, `go()` writes those into Settings, so every play silently clobbers what the Options screen set. `loadOpts` (line 47) JSON-parses without typing or clamping, so a stale `bg` index can persist `bgMode: undefined` into Settings past `normalizeSettings`. CMod clamp ranges have drifted three ways (100–1000 vs 100–1200 vs 50–2000).
**Suggestion:** Have PlayerOptions read/write through `useSettings()` and delete the `stepline.options` store (with a one-time migration read). If per-play overrides shouldn't persist, pass them in the `PlayRequest` instead of mutating global settings. Until then, type and clamp `loadOpts`.

### 3. Extract one gamepad edge-detection utility (currently 5 hand-copies, 2 nav paradigms)

`src/ui/Play.tsx:192` — the seeded rising-edge rAF poll (seed flag so a held button isn't a press, prev-state diff, re-seed on disconnect) is independently implemented in `Play.tsx:192-209`, `useGamepadKeys.ts:23-51`, `useMenuNav.ts:71-90`, `GamepadSettings.tsx:45-74`, and inside the engine loop at `session.ts:229-237` (which couples the engine to the input singleton and localStorage bindings). The two hooks are also competing paradigms: `useMenuNav` walks DOM focus; `useGamepadKeys` dispatches synthetic KeyboardEvents.
**Suggestion:** One `useGamepadEdges(onPress)` hook/utility owning poll + seeding + edge detection; build the others on it. Move `GameSession`'s gamepad polling out to the input layer, feeding the session via `press()`/`release()`. Longer term, converge menus on one navigation model.

### 4. Add tests for the untested policy-heavy pockets

`src/gameplay/scoring.ts:95` — zero coverage for: grade tiers/`tapGradePoints`; `recordPlay`'s best-merge policy (`src/app/scores.ts:48-66`, drives the NEW RECORD display); judge branches for rolls, lifts, hold LetGo, AvoidMine (`judge.ts:213-226, 249-250, 282-286, 313-314`); DELAY segments and fake regions (`timingData.ts:241-257, 331-339`); `parseSsc` split timing and `parseWarps` versioning; `remoteLibrary` URL resolution; `session.ts`; and `scripts/songLibrary.ts`'s `safePath` + Range parsing (lines 164–207 — the only guard between `/songs` and arbitrary file reads, currently outside vitest's include).
**Suggestion:** `scoring.test.ts`, `scores.test.ts` (split the pure merge from localStorage first), judge tests for roll decay/LetGo/lifts/AvoidMine/delay, `ssc`/`timingTags` split-timing tests, a mocked-fetch `remoteLibrary` test, and `songLibrary.test.ts` for `safePath` (encoded `..`, absolute paths) and Range edges.

### 5. Split the 977-line `NoteFieldRenderer` so its pure math is testable

`src/render/noteField.ts:120` — one class owns background compositing, layout, scroll math (`yOf`, 256–266), appearance mods, culling, two full noteskins, and two HUDs. The core logic is pure math but private and only reachable through canvas calls — scroll modes C/X/M, reverse, and the forward-only culling cursor have zero coverage.
**Suggestion:** Extract a pure scroll/cull module (`yOf`, appearance alpha, cull predicates, window cursor) with unit tests, plus a HUD renderer and noteskin drawing; the class composes them.

### 6. Separate the miss horizon from hold/roll drop-timers

`src/gameplay/windows.ts:39` — `maxWindowSeconds()` maxes over hit windows **and** hold(0.25s)/roll(0.5s) drain timers, and Judge uses that as the miss horizon (`judge.ts:104, 274`) — so a tap that stops being hittable at w5=0.18s isn't marked Miss until ~0.5s. The verifier confirmed a bonus consequence: during that lag the stale note remains the nearest candidate, swallowing presses aimed at the next note. Miss offset is recorded as `this.maxWindow` (`judge.ts:287`), stamping a rate-scaled roll-timer value as a tap timing error.
**Suggestion:** Miss horizon = `max(w5, mine)` only; keep hold/roll as separately named drop-timer fields; use a sentinel (or w5) for the recorded miss offset.

### 7. Rewire or remove the Inspector (currently unreachable)

`src/ui/SongSelectStepline.tsx:106` — `onInspect` is declared in the props type but never destructured, so the callback `App.tsx:80` passes is silently dropped (legal TS, nothing flags it). That makes App's `'inspect'` branch (`App.tsx:66-72`), the `Chrome` wrapper (`App.tsx:13-39`), and all 209 lines of `Inspector.tsx` unreachable while still shipping in the bundle. `Inspector.tsx:200` also hardcodes a fixture-specific "← 0.5s stop here" annotation that would mislabel any other chart.
**Suggestion:** Either wire an Inspect entry point into the STEPLINE UI and derive the stop annotation from parsed timing data, or remove the prop, the branch, the wrapper, and `Inspector.tsx`.

### 8. Surface errors in the live song select

`src/ui/SongSelectStepline.tsx:223` — `start()` awaits remote loads that throw on network failure and is invoked as `void start()` (lines 283, 529) with no try/catch: pressing Enter on a remote song while offline does nothing. `onDrop` (294–306) is try/finally with no catch and discards `loadLibraryFromFiles` warnings, so a pack whose simfiles all fail to parse yields an empty drop with zero feedback; the catalog effect (156) swallows failures of the saved URL. The dead `SongSelect.tsx` handled all three — this is a regression from the UI swap.
**Suggestion:** Add an error state (toast/strip or the hint bar); wrap `start()`/`onDrop()` bodies in try/catch; show warnings when zero entries load.

### 9. Stop the scripts from re-implementing engine logic (drift is already user-visible)

`scripts/songLibrary.ts:68` — `readSongMeta()` is a second, regex-based simfile parser beside the tested MSD tokenizer, and `DIFF_SLOT` (12–32) duplicates `oldStyleStringToDifficulty()` with real drift: `'novice'` maps to Beginner in the catalog but `Difficulty.Invalid` in the engine, and slot 4 is labeled "Expert" vs the engine's Challenge. The ssc-over-sma-over-sm preference is duplicated (`songLibrary.ts:132-135` vs `songFiles.ts:33-39`).
**Suggestion:** Export the alias table from `src/song/difficulty.ts` and reuse it; reuse the MSD tokenizer (or add a fixture test proving the lightweight scan agrees with the real parser).

---

## Medium priority

### 10. `engine.ts` claims a module boundary that doesn't exist

`src/engine.ts:2` — the header (and `README.md:59-60`) says "The React app and tests import from here", but nothing imports it; every UI/test file deep-imports subfolders, and `src/parse/index.ts` is only imported by this dead barrel. The barrel also omits most of what the app actually uses.
**Suggestion:** Delete `engine.ts` + `parse/index.ts` and fix the README — or make the boundary real (complete the exports, migrate imports, enforce with `no-restricted-imports`).

### 11. `draw()` (arcade) and `drawItg()` share ~200 duplicated lines

`src/render/noteField.ts:740` — cursor advance (427–435 vs 740–748), holds pass, note-loop skip conditions, receptor loop, judgment keyframes, and combo pop-state are copied between the two skin paths, plus parallel constant tables (`QUANT_COLOR`/`ITG_QUANT_COLOR`, `JUDGMENT`/`ITG_JUDGMENT`).
**Suggestion:** Factor shared passes into private methods parameterized by a small per-skin strategy object; `draw()`/`drawItg()` become thin style configs.

### 12. `.sm`/`.ssc` song-header parsing duplicated wholesale

`src/parse/sm.ts:16` — `parseDisplayBpm` is duplicated character-for-character and ~17 tag switch cases are byte-identical between `sm.ts:39-102` and `ssc.ts:71-160`; ssc has already gained tags sm didn't.
**Suggestion:** Shared `applySongHeaderTag(song, tag, value): boolean` + `parseDisplayBpm` in a common module; each parser keeps only format-specific cases.

### 13. Persisted JSON trusted via unsafe cast; `normalizeSettings` never runs on load

`src/app/settings.ts:69` — `JSON.parse(raw) as Partial<Settings>` with no shape/range validation; `SettingsContext.tsx:12` seeds state with the raw result and only normalizes inside `update()`. Same pattern in `scores.ts:26`, `favorites.ts:13`, `gamepad.ts:52`.
**Suggestion:** Make load the single sanitization point: validate union fields against runtime const arrays, clamp numbers, return `normalizeSettings(merged)` from `loadSettings`.

### 14. Corrupt song audio silently degrades to a metronome

`src/game/session.ts:191` — when `decodeAudioData` fails, a bare `catch {}` swaps in a click track. `usingRealAudio` (line 65) exists to surface exactly this but is written (195) and never read.
**Suggestion:** Read it in `Play.tsx` after `session.start()` and show a small notice — or delete the flag if the fallback is intentionally silent.

### 15. localStorage plumbing fragmented across five drifting sites

`src/ui/PlayerOptions.tsx:168` — settings/favorites/scores/gamepad/PlayerOptions each hand-roll try/catch persistence; only `gamepad.ts` guards `typeof localStorage`; PlayerOptions' save has no try/catch at all (throws in private mode inside a useEffect); keys split between `notefield.*.v1` and bare `stepline.options`. `SongSelectStepline.tsx:151` reads `notefield.catalogUrl`, whose only writer is the dead `SongSelect.tsx`.
**Suggestion:** A tiny `src/app/storage.ts` with guarded `loadJson<T>`/`saveJson`; route all sites through it; move gamepad-binding persistence into `app/` leaving `input/` pure; unify key naming; port or delete the catalog-URL branch.

### 16. `SessionConfig` hand-duplicates `Settings` across three files

`src/game/session.ts:40` — `SessionConfig` re-spells ten Settings fields with inline unions (`'C'|'X'|'M'` etc.), `DEFAULT_SESSION_CONFIG` duplicates `DEFAULT_SETTINGS` values, and `Play.tsx:218-229` copies the fields one by one — no compiler help when they drift.
**Suggestion:** Define the option unions + a shared `PlayOptions` base in an engine-side module (engine must not depend on `app/`); Settings extends it, SessionConfig `Pick<>`s it, and Play gets one `toSessionConfig(settings)` helper.

### 17. Difficulty-slot mapping re-derived three times

`src/ui/PlayerOptions.tsx:20` — `slotOf()` with the hardcoded canonical list is copy-pasted verbatim (including its comment) in PlayerOptions and SongSelectStepline, and the filter/bucket/highest-meter algorithm is re-derived in three places that must agree exactly. Root enabler: `CANONICAL` in `difficulty.ts:13` is `readonly string[]`, so consumers key unchecked string tables — and the enum's numeric value already IS the slot index.
**Suggestion:** `CANONICAL as const`, export a `DifficultyName` type, move `slotOf` + a `chartsBySlot`/`deriveLevels` helper next to `difficulty.ts`, unit-test it, import everywhere.

### 18. Theme constants and Stage chrome forked per screen

`src/ui/Play.tsx:65` — `DIFF_COLOR` duplicated in Play + PlayerOptions + positionally in SongSelectStepline (dead SongSelect shows the drift endgame); `JUDGMENT_ROWS` duplicates the renderer's own table (`noteField.ts:47-55`); accent `'#ff4d3d'` re-declared in three files despite `Stage.tsx:8` exporting `STEP_AC`; SongSelectStepline hand-copies Stage's header/footer markup (344–357, 567–572).
**Suggestion:** `src/ui/theme.ts` exporting the difficulty palette (keyed by `Difficulty`), judgment table, and accent; render SongSelectStepline inside `<Stage>` extended with the extras it needs.

### 19. Remote library: catalog frozen forever by cache-first; `ensureRemoteLoaded` isn't idempotent

`src/io/remoteLibrary.ts:58` — `cachedFetch` serves any previously seen URL from Cache Storage forever with no revalidation/TTL — including the mutable `catalog.json`, so returning users never see server-side additions. `ensureRemoteLoaded` is documented "Idempotent" but never writes the parsed Song back to the entry, so `SongSelectStepline` and `songPreview` re-parse the same simfile on every preview/play.
**Suggestion:** Network-first for the catalog (cache as offline fallback), cache-first only for immutable per-song assets; assign the parsed song onto `entry.song`.

### 20. Three disconnected parse-warning mechanisms, all discarded

`src/parse/sm.ts:26` — `parseSm`'s warnings out-param is never passed by the only entry point (`loader.ts:18`); `parseSsc` has no warnings channel; `Steps.noteWarnings` (`steps.ts:45`) is collected but never read. Real problems in untrusted simfiles are invisible.
**Suggestion:** One channel — thread a warnings array (or `{song, warnings}` result) through `parseSimfile`/`parseSm`/`parseSsc`; surface `noteWarnings` or delete it.

### 21. Dead `TapNote.result`/`holdResult` fields with a comment inviting shared-reference mutation

`src/notes/noteTypes.ts:177` — never read or written (Judge keeps state on its own `ActiveNote`); the "attached lazily by the gameplay engine" comment is false and invites mutating notes shared by reference between cached Steps and play copies. `beatToNoteRowNotRounded`, `noteTypeToRow`, `MAX_NOTE_TRACKS` also unused.
**Suggestion:** Delete the fields + result interfaces (or move next to Judge if planned), fix the comment, prune the helpers.

### 22. Renderer reads Judge's mutable internals; `hidden` is presentation state in the gameplay model

`src/gameplay/judge.ts:44` — `ActiveNote.hidden` exists purely so the renderer stops drawing (set unconditionally in `applyTapScore`, even for Misses), and `noteField.ts` reaches into `n.hidden`/`n.holdLife`/`n.holdResolved`/`n.tns` in **both** skin paths.
**Suggestion:** Derive visibility from judged state (`tns !== None`) in the renderer, or expose a narrow read-only view type from Judge.

### 23. Judge keeps two sources of truth for live holds

`src/gameplay/judge.ts:214` — `activeHolds` exists to avoid full-lane scans (per its own comment), yet `step()`'s roll-refill re-scans the whole lane per press, the nearest-candidate search is unbounded, and the `!activeHolds.includes(cand)` guard at 265 is provably dead.
**Suggestion:** Drive roll refill from `activeHolds` filtered by track; bound the candidate search around the miss cursor/time window.

### 24. Renderer configured via 9 imperative setters with drifting defaults and resettable-but-never-reset cursor state

`src/render/noteField.ts:163` — field defaults shadow `DEFAULT_SESSION_CONFIG` and disagree (style `'arcade'` vs noteSkin `'itg'`; the 200-BPM fallback written three ways; scrollValue 550 duplicated). `firstVisibleIdx` assumes monotonic scroll but no setter resets it — correctness depends on the unwritten rule that GameSession builds a fresh renderer per play.
**Suggestion:** Single options object in the constructor (or `applyConfig(config)` typed against SessionConfig's render subset); hoist shared fallbacks to one constant; add a `reset()` called by geometry-changing setters.

### 25. Layout magic numbers, a contradictory design-reference comment, and a duplicated ANGLES table

`src/render/noteField.ts:207` — `resize()` says "design reference is 1280x720" but computes `Math.min(height/720, width/720)`; the design grid lives as inline literals; `ANGLES` (69) re-encodes the direction table from `columns.ts` as a mostly-dead fallback that can drift from the tested copy.
**Suggestion:** Name the design-grid constants, fix or clarify the comment, delete `ANGLES` in favor of `columnAnglesFor`/shared constants.

### 26. WebGPU device-loss handler is a no-op that contradicts its own comment

`src/render/shaderBackground.ts:115` — the comment promises degradation to the Canvas fallback, but the code is `device.lost.then(() => {}).catch(() => {})`; `lost` is only set if `render()` throws, and most operations on a lost device don't throw — so dead work is submitted every frame.
**Suggestion:** `device.lost.then(() => { this.lost = true; })` in `create()`.

### 27. `SongSelectStepline` traps pure logic in a 575-line component with a module-level singleton and a fragile keydown effect

`src/ui/SongSelectStepline.tsx:64` — `deriveLevels`, `bpmText`, and the virtual-window math are untestable inside the component; `savedFilters` (41–48) is a mutable module singleton mutated by a dep-array-less effect; the monolithic keydown effect re-subscribes on every arrow press and its "typing" guard checks only `tagName === 'INPUT'` (vs the broader guard `useMenuNav.ts:44` already has).
**Suggestion:** Extract the pure functions into `src/ui/songSelectModel.ts` with tests; lift filter state or persist via the `app/` pattern; `useCallback` the closures; align the typing guard.

### 28. PlayerOptions is a third navigation system with a deps-less window listener

`src/ui/PlayerOptions.tsx:225` — Options uses `useMenuNav`, Play's overlay uses an inline poll, PlayerOptions uses `useGamepadKeys` + a bespoke keydown effect with no dependency array whose Escape handling duplicates `useMenuNav`.
**Suggestion:** Give the effect a deps array (refs for `adjust`/`go`, as Play does with `bindsRef`) and extend `useMenuNav` with a row mode so PlayerOptions and SongSelectStepline share it.

### 29. `Play.tsx` handles nine concerns in one 417-line file

`src/ui/Play.tsx:112` — session lifecycle, object-URL background cleanup, WebGPU attach/teardown, keyboard wiring, gamepad overlay, fullscreen, FPS meter, ready overlay, and the entire results screen. Score-display changes currently require editing the same file that manages fragile resource cleanup.
**Suggestion:** Extract a `ResultsScreen` component (Result type, judgment table, `OffsetGraph`), leaving Play as the orchestrator.

### 30. No React error boundary — any render/effect throw white-screens the game

`src/main.tsx:23` — an uncaught error in any component unmounts the whole root mid-game with no message. Concrete trigger exists today (unguarded `localStorage.setItem` in PlayerOptions' effect, throws in Safari private mode).
**Suggestion:** Wrap `<App />` in a small ErrorBoundary with the error message and a "back to song select" reset.

### 31. One bad file read crashes the song server

`scripts/songLibrary.ts:209` — `createReadStream(file).pipe(res)` (lines 204, 209) attaches no `'error'` listener; an unhandled stream error kills the long-lived server (and the same code runs in the Vite middleware). The `statSync` guard doesn't cover mid-stream failures.
**Suggestion:** `.on('error', ...)` per stream — destroy the response or end a 500 if headers aren't sent.

### 32. Default keymap maintained in two files; dead labels export

`src/input/keymap.ts:6` — `DANCE_SINGLE_KEYMAP` and `DEFAULT_KEYBINDINGS` (`settings.ts:37-46`) are byte-identical 8-entry maps; `keyToColumn`'s default parameter is never exercised; `DANCE_SINGLE_LABELS` has zero references.
**Suggestion:** One canonical map in `input/keymap.ts`, imported by `settings.ts`; delete or use the labels.

### 33. No CI, no linter; free strictness flags disabled

`package.json:28` — nothing prevents commits that break tests/typecheck; Prettier catches no correctness-adjacent issues (hook deps, floating promises). Verified: enabling `noUnusedParameters` and `verbatimModuleSyntax` today produces **zero errors** (`noUncheckedIndexedAccess` measured at 188 errors — reasonably deferred).
**Suggestion:** Minimal CI (`typecheck && test && format:check`); typescript-eslint or oxlint with react-hooks rules; flip the two free flags now.

### 34. 3MB binary zip and scratch todo files committed to the repo root

`DDR song select screen.zip` — git-tracked, bloats every clone forever; `vite.config.ts:59` even adds a watcher-ignore for `**/*.zip` to work around it. `todo.txt` is a stale status report duplicating `docs/ROADMAP.md`; `todos2txt.txt` is active scratch — fold, don't just delete.
**Suggestion:** Remove the zip from version control (extract any needed reference into `docs/`), fold the todo files into `docs/ROADMAP.md`, add `*.zip` to `.gitignore`.

### 35. README is several milestones stale and contradicts the code

`README.md:47` — marks `input/`/`render/`/`gameplay/`/`game/` as "[next]" though all are implemented; claims "34 unit tests" (there are 13 files / ~47 blocks); says the judgment engine is "next up" (shipped in M2); `docs/ROADMAP.md:72` defers mirror/turn mods that `transforms.ts` implements with tests.
**Suggestion:** Update status/architecture/roadmap sections; drop hard-coded test counts.

### 36. Every play and calibration run leaks a live `AudioContext`

`src/audio/clock.ts:84` — `WebAudioClock` creates a context (line 30) but `stop()` never calls `ctx.close()`; GameSession builds one clock per session and Play a fresh session per play/retry; Calibrate creates another per START press. Browsers cap concurrent contexts. Three different context-lifetime strategies coexist (songPreview keeps a deliberate singleton).
**Suggestion:** Add `dispose()` awaiting `ctx.close()`, called from `GameSession.stop()` and Calibrate — or share one long-lived context, as songPreview already does.

### 37. Committed developer-machine path as the default songs root; missing root silently yields an empty catalog

`vite.config.ts:14` — `'C:/Games/ITGmania/Songs'` is the committed default in two files, and `scanCatalog`'s try/catch swallows the missing directory, so new contributors get an inexplicably empty song list instead of a configuration error.
**Suggestion:** One shared default (or require `SONGS_DIR`), plus a clear warning when the root doesn't exist.

---

## Low priority

### 38. Song-serving glue duplicated between the Vite plugin and standalone server

`vite.config.ts:13` / `scripts/song-server.ts:25` — the 60s catalog cache, `/catalog.json` route, and safePath-then-sendFile dispatch are copied, and have drifted (CORS/OPTIONS/HEAD only in the standalone server). **Suggestion:** move the cached-catalog factory + request handler into `scripts/songLibrary.ts`; layer CORS in the standalone server only.

### 39. `session.start()` awaited without a catch after committing to the 'playing' phase

`src/ui/Play.tsx:292` — a rejection (AudioContext resume/clock start) leaves a frozen black canvas. **Suggestion:** try/catch → `setPhase('ready')` + error text on the overlay.

### 40. `PadIcon` re-implements steps-type track counts, already stale

`src/ui/PadIcon.tsx:8` — missing `pump-routine`/`techno-double*`, falls back to a wrong 4-panel pad; the engine table has correct counts. Only reachable via dead code — resolve together with #1. **Suggestion:** thin wrapper over `stepsTypeNumTracks`, or delete with `SongSelect.tsx`.

### 41. Hard-coded `0.7` bypasses `VERSION_SPLIT_TIMING`

`src/parse/ssc.ts:175` — literal duplicates `timingTags.ts:19`'s constant, and the `version === 0` special case is duplicated too. **Suggestion:** a single `supportsSplitTiming(version)` helper in `timingTags.ts`.

### 42. `cloneTiming` in the parse layer hand-maintains TimingData's twelve-field list

`src/parse/timingTags.ts:133` — a new TimingData segment list would be silently dropped for split-timing charts with no compile error. **Suggestion:** move to a `clone()` method on `TimingData`, next to the field declarations.

### 43. `engines.node ">=18"` contradicts scripts requiring Node ≥ 22.6

`package.json:8` — `song-server`/`make-catalog` run `.ts` directly with node (self-documented as needing 22.6 type stripping). **Suggestion:** raise engines + README, or run via tsx/vite-node.

### 44. Stale "not yet implemented" comment and a 99999999 sentinel one digit from `FAST_BPM_WARP`

`src/parse/negativeBpm.ts:135` — negative-BPM conversion IS implemented (the `timingTags.ts:46` comment is wrong), and the bare warp-to-end sentinel reads like a typo of the 9999999 constant. **Suggestion:** fix the comment; name the sentinel (`WARP_TO_END_BEAT`).

### 45. `WindowKey` union hand-duplicated in Judge; `scale`/`add` are dead knobs

`src/gameplay/windows.ts:31` — the unexported union is re-spelled in `judge.ts:160`; nothing ever sets `scale`/`add` off their defaults. **Suggestion:** export/import the type; wire a judge-difficulty setting or drop the knobs until built.

### 46. `songPreview` duplicates its debounce/token dance and violates its own silent-failure contract

`src/audio/songPreview.ts:118` — two entry points repeat the guard/stop/token/setTimeout sequence; five module-level mutables make it untestable; the header promises silent failure but an offline hover produces unhandled rejections; fade/length literals unnamed. **Suggestion:** one `schedulePreview` helper; try/catch in `run()`; name the constants.

### 47. Warp-advance math duplicated between `TimingData`'s two conversion loops; dead accessors; six inert segment lists

`src/timing/timingData.ts:196` — the warp block is copied at 196–203 and 275–284 in a file whose header warns event order must not change; `getBpmAtRow`, `isPlaying`, `SyncMap.ready` are unread; scrolls/speeds/timeSignatures/tickcounts/combos/labels are parsed and carried but consumed by nothing (and `segments.ts:35` implies Scroll is honored — it isn't). **Suggestion:** private `advanceWarp(cursor)` helper; prune or annotate the rest.

### 48. Background-extension whitelist and BPM-range formatting duplicated cross-module

`src/io/remoteLibrary.ts:21` — `BG_OK` duplicates `songFiles.ts`'s extension lists; BPM formatting is inlined at four sites with subtle round-vs-compare drift. **Suggestion:** export `isPlayableBackground(name)` + `formatBpmRange(min, max)` and reuse.

### 49. Comments describe a WebHID controller panel that doesn't exist

`src/main.tsx:16` — main.tsx and `session.ts:228` reference WebHID/a controller panel; the repo has no HID code (Gamepad API + keyboard only; `docs/ITG-FEATURE-GAP.md` lists raw HID as unbuilt). **Suggestion:** correct both comments; move the idea to ROADMAP if planned.

### 50. Song wheel rows are mouse-only clickable divs

`src/ui/SongSelectStepline.tsx:526` — rows are `<div onClick>` with no role/tabIndex/key handler while every other control in the file is a real `<button>`; invisible to the focus-driven nav system and assistive tech. **Suggestion:** `role="option"` + tabIndex + keyboard activation (a naive button swap won't fit the virtualized list).
