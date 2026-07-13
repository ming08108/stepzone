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

## The "Miku" avatar

The `Miku` pool entry is NOT an actual Hatsune Miku model — that character is
Crypton Future Media's under the **Piapro Character License** (non-commercial,
attribution, restricted redistribution), so a real Miku VRM can't be shipped
here. Instead it's `AvatarSample_B` (a redistributable VRoid sample, sailor-style
top) with its hair recolored **teal at render time** — the `hair` field in
`MODEL_POOL` drives a luminance-preserving HAIR-material recolor in the shader
(`skinnedModel.ts`). The teal hair + sailor uniform reads Miku-ish without using
any licensed asset. Force it with `?dancerModel=Miku`.

To use a real Miku VRM you're licensed for, drop it in this folder and point a
`MODEL_POOL` entry at it locally — just don't commit it.
