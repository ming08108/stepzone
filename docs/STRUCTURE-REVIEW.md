# Structure & Organization Review

_Reviewed against `master` @ `6326adb` (2026-07-07). Structure and organization
only — no behavior changes. This supersedes the first pass on this branch; the
codebase moved 36 commits and much of that pass is now resolved (see below)._

## What the recent work fixed

The canvas→WebGPU migration and the skin extraction closed the three biggest
items from the previous structure pass:

- **The dual note-field renderer is gone.** `1e47dd3` deleted the Canvas2D
  renderer; WebGPU is the only path. The "two implementations of every visual
  feature" cost is eliminated.
- **`GpuNoteField` is no longer a god class** — 1382 → **708 lines**. The ten
  `push*` drawing methods moved behind a real `GpuSkin` interface
  (`render/gpu/skin.ts`) with two implementations (`ddrA3Skin.ts`,
  `simplyLoveSkin.ts`). This is the right shape.
- **Both looks now ship through the same abstraction** (`GpuSkin`), so the
  theming asymmetry I flagged before is resolved, and the README no longer
  describes a canvas field.

Also still healthy and verified this pass: the engine/app boundary holds (no
`ui/`/`react` import anywhere under `notes timing parse song gameplay audio
input game`; pure dirs free of `document`/`window`/`navigator` — the one
`windows.ts` hit is the word "window" in a comment), typecheck is clean, and
tests mirror the engine (now with a `tests/reference` ITGmania parity corpus).

---

## 1. The render layer carries leftover scaffolding from the just-finished migration

The `Theme` polymorphism that the Canvas2D renderer used is **gone** — no
`Theme` interface or class implementer survives — but its scaffolding is still
standing, now repurposed in ways the names and locations don't reflect:

- **`render/noteField.ts`** (59 lines) is named for the renderer that was
  deleted. It now holds only `NoteFieldConfig`, layout constants (`DESIGN_SIZE`,
  `LANE_W`, `ARROW_HALF`, …), and a couple of type re-exports. The name actively
  misleads — there is no note-field renderer here anymore.
- **`render/theme.ts`** now exports only shared types/constants (`RenderMeta`,
  `Feedback`, `JudgmentStyle`, `RECEPTOR_FLASH`). It is no longer about a
  "theme."
- **`render/themes/ddrA3.ts` (694 lines)** and **`render/themes/simplyLove.ts`**
  were the canvas `Theme` implementations. They are now constant/helper
  grab-bags (colors, fonts, `measureWidth`, `OUTLINE_INK`) that the *GPU* skins
  import. So the material for one skin is split across two files with similar
  names and no stated reason: `render/themes/ddrA3.ts` **and**
  `render/gpu/ddrA3Skin.ts`. A newcomer can't tell which holds what, or why the
  GPU skin reaches up into a sibling `themes/` directory.

This is the freshest and highest-value cleanup: the directory shape still tells
the old story (a `Theme` abstraction with per-theme files) while the code tells
the new one (a `GpuSkin` abstraction under `gpu/`).

**Recommendation.** Reorganize `render/` around the surviving `GpuSkin` model:

- Fold each `themes/<x>.ts` helper/constant set into — or beside — its
  `gpu/<x>Skin.ts`, so one skin lives in one obvious place. If some constants
  are genuinely skin-agnostic, name that file for what it is
  (e.g. `render/gpu/skinShared.ts`), not `themes/`.
- Rename `noteField.ts` → `fieldLayout.ts` (or `fieldConfig.ts`) to match its
  contents.
- Merge `theme.ts` into a `renderTypes.ts`, or rename it — it's a types module
  now.
- Retire the `render/themes/` directory once emptied.

Pure mechanical moves (imports + a rename), no behavior change, and the render
tree stops lying about its own design.

## 2. `SongSelectStepline.tsx` — 1192 lines in one component, now the single largest file

Unchanged since the last two reviews (flagged at 575 lines a pass ago; it has
doubled and is now the biggest file in the repo). One exported `SongSelect`
function still owns data derivation, filtering/sorting, folder management, image
stashing, keyboard/gamepad nav, and the whole multi-panel layout. None of its
pure logic is tested.

**Recommendation** (same as before, now the clear top priority since render is
in good shape):

- Extract pure helpers (`deriveLevels`, `bpmText`, `entryFromCatalog`,
  sort/filter, `initials`) into `ui/songSelectModel.ts` — no React, unit-testable.
- Split sub-components into their own files: song-list row, difficulty grid,
  folder panel, detail panel, search/sort bar.
- Move the keydown/gamepad navigation into a hook (mirrors the existing
  `useMenuNav` / `useGamepadKeys` pattern).
- Rename the file to match its export: `SongSelectStepline.tsx` → `SongSelect.tsx`.

## 3. Watch item: the two GPU skins are large and will keep growing

`ddrA3Skin.ts` (925) and `simplyLoveSkin.ts` (772) are now the render layer's
heavy files. They are **not** duplicative — they share essentially no drawing
code (only a `drawNumber` by name), so they're legitimately distinct designs,
not copy-paste. But each is a single monolith mixing chrome, panels, notes,
holds, explosions, and gauge drawing — the same shape `gpuNoteField.ts` just
escaped.

**Recommendation (low priority, pre-emptive).** Before they reach the ~1300-line
point the orchestrator was just rescued from, give each skin internal seams —
group its drawing into sections or small sibling modules (HUD vs notes vs
panels). No urgency; just don't let them re-accrete the god-object shape.

---

## Housekeeping (cheap, still open)

4. **Lock in the engine/app boundary that's currently only convention.** It's
   clean today by discipline. A `no-restricted-imports` ESLint rule (or
   dependency-cruiser) in CI forbidding `ui/`/`react` inside the engine dirs
   turns a future regression into a failed build instead of a missed review.
   CI already runs typecheck/test/format — there's still no linter.

5. **`docs/` mixes durable references with dated snapshots.** `LATENCY.md`,
   `ROADMAP.md` (README-linked) and the `img/` assets sit alongside point-in-time
   analyses (`CODE-REVIEW-SUGGESTIONS`, `ENGINE-REVIEW`, `ITG-FEATURE-GAP`,
   `ONLINE-MULTIPLAYER`, `RENDER-PERF`). A `docs/reviews/` (or `notes/`) subfolder
   keeps the living docs from getting buried.

6. **README architecture map still omits real directories.** `bench/`,
   `starter/`, `dev/` aren't on the tree, and root `harness/` isn't mentioned.
   One line each keeps the map honest.

## Suggested order

Render is now the codebase's best-factored layer except for the naming residue —
do **1** first, it's mechanical and removes real confusion. **2** is the largest
remaining structural debt and is self-contained. **3** is a pre-emptive watch
item. **4–6** are quick wins anytime.
