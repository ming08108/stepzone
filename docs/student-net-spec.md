# Student Net Interface Spec (M4 ↔ M5 contract)

Distilled kinematic dancer: chart timeline → skeleton pose stream, replacing the
physics policy for in-browser playback. This document is the contract between
the WSL distillation pipeline (M4) and the stepzone integration (M5).

## Teacher

`~/dance-rl/ddr/runs/polish-0717-0606/chunk014/AMPJax_saved.pkl` (AMPJax),
run on MjxSkeletonTorque, 50 Hz control (dt = 0.02 s).

## Pose representation (student output)

`qpos` layout of SkeletonTorque, 33 floats, radians / meters:

- `[0:3]` root position x,y,z (meters, world; pads at ITG layout around origin)
- `[3:7]` root quaternion w,x,y,z (MuJoCo scalar-first)
- `[7:33]` 26 joint angles in the model's joint order — the distillation
  pipeline MUST emit `joint_order.json` listing the exact MuJoCo joint names
  in qpos order alongside the ONNX file. Known structure (per side):
  hip_flexion/adduction/rotation, knee_angle, ankle_angle; lumbar
  extension/bending/rotation; arm_flex/add/rot, elbow_flex (+ any remaining
  joints the model defines — trust the emitted json, not this doc).

## Student input (per 50 Hz tick), all float32

1. `goal[64]` — 8 lookahead slots × 8 dims, EXACTLY the ChartGoal encoding:
   per slot `[dt, lrx, lry, lact, rrx, rry, ract, jump]` where dt = clamped
   seconds to event (0..2.5), (lrx,lry)/(rrx,rry) = target pad center minus
   root xy, rotated into root yaw frame, zeroed when foot inactive;
   lact/ract = active flags; jump = lact*ract.
2. `prev_pose[33]` — previous output qpos (autoregressive; at t=0 the rest
   pose, which the pipeline must also emit as `rest_pose.json`).
3. `phase[2]` — sin/cos of (2π · chart_time · local_bps) beat phase; the
   pipeline defines local_bps from the chart timeline (events/sec over a 2 s
   window is acceptable); must document its exact formula in the emitted
   `student_meta.json`.

Input tensor: concat → `[99]`, name `input`, shape `[1, 99]`.
Output tensor: `qpos_next` `[1, 33]`, name `output`.
ONNX opset ≥ 17, no external data files (single .onnx).

## Emitted artifacts (M4 → repo `public/models/rl-dancer/`)

- `student.onnx`
- `student_meta.json` — {joint_order: [...26 names], rest_pose: [33],
  dt: 0.02, pad_centers: [[x,y]×4], phase_formula: "...", version: 1}
- `eval_report.json` — holdout pose MSE, foot-timing preservation metric.

## Browser side (M5)

- Recompute `goal[64]` in TS from the chart timeline (stepzone already has
  timelines via the extractor) + previous root pose — mirror ChartGoal
  (ddr_env.py) semantics exactly.
- Run ONNX via onnxruntime-web (webgpu backend, wasm fallback) at 50 Hz sim
  ticks, interpolate poses to display rate.
- Map qpos → VRM humanoid bones: compose per-side hip (flex/add/rot) into
  upperLeg quat, knee → lowerLeg, ankle → foot, lumbar triplet → spine/chest
  split, arm triplet → upperArm, elbow → lowerArm; root → hips node.
  Rest-relative rebuild in the style of mixamoToVrm.ts; per-bone gain knobs
  for proportion mismatch.
- Integrates as the attract dancer's new animation source; procedural dancer
  stays as fallback behind a flag.
