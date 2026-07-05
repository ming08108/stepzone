# Roadmap

Milestones are vertical where possible: each ends with something verifiable
(tests, or a playable slice). The engine layers are built and tested pure before
the browser-coupled layers.

## M1 — Parse & Time ✅ (done)

The pure data foundation.

- MSD tokenizer; `.ssc` + basic `.sm` parsing into Song/Steps.
- Note grid decode into `NoteData` (holds, mines, keysounds, the `,,` quirk).
- `TimingData` beat⇄second conversion: BPMs, stops, delays, warps.
- Pure `SyncMap` clock math.
- 29 unit tests, including the spec doc-9 worked example reproduced exactly.

## M2 — Gameplay logic (pure, testable) ✅ (done)

Judgment/scoring/life as pure functions over `NoteData` + a timeline of input
events. No audio or DOM, so it's unit-tested.

- Timing windows (W1–W5, mine, hold, roll) and `windowSeconds` (scale/add).
- `Judge.step()`: closest-note search, offset → score, warp/fake exclusion,
  lift-on-release, mine detonation.
- Miss aging, combo rules (W3 keeps / breaks), hold/roll life.
- Dance-point %, grade, life meter deltas (verified metric defaults).
- **Test (passing):** the spec doc-9 input trace reproduces exactly —
  W1 / W3 / Miss / Held / HitMine → 53.3%, max combo 2, life 0.288.

## M3 — First playable slice ✅ (done)

The browser layers around the M1/M2 core — the example chart plays end to end.

- `WebAudioClock` driving a synthesized metronome `AudioBuffer`, anchored via
  `getOutputTimestamp` (see [LATENCY.md](LATENCY.md)).
- Keyboard input → column via the Style keymap; judged on `event.timeStamp`.
- Canvas note field (CMod, upscroll): receptors, quantization-colored notes,
  holds, and an on-canvas HUD (combo, judgment, life, score %, grade).
- Game loop + Play/Results UI. Verified in a headless browser: full clear,
  100% / AAA, with the hold and mine handled correctly.

Deferred from the playable slice (tracked): per-row chord cohesion for combo,
XMod/MMod + scroll/speed-segment rendering, life-delta modifiers, roll re-tap
polish, and a real audio file loader.

## M4 — Real songs ✅ (done)

- Load a song folder (simfile + audio + banner) via a folder picker
  (`webkitdirectory`) or drag-drop (recursive folder traversal).
- Song-select UI with banner + a per-chart difficulty grid; real audio decoded
  into the clock (metronome fallback if none/unsupported).
- Verified with DDR 1st Mix "Butterfly" (`.sm` + `.ogg`): all dance-single/
  double/couple/solo charts parsed, banner shown, real OGG audio playing.

Deferred: preview clips (sample start/length), multi-song pack browsing / a song
wheel, and persisting a library across reloads (File System Access API).

## M5 — Player features (mostly done)

Driven by `todo.txt`. Done:

- **Options + settings** (persisted): C/X scroll speed, music-rate practice
  slowdown, audio/visual sync offset, key rebinding. (#4, #5, #10)
- **Auto-calibration** screen (tap a metronome → offset), AdjustSync-style. (#6)
- **Full arrow + gamepad navigation** of all menus (Enter/Escape, dpad/A/B), and
  **controller/dance-pad** input during play (Gamepad API). (#1, #3)
- **Song library**: load a whole pack; **searchable/filterable table** (type,
  meter, BPM, sort) with **favorites** (localStorage). (#7, #11, #12)
- **Background image/video** behind the field, video loosely song-synced. (#9)
- **Arcade look** + correct arrows for solo/double/pump modes. (#2, #8)
- **Mirror/turn mods** (mirror, left, right, shuffle) — `src/notes/transforms.ts`,
  applied per-session, with tests.

Deferred here: noteskins (quantization coloring is wired); a
richer results screen (life graph); a GPU (PixiJS/WebGPU) renderer for the note
field (advised over raw WebGPU — the renderer sits behind one interface, so it's
a clean swap when perspective mods / dense charts arrive). (#8's WebGPU part)

## M6 — Edge-case completeness

- ✅ `.sm` negative-BPM / negative-stop → warp conversion (spec doc 2 §2.5) —
  ported from `ProcessBPMsAndStops`; DDR gimmick `.sm` charts now time correctly.
- Composite / routine (`&`-separated) charts.
- Per-row chord-cohesion combo; roll re-tap polish; life-delta modifiers.
- Round-trip serialization + `ChartKey` hashing for validation (spec doc 10
  §10.7).
- Raw WebHID dance-pad input as a lower-latency, opt-in alternative to the
  Gamepad API.
