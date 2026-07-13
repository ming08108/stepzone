# Dancer model

`AvatarSample_A.vrm` is one of the official **VRoid** sample avatars published by
pixiv Inc. These sample models are provided for free use — commercial and
non-commercial, including modification and redistribution (the "all usages
allowed" sample set). It drives the attract-mode dancer (single-player), posed
by our own retargeting/animation system; see `src/render/gpu/skinnedModel.ts`.

Source: VRoid sample models — https://vroid.com/en/studio

Two-player races fall back to the light procedural dancer instead of loading
this (see `AttractConfig.model`), so the 15 MB asset is only fetched in solo play.
