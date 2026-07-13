# Dancer models

`AvatarSample_A.vrm`, `AvatarSample_B.vrm`, and `AvatarSample_C.vrm` are the
official **VRoid** sample avatars published by pixiv Inc. These sample models are
free for anyone to use in any activity (commercial or not), with no attribution
required, and may be freely redistributed (the only restrictions: don't re-license
them as CC0 and don't sell the VRM file itself). They drive the attract-mode
dancer (single-player); one is chosen at random per session for variety
(`MODEL_POOL` / `pickModelUrl` in `src/render/gpu/attractGpu.ts`), posed by our
own retargeting/animation system (`src/render/gpu/skinnedModel.ts`,
`retargetRig.ts`). Force a specific one for testing with `?dancerModel=B`.

Source: VRoid sample models (VRoid Hub / vroid.com/en/studio), pulled from the
`madjin/vrm-samples` mirror (`vroid/stable/AvatarSample_*.vrm`).

Two-player races fall back to the light procedural dancer instead of loading a
model (see `AttractConfig.model`), so these ~13–15 MB assets are only fetched in
solo play.

## Note on other characters (e.g. Hatsune Miku)

We deliberately do NOT ship a Hatsune Miku (or similar licensed-character) model.
Miku is Crypton Future Media's character under the **Piapro Character License** —
non-commercial only, attribution required, and redistribution is restricted — so
a Miku VRM cannot be committed to this repo. To use one locally, drop a VRM you're
licensed to use into this folder and add it to `MODEL_POOL`; just don't commit it.
