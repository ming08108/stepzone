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

- **FPS / frame p95 / missed** — rAF frame-to-frame deltas under vsync;
  "missed" counts deltas over 1.5× the display refresh. This is what the
  player experiences and includes browser-GPU-process raster time.
- **draw CPU** — main-thread time inside `draw()` (canvas: command recording;
  WebGPU: instance building + encode). Plus a per-theme-pass breakdown via
  the `wrapTheme` instrumentation hook (canvas backend only).
- **max draws/s** — back-to-back draws with no vsync wait; a CPU throughput
  ceiling.

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
three WebGPU scenarios plus the ITG canvas stress.

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

Structured for the GPU pipeline rather than ported from canvas calls:

- `atlas.ts` — every static visual (arrows, receptors, hold tiles/caps, HUD
  chrome, judgment lettering) is rasterized ONCE by the same exported ddrA3
  paint functions the 2D theme uses (pixel-twin art, no duplication), shelf-
  packed into one 2048² texture. Dynamic text (combo, score) lives in slots
  repainted in place when content changes.
- `quads.ts` — one instanced-quad pipeline; an instance is 96 bytes
  (center/size/rotation, uv rect, premultiplied tint, u/v tiling + scroll
  phase, optional mask uv rect). Blend segments (source-over / additive)
  collapse into draw calls in push order.
- `media.ts` — song background image (sampled texture) or video
  (`importExternalTexture`) cover-fit on the same surface, dimmed by a quad.
- `gpuNoteField.ts` — shares the design grid, scroll math, cull cursor and
  Judge-view with the 2D renderer; builds ~100-250 instances per frame.

Pass order (fixes the 2D field's layering inconsistency, where hold bodies
drew UNDER receptors while their heads drew over): background → chrome →
judgment/combo (A3 ComboUnderField) → receptors → hold bodies → taps/heads/
mines → explosions (additive) → gauge/panels.

Selection is automatic, by note skin: arcade → WebGPU field, ITG → canvas
renderer. There is no renderer setting. If WebGPU is unavailable (or the
device is lost mid-song) the session falls back to the canvas renderer on a
fresh canvas element — which draws the Simply Love look, since the arcade
canvas theme no longer exists. `render/themes/ddrA3.ts` remains as the
procedural-art module (palettes + paint functions) the GPU atlas bakes from.

The dance gauge's animated fills (flowing bands, maxed-gauge rainbow, top
sheen) render as scrolling patterns clipped by a baked segment-shape alpha
mask — the quad shader's mask/repeatU/phaseU path — matching the 2D theme's
`ctx.clip()` compositing exactly.

Follow-ups worth considering: port the Simply Love skin to the GPU field (it
is the theme that actually needs it — see numbers), and drop the ×2 sprite
supersampling on hidpi displays where dpr≥2 already covers it.
