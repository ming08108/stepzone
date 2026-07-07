# Structure & Organization Review

_Reviewed against `master` @ `6326adb` (2026-07-07). Structure and organization
only. The findings below were then acted on this branch — status noted per item._

## What the recent work fixed (before this pass)

The canvas→WebGPU migration and the skin extraction closed the three biggest
items from the first structure pass on this branch:

- **The dual note-field renderer is gone.** `1e47dd3` deleted the Canvas2D
  renderer; WebGPU is the only path.
- **`GpuNoteField` is no longer a god class** — 1382 → 708 lines. The ten
  `push*` drawing methods moved behind a `GpuSkin` interface with two skins.
- **Both looks ship through the same abstraction**, and the README no longer
  describes a canvas field.

Still healthy and verified: the engine/app boundary holds, typecheck is clean,
and tests mirror the engine.

---

## 1. Render-layer naming residue from the migration — FIXED

The `Theme` polymorphism the deleted Canvas2D renderer used was gone, but its
scaffolding still stood under misleading names. Realigned `render/` with the
surviving `GpuSkin` model:

- `render/theme.ts` → `render/types.ts` (shared render types, not a theme).
- `render/noteField.ts` → `render/fieldConfig.ts` (the renderer it named is
  gone; it holds only config + design-grid constants).
- `render/themes/{ddrA3,simplyLove}.ts` → `render/gpu/{ddrA3Art,simplyLoveArt}.ts`,
  so each skin's art sits beside its skin; `render/themes/` removed.
- The shared text primitives (`measureWidth`, `roundFont`, `squareFont`,
  `OUTLINE_INK`) moved to `render/gpu/text.ts`, so `simplyLoveSkin` and `glyphs`
  no longer import them out of the A3 art file.

Pure moves + import/docstring updates; no behavior change.

## 2. `SongSelect` — pure logic extracted + file renamed — FIXED

The 1192-line component trapped all its pure logic and had no tests. Extracted
the deterministic transforms into `src/ui/songSelectModel.ts` — row view models,
best-score bucketing, filter/sort, and the virtualization window — and drove the
component's memos through them. Added `tests/songSelectModel.test.ts` (18 cases).
Renamed `SongSelectStepline.tsx` → `SongSelect.tsx` to match its export.

Remaining optional polish (not done — larger, higher-risk on an untested visual
surface, low correctness value): splitting the JSX into sub-components
(list row, folder panel, detail panel) and moving the keyboard-nav effect into a
hook. The pure logic — the part worth testing — is now out and covered.

## 3. The two GPU skins are large (925 / 772 lines) — WATCH ITEM (not changed)

They are legitimately distinct (they share almost no drawing code), so this is
not duplication. Left as-is deliberately; the note stands: give each skin
internal seams before it re-accretes the god-object shape the orchestrator just
escaped.

## 4. Lock in the engine/app boundary — FIXED

The boundary held only by convention. Added `tests/architecture.test.ts`, which
scans the engine dirs' import/re-export specifiers and fails if any pull in
`react`/`react-dom` or `ui/`. A regression now breaks the build (via the
existing `npm test` CI step) instead of relying on review. Chose an in-repo
test over adding ESLint to avoid a new toolchain dependency for a single rule.

## 5. `docs/` layout — NOT CHANGED (deliberate)

The idea was a `docs/reviews/` subfolder for point-in-time analyses. Every doc
turned out to be cross-referenced from code comments, the README, or sibling
docs, so relocating them would break those links for purely cosmetic gain. Not
worth the churn.

## 6. README architecture map — N/A

The earlier finding assumed the old README's directory tree. The README was
rewritten upstream and no longer carries one, so there is nothing to correct;
adding a tree would run against the maintainer's trimming.

---

## Net

Findings 1, 2, and 4 are done on this branch (three commits); typecheck clean,
308 tests pass (+18 new), prettier clean. 3 is a documented watch item; 5 and 6
were deliberately left alone for the reasons above.
