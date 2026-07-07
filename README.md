# Stepzone

A web-based DDR / StepMania-compatible rhythm **track player**. The engine is
framework-free TypeScript; the app shell is React. It reads real `.sm`/`.ssc`
simfiles and plays them in the browser with sample-accurate timing and a
WebGPU note field.

**[▸ Play it live](https://stepzone-omega.vercel.app/)** — Chrome or Edge (WebGPU required).

![Song select](docs/img/song-select.png)

Built from the reimplementation spec in
[`../itgmania/Docs/TrackPlayerSpec/`](../itgmania/Docs/TrackPlayerSpec/), which
documents the StepMania/ITGmania formats and game logic in detail. Each module
here cites the spec doc it implements.

## Running

```
npm install     # Node ≥ 22.6 required (built on Node 24 LTS)
npm run dev     # dev server → http://localhost:5173
npm test        # unit tests: MSD parser, timing, note grid, sync clock, judgment
npm run build   # strict typecheck + production build
```

Songs load straight from disk: pick (or drop) song folders, packs, or whole
Songs directories on the song-select screen — the FOLDERS panel manages the
list (enable/disable/remove). In Chromium browsers every folder is remembered,
so the library reloads on the next visit after a single keypress re-grant
(pick "Allow on every visit" in the prompt to make it fully automatic).

Play with <kbd>←</kbd> <kbd>↓</kbd> <kbd>↑</kbd> <kbd>→</kbd> (or D F J K), or a
gamepad / dance pad. The "Inspect" tab shows the parsed song/timing/notes.

## Rendering

The note field renders on **WebGPU**: one instanced-quad pipeline over a
baked texture atlas draws the whole frame in a handful of draw calls, with no
per-frame canvas work. Two looks ship on the same field through a `GpuSkin`
split — an arcade (DDR A3) skin and an ITG (Simply Love) skin — picked in
Player Options. WebGPU is required to play; there is no canvas fallback.

|              Arcade — DDR A3              |          ITG — Simply Love          |
| :---------------------------------------: | :---------------------------------: |
| ![Arcade skin](docs/img/field-arcade.jpg) | ![ITG skin](docs/img/field-itg.jpg) |

An in-app render benchmark (OPTIONS → DISPLAY → **Run render benchmark**, or
open `/?bench=auto`) measures the real GPU time of each presented frame via
WebGPU timestamp queries. The design, the pass order, and the numbers are in
[`docs/RENDER-PERF.md`](docs/RENDER-PERF.md).

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
