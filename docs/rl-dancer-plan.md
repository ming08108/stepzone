# RL Dance Policy — Project Plan

Physics-trained policy that dances DDR charts: hits chart-driven pad targets with the correct foot at the correct time, styled like a dancer, driving the stepzone VRM attract dancer.

**Status:** M0 complete (stack validated), M1 in progress (chart pipeline agent running).

## Decisions (locked 2026-07-17)

- **Deliverables:** distilled any-chart net only (bake dropped 2026-07-17 — the rollout→clip export survives as the distillation dataset generator, not as a shipped artifact).
- **Integration:** RL output replaces the attract dancer's animation source; procedural dancer stays as fallback. Gaze/cloth/spring layers remain on top.
- **Stack:** LocoMuJoCo fork (MJX/MJWarp on JAX), WSL2 Ubuntu-24.04, single RTX 3080 10GB. Validated: stock DeepMimic H1 = 300M steps in ~32 min wall.
- **Foot assignments:** StepParity-conditioned first (dense reward, tractable exploration); end-to-end foot choice deferred to an annealing experiment (M3.5) — see below.

## Phases

### 1. Chart → training-data pipeline (stepzone repo, TS) — in progress

Batch CLI sweeping `C:\Games\ITGmania\Songs` (29 packs, ~2512 .sm/.ssc). Reuses existing chart parser + StepParity. Emits per-chart JSON timelines `{beat, t, lCol, rCol, jump}` + metadata (NPS mean/peak, BPM range, duration), curriculum buckets by NPS, deterministic ~10% holdout. Synthetic-timeline generator for early curriculum.

### 2. Sim environment (Python, LocoMuJoCo fork)

- Character: `SkeletonTorque` humanoid (human proportions → clean VRM retarget).
- World: flat floor, 4 pad zones at ITG layout.
- Obs: proprioception + goal window of next **6–8** steps (pad pos relative to root, time-to-hit, foot flag, jump) + beat phase. Window sized generously up front so M3.5 needs no obs change.
- Reward: Gaussian on assigned-foot pad contact (position + timing) − wrong-foot/miss penalties + upright/energy regularizers.
- Episodes: random chart segments, curriculum slow → dense NPS, domain randomization across charts.

### 3. Training harness (chunked)

Outer Python loop over ~10M-step jitted chunks: live W&B curves (local server), checkpoint per chunk, and an auto-rendered video per checkpoint (offscreen EGL, CPU JAX sidecar — WSLg windowed viewer is broken on this machine; videos land in W&B media + a local folder).

- **Stage A:** pure task reward — stepping on pads at all.
- **Stage B:** + AMP discriminator (fork of `jax_amp`) on LAFAN1 dance/locomotion clips. AMP, not DeepMimic: charts dictate novel motion; there is no reference trajectory to track, only a style distribution.

**Decision gate at M3 — hierarchy escalation:** single-level policy is the bet (the chart + StepParity already provides the high-level plan, per ALLSTEPS precedent). If the M3 style pass fails — style collapse under task-reward pressure, or dance quality won't hold at high NPS — escalate to a two-stage architecture: pretrain a low-level skill/latent space from dance mocap (ASE/PULSE/MaskedMimic-style, style structurally protected), then a small high-level policy steers latents to hit pads. Env, reward, chart pipeline, and export all carry over; only the training recipe changes. Side benefit: per-experiment retraining (e.g. M3.5) gets much cheaper with a frozen low level.

### 3.5 Foot-assignment annealing experiment

After the conditioned policy demonstrably dances: demote the StepParity foot flag from hard goal to a shaping bonus and decay its weight toward zero in continued training. Policy starts from solver-guided technique, free to deviate where its body prefers. Cheap A/B (config-level change): compare hit accuracy, energy, and visual quality vs the conditioned policy. Rationale: end-to-end foot choice is a long-horizon discrete planning problem with a strong double-stepping local optimum — bad foundation, good experiment.

### 4. Export + retarget

Per chart: policy rollout → per-bone quaternion tracks → VRM humanoid bones (rest-relative rebuild, mixamoToVrm-style) → compressed clip format playable via existing AnimationMixer path. Same format feeds distillation.

### 5. Deployment

Distill: small student net (chart goal window + phase → pose) trained on Phase-4 rollout clips, run in-browser via onnxruntime-web (WebGPU) for arbitrary charts, driving the attract dancer.

## Milestones

| #    | Milestone          | Exit criterion                                                     |
| ---- | ------------------ | ------------------------------------------------------------------ |
| M0   | Stack validated    | ✅ 300M-step DeepMimic run on the 3080, W&B + viewer working       |
| M1   | Chart pipeline     | index.json + timelines for corpus, bucket histogram sane           |
| M2   | Task-only policy   | Hits slow-chart pads correctly in sim viewer                       |
| M3   | AMP style pass     | Reads as dancing, not shuffling                                    |
| M3.5 | Foot annealing A/B | Conditioned vs annealed comparison recorded                        |
| M4   | Distilled student  | Student matches teacher rollouts offline (pose error + hit timing) |
| M5   | In-browser dancer  | Distilled net dancing any chart in stepzone attract mode           |

## Known risks

- Reward shaping iteration is the dominant time sink (expect "hits pads but looks drunk" ↔ "dances but misses" cycles).
- AMP discriminator balance vs task reward is fiddly.
- MJWarp is beta: 4 upstream drift bugs already patched (warp-lang pin ~=1.13.0; `nconmax`→`naconmax`; two numpy-2 scalar casts in viewer.py). Expect more; pin versions.
- High-NPS timing vs control rate: 16ths at 180 BPM = 12 steps/s ≈ 2–3 policy decisions per swing at 30 Hz. Mitigations baked in: PD position targets (sim-side PD at full physics rate does fine tracking between ticks; contact-timing _reward_ precision is set by sim dt ~1–2 ms, not control rate) and control frequency as a config knob. **Gate at M2:** measure achieved timing-error distribution; if the floor plateaus >~20 ms on dense buckets, raise to 60 Hz (~2× policy-inference cost, well within the 3080's demonstrated headroom).
- Skeleton↔VRM proportion mismatch may need per-bone gain tuning like the Mixamo path.

## Infra notes

Training env: WSL `Ubuntu-24.04`, `~/dance-rl/.venv`, loco-mujoco editable at `~/dance-rl/loco-mujoco`. Local W&B at `localhost:8080` (docker `wandb-local`); sync offline runs with `wandb sync --no-mark-synced`. Sidecar/render processes: `JAX_PLATFORMS=cpu`. Visualization: offscreen EGL video renders only (`MUJOCO_GL=egl`) — the WSLg windowed viewer is broken on this machine (windows exist but never present); copy videos to Windows and open natively.
