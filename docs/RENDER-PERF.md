# Note-field rendering performance

Findings from the 2026-07 renderer investigation: an in-app benchmark, numbers
for the Canvas 2D field, and the WebGPU note field that came out of it.

## The benchmark

OPTIONS → DISPLAY → **Run render benchmark** (or open `/?bench=auto`; add
`&only=<id-substring>` to narrow the suite). ~60s, full-viewport, synthetic
charts driven through the real parse → Judge → renderer path with an
autoplayer, so combo pops, judgments, explosions and hold engagement all
render like live play. Results are copyable JSON (`window.__benchResult`,
also logged to the console) for comparing machines.

Per scenario it reports:

- **FPS / frame p95 / missed** — rAF frame-to-frame deltas; "missed" counts
  deltas over 1.5× the display refresh. This is what the player experiences,
  and includes browser-GPU-process raster time. Normally vsync-bound, so FPS
  tops out at the monitor's refresh — to see the true frame-rate ceiling,
  launch the driver with `--disable-gpu-vsync --disable-frame-rate-limit`
  (the scratch `runBench2.mjs` does).
- **GPU/frame** — the real GPU time of each _presented_ frame, via WebGPU
  timestamp queries on the render pass (`gpuTimer.ts`). This is the honest
  per-frame cost of what's on screen and what drives headroom. Canvas 2D can't
  be timestamped (its raster runs later in the browser's GPU process), so it
  shows "—". (An earlier synthetic "saturation" phase — hammering draws to an
  arbitrary target — was removed: it stuttered the screen, fast-forwarded the
  chart, and didn't reflect what's presented.)
- **CPU/frame** — main-thread time inside `draw()` (instance building + encode),
  plus a per-theme-pass breakdown via the `wrapTheme` hook (canvas backend).
- **headroom** — how many of these frames fit one display-refresh interval, at
  the binding cost (max of GPU and CPU per frame).

Scenarios: a typical hard chart (175BPM 16ths, X2.5) and a beyond-worst-case
stress chart (200BPM 16ths + jumps + overlapping freezes/rolls + mines at X1 ≈
74 arrows + 7 holds + 17 mines on screen, DANGER chrome forced), across
backends and with a background image composited.

## Numbers (RTX 3080, 238Hz display, 1600×900@1dpr, Chrome 149)

| scenario                  | fps | missed | draw CPU avg | max draws/s |
| ------------------------- | --- | ------ | ------------ | ----------- |
| canvas arcade typical \*  | 237 | 0.3%   | 0.28 ms      | 5 335       |
| canvas arcade stress \*   | 238 | 0.1%   | 0.59 ms      | 1 901       |
| canvas ITG stress         | 159 | 50.6%  | 1.02 ms      | 130         |
| canvas arcade + bgimage\* | 240 | 0.0%   | 0.56 ms      | 2 476       |
| webgpu typical            | 238 | 0.1%   | 0.14 ms      | 16 901      |
| webgpu stress             | 238 | 0.1%   | 0.15 ms      | 12 896      |
| webgpu stress + bgimage   | 235 | 0.1%   | 0.15 ms      | 9 979       |

\* Historical: the arcade canvas theme (`DdrA3Theme`) was removed after this
investigation — the arcade look is WebGPU-only now, so the suite runs the
three WebGPU scenarios plus the ITG canvas stress. The `max draws/s` above is
the old command-recording proxy; the metric now drains the GPU each chunk
(real throughput — see below), so current numbers read lower and truer.

### Uncapped (vsync disabled, `--disable-gpu-vsync --disable-frame-rate-limit`)

Removing the display cap shows the real frame-rate ceiling. `max draws/s` here
is the GPU-drained throughput.

| scenario                | fps (uncapped) | draw CPU avg | max draws/s |
| ----------------------- | -------------- | ------------ | ----------- |
| webgpu typical          | **4 525**      | 0.09 ms      | 5 433       |
| webgpu stress           | **3 420**      | 0.10 ms      | 5 209       |
| webgpu stress + bgimage | **3 380**      | 0.11 ms      | 4 950       |
| canvas ITG stress       | **146**        | 1.06 ms      | 138         |

The WebGPU field runs the stress chart at ~3 400 fps (~0.3 ms/frame end to
end) — it was only ever pinned to 238 Hz by the monitor. The ITG canvas theme
tops out at ~146 fps _with vsync off too_: that is its true ceiling, ~23× below
the GPU field, which is why it (not the arcade look) is the port worth doing.

Takeaways:

- The **arcade (DDR A3) canvas theme was already fast** — its SpriteStore
  pre-rasterization keeps stress frames at ~0.6ms CPU and vsync-locked even
  at 238Hz. On this machine it was never the bottleneck.
- The **Simply Love canvas theme is the slow one**: GPU-process-bound (per
  frame `shadowBlur`, per-note gradients), missing half its vsyncs at 238Hz
  (~159fps). Its 130 draws/s ceiling says a weak GPU would struggle at 60Hz.
- The **WebGPU field is ~4× cheaper on CPU and ~7-10× higher throughput**
  than the (already optimized) canvas arcade theme, with the entire frame in
  3-5 draw calls. Its win grows on weaker/hidpi machines where canvas raster
  is the limit; run the in-app benchmark there to confirm.

## The WebGPU note field (`src/render/gpu/`)

Structured for the GPU pipeline rather than ported from canvas calls. Both
looks run on it: `skin.ts` defines a `GpuSkin` that owns all the ART, while
`gpuNoteField.ts` owns the shared mechanics (scroll, cull cursor, batches,
render-pass encode) and delegates each element to the skin — `ddrA3Skin.ts`
(arcade DDR A3) or `simplyLoveSkin.ts` (ITG / Simply Love). This mirrors the
2D renderer's `Theme` split, so the same pass order drives both.

- `atlas.ts` — the signature arrow/receptor/hold/mine/gauge/explosion art is
  rasterized ONCE (via the exported ddrA3 / simplyLove paint functions —
  pixel-twin, no duplication) into a texture (2048², or 4096² for 4K),
  shelf-packed.
- `quads.ts` — one instanced-quad pipeline; an instance is 96 bytes
  (center/size/rotation, uv rect, premultiplied tint, u+v tiling + scroll
  phase, optional mask uv rect). Blend segments (source-over / additive)
  collapse into draw calls in push order. The vertical scroll phase drives
  SL's per-beat arrow stem stripe and the hold sheen.
- `glyphs.ts` — combo/score **numbers** composite from per-digit glyph sprites
  (baked once per size) as tinted quads, so a changing number never
  re-rasterizes. Combo bakes at one reference size and scales.
- `shapes.ts` — a colored-triangle pipeline draws the **panel backgrounds** as
  geometry (arcade's angled plate/hexagon/gold trim; SL's song-meter +
  LifeMeterBar frames and the blue→purple density-graph silhouette), so the
  panels never touch canvas. Two shape batches: one flushed OVER the notes
  (panels beside/above the field), one UNDER (SL's field filter + density,
  which the notes scroll over). Panel text sits in a quad batch over the shapes.
- `media.ts` — song background image (sampled texture) or video
  (`importExternalTexture`) cover-fit on the same surface, dimmed by a quad.
- `gpuNoteField.ts` — shares the design grid, scroll math, cull cursor and
  Judge-view with the 2D renderer; builds ~100-250 instances per frame. A
  one-time `prewarm()` (behind the READY splash / before the bench's measured
  window) draws a synthetic frame + bakes every sprite variant — all quant
  colours, three hold skins, mine, explosion, all judgment tiers, every grade,
  all digits, and each gauge state — and compiles both blend pipelines, so
  nothing bakes or compiles once a song is running.

**Canvas usage:** the only canvas rasterization is baking those static sprites
and text glyphs into the atlas, and it all happens up front in `prewarm()`. No
canvas runs on the per-frame path; a Chrome trace shows every
`DoEndRasterCHROMIUM` at prewarm time, none mid-song.

Pass order (fixes the 2D field's layering inconsistency, where hold bodies
drew UNDER receptors while their heads drew over): background → chrome →
beat/measure guide lines → receptors → hold bodies → taps/heads/mines →
explosions (additive) → judgment/combo → gauge/panels. Judgment and combo
draw OVER the arrows (the DDR cab draws them there, not beneath). Beat lines
scroll with the field via a bounded per-frame scan of on-screen beats
(setBeatTimes supplies each beat's time so C-mod under a BPM change is exact).

Both skins render on the WebGPU field — there is no renderer setting. If WebGPU
is unavailable (or the device is lost mid-song) the session falls back to the
canvas renderer, which draws the Simply Love look. `render/themes/ddrA3.ts` and
`render/themes/simplyLove.ts` remain as the procedural-art modules (palettes +
paint functions) the GPU atlas bakes from — the canvas SL theme also still
serves the fallback and the song-select previews.

The dance gauge's animated fills (flowing bands, maxed-gauge rainbow, top
sheen) render as scrolling patterns clipped by a baked segment-shape alpha
mask — the quad shader's mask/repeatU/phaseU path — matching the 2D theme's
`ctx.clip()` compositing exactly. SL's per-beat arrow stripe uses the same
mask path with vertical scroll; its dance % is a repaint-in-place atlas slot
(a single small changing string), the combo composites per-digit glyphs, and
the density graph is per-measure NPS trapezoids with a vertical color gradient.

Follow-up worth considering: drop the ×2 sprite supersampling on hidpi displays
where dpr≥2 already covers it.
