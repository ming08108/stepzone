# Replay file format v1

A **replay** is a recorded RL-dancer rollout: a stream of humanoid pose frames
plus the chart events (notes with pad, foot, judgment, timing). The
`?replaydancer` page (`src/ui/ReplayDancer.tsx`) plays it back on the DDR stage,
and `scripts/renderReplay.mjs` records it to video.

This document is the **contract** for the capture side (Isaac). The renderer is
implemented against exactly what is written here — parser/interpolator in
`src/render/replay.ts`, verified by `tests/replay.test.ts`.

## Top-level JSON

```jsonc
{
  "version": 1,
  "fps": 60, // pose frames per second — 30 OR 60, handled generically
  "chart": {
    "name": "Song / take name",
    "notes": [
      {
        "t": 12.34, // seconds into the rollout
        "pad": 0, // 0=L, 1=R, 2=U, 3=D
        "foot": 0, // 0=left, 1=right (assigned foot)
        "judgment": "marvelous", // "marvelous" | "perfect" | "great" | "miss"
        "hit_dt_ms": -12.5, // signed timing error of the clean hit, ms; null if miss
        "hold_s": 0.0, // hold length in seconds (0 = tap)
      },
    ],
  },
  "frames": [[/* floats */] /* … one array per pose frame … */],
  "meta": {
    "checkpoint": "…",
    "ex_score": 22.8,
    "clean_rate": 0.61,
    "survived": true,
  },
}
```

- `version` — integer; currently `1`. Defaults to 1 if omitted.
- `fps` — pose-frame (control/physics) rate. **The renderer indexes frames as
  `t * fps` and interpolates, so 30 and 60 are both fine.** Capture is moving to
  60 (native physics rate — emit every physics frame).
- `chart.notes` — need not be pre-sorted; the parser sorts by `t`. `pad`/`foot`
  are clamped; an unrecognized `judgment` string falls back to `"miss"`.
- `meta` — free-form; the HUD reads `checkpoint` and `survived` if present.

## Per-frame body layout (the important part)

Each element of `frames` is a **flat array of floats** describing one pose frame.
The body set and coordinate convention are **identical to the live Isaac pose
stream** (`pose_relay.py` / `pose_stream_format.py`) so the same retarget driver
(`src/render/isaacVrmDancer.ts`) plays file and live stream interchangeably.

**Bodies:** `NBODY = 15`, the reduced humanoid_28 skeleton, in this order:

| idx | body            | idx | body           | idx | body       |
| --- | --------------- | --- | -------------- | --- | ---------- |
| 0   | pelvis          | 5   | right_hand     | 10  | right_shin |
| 1   | torso           | 6   | left_upper_arm | 11  | right_foot |
| 2   | head            | 7   | left_lower_arm | 12  | left_thigh |
| 3   | right_upper_arm | 8   | left_hand      | 13  | left_shin  |
| 4   | right_lower_arm | 9   | right_thigh    | 14  | left_foot  |

**Coordinates:** Isaac world convention — **Z up, X forward, Y left, metres** —
and **env-local** (the pose hook subtracts the env's grid origin, so the dancer's
pelvis hovers over the local origin, exactly like `?isaacviewer`). The renderer
applies the standard Isaac→three mapping `(x, y, z) → (x, z, −y)`.

**Frame = two contiguous blocks (BLOCK layout):**

```
[ 45 position floats ]   body0.x body0.y body0.z  body1.x … body14.z
[ 60 quaternion floats ] body0.w body0.x body0.y body0.z  body1.w … body14.z   (OPTIONAL)
```

- **Positions** (always): `NBODY * 3 = 45` floats, body origins in the frame above.
- **Quaternions** (optional but strongly recommended): `NBODY * 4 = 60` floats,
  each body's **world orientation** as **WXYZ** (scalar-first — the same order
  `pose_relay.py` puts on the wire), Isaac Z-up.

So a frame array length is:

- **45** → positions only. The retarget still works (limbs are _aimed_ from the
  joint positions), but **facing/axial twist degrades** — the avatar can't tell
  which way the trunk/head is turned or how a forearm pronates. Fine for a quick
  capture; not for a showcase.
- **105** → positions + quaternions. Enables the facing + twist layer. **Use
  this.** Capture is trivial: concatenate the two arrays the hook already builds.

The block layout was chosen (over interleaving per body) precisely so the capture
side can `pos.tolist() + quat.tolist()` with no reshaping.

### Why WXYZ and env-local

Both match the existing wire format so one code path serves the live viewer and
the file player. The renderer reorders WXYZ→XYZW internally (three.js order) while
interpolating; do **not** pre-convert.

## Interpolation & playback (renderer side, for reference)

- Positions **lerp**, quaternions **slerp** (shortest-arc; never a naive
  per-component quat lerp) between adjacent frames at `t * fps`.
- A per-frame position jump over **0.6 m** is treated as an env-reset teleport and
  **snapped** (no smear) — so if a capture concatenates multiple episodes, put a
  hard discontinuity between them and it reads as a clean cut.
- Foot grounding, twist calibration, cloth/spring physics are all handled by the
  reused `IsaacVrmDancer` exactly as in `?isaacviewer`.

## Scoring shown in the HUD

- **EX %** is computed live over notes with `t ≤ now` using the standard
  Fantastic/Perfect/Great/Miss = 3/2/1/0 weighting (`earned / (3·count)`).
- **Combo** increments on any non-miss and resets on a miss.
- Pads flash and judgment popups fire **statelessly** from note `t` vs playhead,
  so scrubbing/seeking and slow-mo capture stay perfectly in sync.

`meta.ex_score` is displayed context only; the running EX % is derived from the
per-note judgments so it always matches what's on screen.

## Minimal example

A 2-frame, quat-carrying, one-note replay (positions abbreviated):

```json
{
  "version": 1,
  "fps": 60,
  "chart": {
    "name": "Example",
    "notes": [{ "t": 0.5, "pad": 2, "foot": 1, "judgment": "perfect", "hit_dt_ms": -8.0, "hold_s": 0 }]
  },
  "frames": [
    [/* 45 pos */ ..., /* 60 quat wxyz */ ...],
    [/* 45 pos */ ..., /* 60 quat wxyz */ ...]
  ],
  "meta": { "checkpoint": "run/step_10000", "ex_score": 90.1, "survived": true }
}
```

A ready-to-inspect synthetic sample lives at
`tests/fixtures/replay-sample.json` (generated by `scripts/genReplayFixture.mjs`).
