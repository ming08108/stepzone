# Engine fidelity review vs ITGmania (todo #16)

A systematic check of Stepzone's engine against the ITGmania source and the
reimplementation spec (`../itgmania/Docs/TrackPlayerSpec/`). Each row: does our
logic match, and if not, is it a bounded simplification or a real gap.

Legend: ✅ matches · ⚠️ simplified (bounded, documented) · ❌ not implemented.

## Parsing & timing

| Area                                                         | Status | Notes                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Row/beat fixed point (`ROWS_PER_BEAT=48`, measure=192)       | ✅     | `notes/noteTypes.ts`; matches `NoteTypes.h`.                                                                                                                                                                                                                                                                                                       |
| MSD tokenizer (comments, missing-`;`, escapes)               | ✅     | `parse/msd.ts`; tested.                                                                                                                                                                                                                                                                                                                            |
| Note-grid decode (chars, holds, `,,`, keysounds)             | ✅     | `notes/noteGrid.ts`; tested incl. the `,,` quirk.                                                                                                                                                                                                                                                                                                  |
| `.ssc` parse (song + `#NOTEDATA` blocks, split timing ≥0.70) | ✅     | `parse/ssc.ts`.                                                                                                                                                                                                                                                                                                                                    |
| `.sm` parse (6-field `#NOTES`, old-style difficulty)         | ✅     | `parse/sm.ts`. Verified on DDR Butterfly.                                                                                                                                                                                                                                                                                                          |
| Beat⇄second (BPM/stop/delay/warp, `#OFFSET`)                 | ✅     | `timing/timingData.ts`; ported from `GetElapsedTimeInternal`/`GetBeatInternal`; reproduces spec doc-9 table exactly.                                                                                                                                                                                                                               |
| STOP-vs-DELAY same-row ordering                              | ✅     | Same `FindEvent` precedence as the engine.                                                                                                                                                                                                                                                                                                         |
| Warp/fake → not judgable                                     | ✅     | `isJudgableAtRow`.                                                                                                                                                                                                                                                                                                                                 |
| **`.sm` negative-BPM / negative-stop → warps**               | ❌     | **Gap.** `parse/timingTags.ts` rejects non-positive BPMs; the engine synthesizes warps (`ProcessBPMsAndStops`, spec doc 2 §2.5). Constant-BPM and `.ssc`-with-`#WARPS` songs are unaffected; DDR gimmick `.sm` charts (negative-BPM tricks) would mis-time. DDR 1st Mix songs are constant/positive-BPM, so they play correctly today. Tracked M6. |
| Composite / routine (`&`) charts                             | ❌     | Single-player only. Tracked M6.                                                                                                                                                                                                                                                                                                                    |

## Judgment & scoring

| Area                                                   | Status | Notes                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timing windows W1–W5 (22.5/45/90/135/180 ms)           | ✅     | `gameplay/windows.ts`; matches `Player.cpp` defaults.                                                                                                                                                                                                                                                                                     |
| Window scale by music rate                             | ✅     | `windows*rate` in the Judge; tested (40 ms tap = W2@1×, W1@2×).                                                                                                                                                                                                                                                                           |
| Closest-note match; already-graded skipped             | ✅     | `Judge.step`.                                                                                                                                                                                                                                                                                                                             |
| Miss = aged past widest window                         | ✅     | Miss cursor; only source of `TNS_Miss`.                                                                                                                                                                                                                                                                                                   |
| Mine detonate / avoid windows + penalty                | ✅     | −2 dance / −0.16 life (verified defaults).                                                                                                                                                                                                                                                                                                |
| Hold grace (0.25 s) / roll drain (0.5 s)               | ✅     | `TW_Hold`/`TW_Roll`. Roll re-tap is basic (⚠️).                                                                                                                                                                                                                                                                                           |
| Dance-point weights (W1=3,W2=2,W3=1,Held=3,HitMine=−2) | ✅     | `gameplay/scoring.ts`; matches `metrics.ini`.                                                                                                                                                                                                                                                                                             |
| Grade weights + tiers (AAA=1.0, AA=.93, A=.8…)         | ✅     | Matches `metrics.ini` `[ScoreKeeperNormal]`/grade tiers.                                                                                                                                                                                                                                                                                  |
| Life meter (init 0.5, per-judgment deltas)             | ✅     | Deltas match `metrics.ini`.                                                                                                                                                                                                                                                                                                               |
| **Combo governance**                                   | ⚠️     | We count **per note** (each W3+ grows, <W3 breaks). The engine uses **chord cohesion** (per row; the worst-timed tap governs the whole row). Final combo and dance-% agree for streams and for jumps that break combo; they can differ only in `maxCombo` on a jump with _mixed_ W1+low scores (rare). Dance points are per-note in both. |
| **Life modifiers**                                     | ⚠️     | We apply the raw per-judgment deltas. The engine also has merciful-drain, progressive-lifebar, combo-to-regain, and drain-type scaling (spec doc 4 §4.8). Same sign/direction; different curve at the extremes.                                                                                                                           |
| Fail at life = 0                                       | ✅     | `failed` latch.                                                                                                                                                                                                                                                                                                                           |

## Rendering (informational — not "engine")

| Area                                                       | Status | Notes                                         |
| ---------------------------------------------------------- | ------ | --------------------------------------------- |
| Quantization colors, CMod/XMod, receptors, holds           | ✅     | Matches spec doc 8 for the modeled subset.    |
| Per-steps-type arrow directions (single/solo/double/pump)  | ✅     | `render/columns.ts`.                          |
| MMod scroll; turn mods (mirror/left/right/shuffle)         | ✅     | `render/noteField.ts`, `notes/transforms.ts`. |
| WebGPU aurora background (beat-reactive shader) + fallback | ✅     | `render/shaderBackground.ts`.                 |
| Reverse/hidden/sudden, scroll/speed segments, perspective  | ❌     | Not modeled. Tracked M6/M8.                   |

## Verdict

The **data path (parse → timing → notes) and the core judgment/scoring/life
math are faithful** to ITGmania and are covered by tests, including the spec's
worked example and its input trace reproduced number-for-number. The remaining
differences are two bounded gameplay simplifications (per-note combo, raw life
deltas) and composite/routine charts — all tracked in `ROADMAP.md` M6.

**Update:** `.sm` negative-BPM / negative-stop → warp conversion has since been
implemented (`parse/negativeBpm.ts`, a faithful port of `ProcessBPMsAndStops`)
and unit-tested; MMod scroll, turn mods, and a WebGPU shader background were also
added. See `ITG-FEATURE-GAP.md` for the full remaining feature surface vs
ITGmania.
