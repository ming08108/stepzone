# Stepzone

A web-based DDR / StepMania-compatible rhythm **track player**. The engine is
framework-free TypeScript; the app shell is React. It reads real `.sm`/`.ssc`
simfiles and plays them in the browser with sample-accurate timing.

Built from the reimplementation spec in
[`../itgmania/Docs/TrackPlayerSpec/`](../itgmania/Docs/TrackPlayerSpec/), which
documents the StepMania/ITGmania formats and game logic in detail. Each module
here cites the spec doc it implements.

## Status

**Milestone 5 — Player features (mostly done).** Real song folders and packs
play end to end in the browser: a Web Audio clock, keyboard and gamepad input
judged on the event timestamp, a scrolling canvas note field, and
combo/score/life/grade with a results screen — plus song select with
search/favorites, persisted options (scroll speed, music rate, sync offset, key
rebinding, mirror/turn mods), and an auto-calibration screen. The pure layers
underneath (parsing, timing, and the judgment engine) are covered by unit
tests, including the spec's worked example and its input trace reproduced
number-for-number.

```
npm install     # Node ≥ 22.6 required (built on Node 24 LTS)
npm run dev     # dev server → http://localhost:5173
npm test        # unit tests: MSD parser, timing, note grid, sync clock, judgment
npm run build   # strict typecheck + production build
```

Node ≥ 22.6 matters for the `scripts/` song-server tooling (`npm run
song-server`, [`docs/SONG-SERVER.md`](docs/SONG-SERVER.md)), which relies on
Node running TypeScript directly.

Play with <kbd>←</kbd> <kbd>↓</kbd> <kbd>↑</kbd> <kbd>→</kbd> (or D F J K), or a
gamepad / dance pad. The "Inspect" tab shows the parsed song/timing/notes.

## Architecture

The **engine** (`src/notes`, `src/timing`, `src/parse`, `src/song`,
`src/gameplay`, `src/audio`) imports no React and no DOM APIs, so it is fully
unit-tested in Node and could run headless. The **app** (`src/ui`,
`src/main.tsx`) is the React shell. The `src/audio` clock is the one
browser-coupled engine piece, and even there the timing math is a pure, tested
`SyncMap`.

```
src/
  notes/      noteTypes, noteData, noteGrid, transforms  (spec doc 3)
  timing/     segments, timingData (beat<->second)  (spec doc 2)
  parse/      msd tokenizer, ssc, sm, loader         (spec doc 1)
  song/       song, steps, difficulty, stepsType     (spec doc 5)
  audio/      syncMap (pure), clock (Web Audio)       (spec doc 6)
  input/      key/gamepad -> column mapping           (spec doc 7)
  render/     note-field canvas, WebGPU background    (spec doc 8)
  gameplay/   judgment, scoring, life                 (spec doc 4)
  game/       the play-loop orchestrator              (spec doc 9)
  io/         song folders, packs, remote catalog
  app/        persisted settings / favorites / scores
  ui/         React components
tests/        vitest suites (mirror the engine)
docs/
  LATENCY.md  how we get low latency right on the web
  ROADMAP.md  milestones
```

There is no barrel module: the app and tests deep-import from the subfolders
directly (e.g. `src/timing/timingData`).

## Low latency

Timing accuracy is the whole game. The clock is driven by the Web Audio
`AudioContext`, input is timestamped at the event (not the frame), and the two
are reconciled through `AudioContext.getOutputTimestamp()`. The full strategy,
the pitfalls, and how the code embodies them are in
[`docs/LATENCY.md`](docs/LATENCY.md).

## Roadmap

See [`docs/ROADMAP.md`](docs/ROADMAP.md). M1–M5 (parse/time, the judgment
engine, the playable slice, real songs, player features) are done. Next up:
edge-case completeness — routine charts, chord-cohesion combo, round-trip
serialization / `ChartKey` hashing.
