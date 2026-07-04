# notefield

A web-based DDR / StepMania-compatible rhythm **track player**. The engine is
framework-free TypeScript; the app shell is React. It reads real `.sm`/`.ssc`
simfiles and (once complete) plays them in the browser with sample-accurate
timing.

Built from the reimplementation spec in
[`../itgmania/Docs/TrackPlayerSpec/`](../itgmania/Docs/TrackPlayerSpec/), which
documents the StepMania/ITGmania formats and game logic in detail. Each module
here cites the spec doc it implements.

## Status

**Milestone 3 — Playable (done).** The bundled example chart plays end to end in
the browser: a Web Audio metronome clock, keyboard input judged on the event
timestamp, a scrolling canvas note field, and combo/score/life/grade with a
results screen. The pure layers underneath (parsing, timing, and the judgment
engine) are covered by 34 unit tests, including the spec's worked example and
its input trace reproduced number-for-number.

```
npm install     # Node 18+ required (this repo was built on Node 24 LTS)
npm run dev     # dev server → http://localhost:5173  (Play tab)
npm test        # 34 tests: MSD parser, timing, note grid, sync clock, judgment
npm run build   # strict typecheck + production build
```

Play with <kbd>←</kbd> <kbd>↓</kbd> <kbd>↑</kbd> <kbd>→</kbd> (or D F J K). The
"Inspect" tab shows the parsed song/timing/notes.

## Architecture

The **engine** (`src/notes`, `src/timing`, `src/parse`, `src/song`, `src/audio`)
imports no React and no DOM APIs, so it is fully unit-tested in Node and could
run headless. The **app** (`src/ui`, `src/main.tsx`) is the React shell. The
`src/audio` clock is the one browser-coupled piece, and even there the timing
math is a pure, tested `SyncMap`.

```
src/
  notes/      noteTypes, noteData, noteGrid         (spec doc 3)
  timing/     segments, timingData (beat<->second)  (spec doc 2)
  parse/      msd tokenizer, ssc, sm, loader         (spec doc 1)
  song/       song, steps, difficulty, stepsType     (spec doc 5)
  audio/      syncMap (pure), clock (Web Audio)       (spec doc 6)
  input/      key -> column mapping                   (spec doc 7)   [next]
  render/     note-field canvas                       (spec doc 8)   [next]
  gameplay/   judgment, scoring, life                 (spec doc 4)   [next]
  game/       the play-loop orchestrator              (spec doc 9)   [next]
  ui/         React components
  engine.ts   public API barrel
tests/        vitest suites (mirror the engine)
docs/
  LATENCY.md  how we get low latency right on the web
  ROADMAP.md  milestones
```

Public API is re-exported from [`src/engine.ts`](src/engine.ts); the app and
tests import from there.

## Low latency

Timing accuracy is the whole game. The clock is driven by the Web Audio
`AudioContext`, input is timestamped at the event (not the frame), and the two
are reconciled through `AudioContext.getOutputTimestamp()`. The full strategy,
the pitfalls, and how the code embodies them are in
[`docs/LATENCY.md`](docs/LATENCY.md).

## Roadmap

See [`docs/ROADMAP.md`](docs/ROADMAP.md). Next up: the gameplay judgment engine
(pure, testable — the doc-9 input trace becomes a test), then the Web Audio
clock wired to a canvas note field for a first playable slice.
