# Dancer models

The attract-mode dancer (single-player) is a three.js VRM avatar driven by
`ThreeVrmDancer` (`src/render/threeDancer.ts`). The selectable avatars live in the
registry `src/render/dancerModels.ts` (`DANCER_MODELS`) and are surfaced in the
settings screen (Options → DANCER MODEL). The chosen id is persisted as
`settings.dancerModel`; the default is in `DEFAULT_DANCER_MODEL`.

| id     | file                 | licensing                                                                        |
| ------ | -------------------- | -------------------------------------------------------------------------------- |
| `miku` | `Miku4.vrm`          | edited **Tda Hatsune Miku V4X** — non-commercial Piapro, see `MODELS_LICENSE.md` |
| `ps1`  | `PS1Miku.vrm`        | **original** (ours), ships freely                                                |
| `suit` | `AvatarSample_A.vrm` | VRoid CC0 sample                                                                 |
| `goth` | `AvatarSample_B.vrm` | VRoid CC0 sample                                                                 |
| `coat` | `AvatarSample_C.vrm` | VRoid CC0 sample                                                                 |

Two-player races skip the model to save GPU (see `AttractConfig`), so these
assets are only fetched in solo play.

## `Miku4.vrm` — edited, optimized Tda Miku V4X (default)

The default dancer is a **licensed derivative** of Tda's _Hatsune Miku V4X_ MMD
model: converted MMD→VRM, the skirt lengthened so it drapes over the thighs
instead of clipping, then optimized for shipping — the 63 unused facial morphs
(the VRM wires up zero blend-shape groups) were stripped and the exploded
conversion mesh re-welded (~460k → ~25k verts), taking the file from ~43 MB to
**~5.6 MB** with no visible change. Full rig, textures, materials, spring-bone
skirt/hair physics, and VRM metadata are intact.

**This is redistributed under the model's own Terms of Service, reproduced in
full (Japanese + English) with credits in [`MODELS_LICENSE.md`](./MODELS_LICENSE.md).**
Key points: **non-commercial only** (commercial use needs Crypton's permission),
no R-18 use, credit Tda. If this project ever goes commercial, remove `Miku4.vrm`
and set `DEFAULT_DANCER_MODEL` back to `ps1`.

Local-only Miku working files (`Miku4_hires.vrm`, etc.) are gitignored
(`public/models/Miku*.vrm`) with an explicit exception for the shipped
`Miku4.vrm`.

## `AvatarSample_A/B/C.vrm` — VRoid CC0 samples

The official **VRoid** sample avatars published by pixiv Inc. Free for any use
(commercial or not), no attribution required, freely redistributable (only: don't
re-license as CC0, don't sell the VRM itself). Pulled from the `madjin/vrm-samples`
mirror (`vroid/stable/AvatarSample_*.vrm`).

## `PS1Miku.vrm` — the hand-crafted PS1 dancer

An **original**, PlayStation-era low-poly "Miku-style" idol (teal twintails,
sleeveless white top, teal tie, navy skirt, thigh-high boots, painted anime face)
— ~390 triangles, flat-shaded, rigid-skinned segmented limbs, tiny procedurally
painted face texture. Every vertex and texel is generated from scratch (no licensed
asset), so it **ships freely** and is the commercial-safe fallback.

Produced by `scripts/genPs1Miku.mjs` (`node scripts/genPs1Miku.mjs`), which emits a
VRM 0.x GLB with the humanoid bone names `ThreeVrmDancer` expects. Edit the
generator and re-run to regenerate; the `.vrm` is committed as the built asset.

## Testing a model directly

`?vrm&model=<key>` renders one avatar standalone via `VrmTest`
(`src/ui/VrmTest.tsx`): `miku4`, `a`, `b`, `c`, `ps1`.
