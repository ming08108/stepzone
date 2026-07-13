/**
 * AttractDancer — the low-poly anime-girl dancer, rebuilt on the standard
 * game-animation pipeline instead of procedural pose rules. It is a pure-CPU
 * triangle-mesh generator for the GPU pipeline: build(time, beat) refills two
 * reused vertex buffers (x, y, r, g, b per vertex, triangle list, 960x540
 * design space, y down) — `solid` holds the opaque flat-shaded body facets,
 * `additive` holds the neon silhouette edges, rim-glow and hand-burst spikes.
 *
 * ARCHITECTURE (how real games animate characters, applied here):
 *
 *  1. SKELETON + FK — a 3D bone hierarchy (pelvis → torso → neck/head,
 *     shoulder line → arms; pelvis → hips → legs) whose joint positions are
 *     solved by forward kinematics from a channel pose. Bones live in a real
 *     3D space (x right, y down, z toward the viewer) and are projected to
 *     the 2D design space through a weak-perspective camera with a gentle
 *     downward tilt, so depth reads: near limbs get bigger and lower, the far
 *     Up panel sits higher and smaller, and body yaw turns the shoulder/hip
 *     lines through z instead of just sliding pixels sideways.
 *
 *  2. AUTHORED ANIMATION CLIPS — the core. Motion quality comes from a small
 *     library of hand-keyframed dance-move clips (an animator's keyframes,
 *     not springs): an idle GROOVE loop, one STEP clip per panel (L/D/U/R,
 *     each selling the step with weight shift, counter-twist, arm line and
 *     head look), a two-foot JUMP (wind-up crouch → airborne → simultaneous
 *     two-foot landing ON the beat → squash and settle), and a FLOURISH for
 *     long gaps. Each clip is a set of full-body keyframes at phase times,
 *     sampled with non-uniform Catmull-Rom/Hermite interpolation (C1-smooth,
 *     eased endpoints, zero end tangents — arrives on-pose, no overshoot).
 *     Right-side steps are exact mirrors of left-side clips, generated once
 *     at load through a channel mirror table, like a game's mirrored-clip
 *     import.
 *
 *  3. CLIP SCHEDULER + CROSS-FADE BLENDING — a tiny animation state machine.
 *     The chart (StepParity beats + per-foot panel placement) schedules each
 *     upcoming note's clip so its authored IMPACT keyframe lands exactly on
 *     the note beat (clips are time-scaled to fit dense streams). Active
 *     clips run in a fixed player pool with smooth fade-in/out envelopes;
 *     the blended pose is the normalized weighted sum of the sampled clips,
 *     with the idle groove owning whatever weight remains — so she cross-
 *     fades step→step through fast streams and settles back into the groove
 *     between notes, never popping.
 *
 *  4. FOOT IK ON TOP — after sampling+blending, each foot is planted by an
 *     analytic two-bone IK solve (hip→knee→ankle, knee pole aimed forward so
 *     knees never flip) onto its exact StepParity panel target on the 3D
 *     floor plane — crossovers verbatim. Foot LOCKING: a planted foot is
 *     pinned to its committed plant position until a clip's swing channel
 *     moves it; the swing channel is authored with hold keys and clamped so
 *     the foot leaves late, travels under an authored lift arc, and lands
 *     exactly on the beat with zero slide. Jumps own BOTH feet: each lands
 *     simultaneously on its own solved panel (any combination — L+R straddle,
 *     U+D split, L+U…), weight centered between them.
 *
 *  5. SECONDARY MOTION — twin-tails, ahoge and skirt hem stay on simple
 *     damped-spring smoothing (standard for cloth/hair), layered after the
 *     body solve; the BODY itself is entirely clip-driven.
 *
 * With no chart the scheduler synthesizes an 8-beat L/D/R/U(+jump) pattern;
 * with no beat (NaN/negative lead-in) she plays the idle groove on a slow
 * internal pulse. Everything is sampled from absolute beat/time (framerate-
 * independent), nothing allocates per frame, and every emitted triangle and
 * the perspective divide are guarded against non-finite values.
 */

// ---- design space (matches attractBackground.ts) ---------------------------

const W = 960;
const H = 540;
const CX = W / 2;
const FOOT_Y = H * 0.86; // where the feet plant
const BODY_H = H * 0.55; // dancer height in px

// ---- palette (copied from attractBackground.ts) -----------------------------

type RGB = readonly [number, number, number];

interface Palette {
  gradTop: RGB;
  gradMid: RGB;
  gradBot: RGB;
  accentA: RGB; // hero: hair, neon rim
  accentB: RGB; // secondary: skirt
  accentC: RGB; // trim, burst sparks
  accentD: RGB;
  white: RGB;
}

/** #rrggbb → [r,g,b]. */
function hex(s: string): RGB {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function smooth01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/** The 4 variants, keyed by the `variant` ctor arg (0..3). */
const PALETTES: readonly Palette[] = [
  {
    // 0 — Extreme Nights: blacklight arcade at 3AM, magenta/cyan vortex.
    gradTop: hex('#5B18A8'),
    gradMid: hex('#2B0B54'),
    gradBot: hex('#0A0118'),
    accentA: hex('#FF2E9A'),
    accentB: hex('#00E5FF'),
    accentC: hex('#A8FF00'),
    accentD: hex('#FF7A00'),
    white: hex('#FFF7FF'),
  },
  {
    // 1 — Butterfly Sunrise: eurobeat stadium at golden hour.
    gradTop: hex('#6A1A00'),
    gradMid: hex('#4A1200'),
    gradBot: hex('#1A0500'),
    accentA: hex('#FF0066'),
    accentB: hex('#FFC400'),
    accentC: hex('#FF3D2E'),
    accentD: hex('#FFC400'),
    white: hex('#FFF7F0'),
  },
  {
    // 2 — Sakura Rush: dreamy J-pop random-movie.
    gradTop: hex('#3A0A3F'),
    gradMid: hex('#240433'),
    gradBot: hex('#14001F'),
    accentA: hex('#FF8AD8'),
    accentB: hex('#00FFC8'),
    accentC: hex('#FFFFFF'),
    accentD: hex('#FF8AD8'),
    white: hex('#FFFFFF'),
  },
  {
    // 3 — Healing Vision: terminal-green cyber-rave.
    gradTop: hex('#003318'),
    gradMid: hex('#001F0E'),
    gradBot: hex('#001406'),
    accentA: hex('#A8FF00'),
    accentB: hex('#00FFB2'),
    accentC: hex('#CFFF66'),
    accentD: hex('#00FFB2'),
    white: hex('#EAFFEA'),
  },
];

// ---- animation channels ------------------------------------------------------
// A pose is a flat vector of N_CH floats — the local transform channels of the
// rig, exactly like an engine's per-bone float curves. Angles in radians,
// offsets as fractions of BODY_H. Lateral sign convention: + is screen-right.

const CH_YAW = 0; // body yaw about the vertical axis (+ turns right side away)
const CH_LEAN = 1; // torso roll (side lean)
const CH_PITCH = 2; // torso pitch (+ bows toward the viewer)
const CH_TWIST = 3; // shoulder line yaw relative to the pelvis
const CH_SIDE = 4; // ribcage lateral shift (contrapposto S-curve)
const CH_HYAW = 5; // head yaw (face turn)
const CH_HPIT = 6; // head pitch (+ nods down)
const CH_HROLL = 7; // head roll (ear-to-shoulder tilt)
const CH_CROUCH = 8; // pelvis drop (+ down, − rises/airborne)
const CH_SWAY = 9; // pelvis lateral shift (weight transfer)
const CH_PELVZ = 10; // pelvis depth shift (+ toward viewer)
const CH_LIST = 11; // pelvic list (+ = right hip hiked up)
const CH_LABD = 12; // left arm: abduction from straight-down, + raises outward
const CH_LFWD = 13; // left upper arm toward the viewer
const CH_LELB = 14; // left elbow bend (continues the coronal arc)
const CH_LLOF = 15; // left forearm extra toward the viewer
const CH_RABD = 16; // right arm block, same layout
const CH_RFWD = 17;
const CH_RELB = 18;
const CH_RLOF = 19;
const CH_SWGL = 20; // left foot swing progress 0→1 (0 locked at plant, 1 landed)
const CH_LIFTL = 21; // left foot lift arc (fraction of BODY_H)
const CH_SWGR = 22; // right foot swing progress
const CH_LIFTR = 23; // right foot lift arc
const N_CH = 24;

// Mirror table (left↔right): channel source index + sign, applied to a sampled
// pose. This is how the right-side step clips are generated from the left ones.
const MIR_SRC = new Int32Array(N_CH);
const MIR_SGN = new Float32Array(N_CH);
{
  for (let i = 0; i < N_CH; i++) {
    MIR_SRC[i] = i;
    MIR_SGN[i] = 1;
  }
  const NEG = [CH_YAW, CH_LEAN, CH_TWIST, CH_SIDE, CH_HYAW, CH_HROLL, CH_SWAY, CH_LIST];
  for (const c of NEG) MIR_SGN[c] = -1;
  const swap = (a: number, b: number): void => {
    MIR_SRC[a] = b;
    MIR_SRC[b] = a;
  };
  for (let k = 0; k < 4; k++) swap(CH_LABD + k, CH_RABD + k);
  swap(CH_SWGL, CH_SWGR);
  swap(CH_LIFTL, CH_LIFTR);
}

/** The relaxed base pose every keyframe is authored as overrides on. */
const REST = new Float32Array(N_CH);
{
  REST[CH_CROUCH] = 0.032;
  REST[CH_LABD] = 0.18;
  REST[CH_LFWD] = 0.1;
  REST[CH_LELB] = 0.22;
  REST[CH_LLOF] = 0.45;
  REST[CH_RABD] = 0.18;
  REST[CH_RFWD] = 0.1;
  REST[CH_RELB] = 0.22;
  REST[CH_RLOF] = 0.45;
}

// ---- clip data + authoring helpers -------------------------------------------

interface Clip {
  /** Key phases, ascending, first at 0. */
  times: Float32Array;
  /** nKeys * N_CH channel values. */
  data: Float32Array;
  n: number;
  /** Nominal duration in beats. */
  beats: number;
  /** Phase where the note-hit lands (feet plant, pose accents). */
  impact: number;
  loop: boolean;
}

type KeyOver = Readonly<Record<number, number>>;

/** Bake REST + overrides into one pose row. */
function row(over: KeyOver): Float32Array {
  const r = new Float32Array(REST);
  for (const k in over) r[+k] = over[+k];
  return r;
}

/** Mirror a baked pose row left↔right. */
function mirrorRow(src: Float32Array): Float32Array {
  const d = new Float32Array(N_CH);
  for (let c = 0; c < N_CH; c++) d[c] = MIR_SGN[c] * src[MIR_SRC[c]];
  return d;
}

function clipFromRows(
  beats: number,
  impact: number,
  loop: boolean,
  times: readonly number[],
  rows: readonly Float32Array[],
): Clip {
  const n = times.length;
  const data = new Float32Array(n * N_CH);
  for (let i = 0; i < n; i++) data.set(rows[i], i * N_CH);
  return { times: new Float32Array(times), data, n, beats, impact, loop };
}

function makeClip(
  beats: number,
  impact: number,
  loop: boolean,
  keys: readonly (readonly [number, KeyOver])[],
): Clip {
  return clipFromRows(
    beats,
    impact,
    loop,
    keys.map((k) => k[0]),
    keys.map((k) => row(k[1])),
  );
}

/** Whole-clip mirror (same timing, left↔right pose). */
function mirrorClip(c: Clip): Clip {
  const data = new Float32Array(c.n * N_CH);
  for (let i = 0; i < c.n; i++) {
    const o = i * N_CH;
    for (let ch = 0; ch < N_CH; ch++) data[o + ch] = MIR_SGN[ch] * c.data[o + MIR_SRC[ch]];
  }
  return { times: c.times, data, n: c.n, beats: c.beats, impact: c.impact, loop: c.loop };
}

// ---- Catmull-Rom clip sampling -------------------------------------------------
// Non-uniform Catmull-Rom evaluated as cubic Hermite per channel — the same
// float-curve evaluation engines use for compressed animation tracks. Loops
// wrap tangents across the seam; one-shots use zero end tangents so the clip
// eases in from its first key and ARRIVES on its last pose with no overshoot.

const MIR_TMP = new Float32Array(N_CH); // module scratch for mirrored sampling

function sampleClip(c: Clip, phase: number, out: Float32Array, mirrored: boolean): void {
  const n = c.n;
  const T = c.times;
  const D = c.data;
  let p = Number.isFinite(phase) ? phase : 0;
  if (c.loop) p -= Math.floor(p);
  else p = clamp(p, 0, 1);

  // Segment i: T[i] <= p < T[i+1] (loop: last segment wraps to T[0]+1).
  let i = n - 1;
  for (let k = 1; k < n; k++) {
    if (T[k] > p) {
      i = k - 1;
      break;
    }
  }
  if (!c.loop && i >= n - 1) i = n - 2;
  if (i < 0) i = 0;

  // Neighbor key times/rows: loops wrap across the seam (period 1), one-shots
  // clamp to their end keys. Indices needed: i-1, i, i+1, i+2.
  let tA: number;
  let t0: number;
  let t1: number;
  let tD: number;
  let rA: number;
  let rB: number;
  let rC: number;
  let rD2: number;
  if (c.loop) {
    const iA = (((i - 1) % n) + n) % n;
    const iC = (i + 1) % n;
    const iD = (i + 2) % n;
    tA = i - 1 < 0 ? T[iA] - 1 : T[iA];
    t0 = T[i];
    t1 = i + 1 >= n ? T[iC] + 1 : T[iC];
    tD = i + 2 >= n ? T[iD] + 1 : T[iD];
    rA = iA * N_CH;
    rB = i * N_CH;
    rC = iC * N_CH;
    rD2 = iD * N_CH;
  } else {
    const iA = i - 1 < 0 ? 0 : i - 1;
    const iC = i + 1 > n - 1 ? n - 1 : i + 1;
    const iD = i + 2 > n - 1 ? n - 1 : i + 2;
    tA = T[iA];
    t0 = T[i];
    t1 = T[iC];
    tD = T[iD];
    rA = iA * N_CH;
    rB = i * N_CH;
    rC = iC * N_CH;
    rD2 = iD * N_CH;
  }

  const h = Math.max(t1 - t0, 1e-6);
  const u = clamp((p - t0) / h, 0, 1);
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;

  const dtB = t1 - tA;
  const dtC = tD - t0;
  // Zero end tangents for one-shots (ease both ends, no overshoot at ends).
  const mB0 = !c.loop && i === 0;
  const mC0 = !c.loop && i + 1 === n - 1;

  const dst = mirrored ? MIR_TMP : out;
  for (let ch = 0; ch < N_CH; ch++) {
    const pB = D[rB + ch];
    const pC = D[rC + ch];
    const mB = mB0 || !(dtB > 1e-6) ? 0 : ((pC - D[rA + ch]) / dtB) * h;
    const mC = mC0 || !(dtC > 1e-6) ? 0 : ((D[rD2 + ch] - pB) / dtC) * h;
    const v = h00 * pB + h10 * mB + h01 * pC + h11 * mC;
    dst[ch] = Number.isFinite(v) ? v : REST[ch];
  }
  if (mirrored) {
    for (let ch = 0; ch < N_CH; ch++) out[ch] = MIR_SGN[ch] * MIR_TMP[MIR_SRC[ch]];
  }
}

// ---- THE CLIP LIBRARY ----------------------------------------------------------
// Hand-authored keyframes, written the way an animator blocks a dance move:
// anticipation → coil over the support foot → the move LANDS on the impact
// key (scheduled onto the note beat) → settle back toward the groove. Foot
// swing channels use hold keys (0…0, then rise to 1 and hold) so feet stay
// locked, leave late, and arrive exactly at 1 on impact.

/** IDLE GROOVE — 2-beat loop. Down INTO each beat (dancers pulse down on the
 *  count), weight rocking right on beat 1 / left on beat 2, shoulders counter-
 *  twisting, elbows pumping, head bobbing with a little roll. The second half
 *  is the exact mirror of the first so the loop never drifts. */
const IDLE = (() => {
  const k0: KeyOver = {
    [CH_CROUCH]: 0.052,
    [CH_SWAY]: 0.042,
    [CH_LIST]: 0.016,
    [CH_LEAN]: 0.05,
    [CH_TWIST]: -0.13,
    [CH_YAW]: 0.1,
    [CH_SIDE]: -0.012,
    [CH_PELVZ]: 0.012,
    [CH_HROLL]: -0.06,
    [CH_HPIT]: 0.05,
    [CH_LABD]: 0.2,
    [CH_LFWD]: 0.12,
    [CH_LELB]: 0.55,
    [CH_LLOF]: 0.55,
    [CH_RABD]: 0.3,
    [CH_RFWD]: 0.22,
    [CH_RELB]: 0.85,
    [CH_RLOF]: 0.4,
  };
  const k1: KeyOver = {
    [CH_CROUCH]: 0.016,
    [CH_SWAY]: 0.026,
    [CH_LIST]: 0.01,
    [CH_LEAN]: 0.03,
    [CH_TWIST]: -0.05,
    [CH_YAW]: 0.05,
    [CH_SIDE]: -0.006,
    [CH_HROLL]: -0.02,
    [CH_HPIT]: -0.035,
    [CH_LABD]: 0.17,
    [CH_LFWD]: 0.1,
    [CH_LELB]: 0.35,
    [CH_LLOF]: 0.5,
    [CH_RABD]: 0.22,
    [CH_RFWD]: 0.15,
    [CH_RELB]: 0.6,
    [CH_RLOF]: 0.45,
  };
  const r0 = row(k0);
  const r1 = row(k1);
  return clipFromRows(2, 0, true, [0, 0.25, 0.5, 0.75], [r0, r1, mirrorRow(r0), mirrorRow(r1)]);
})();

/** STEP to the LEFT panel, canonical left foot. Eyes the panel early, coils
 *  over the right (support) foot, then opens: left arm flung out along the
 *  step line, right arm pulled across the ribs, head and torso committed. */
const STEP_L = makeClip(1.5, 0.6, false, [
  [
    0,
    {
      [CH_CROUCH]: 0.035,
      [CH_SWAY]: 0.02,
      [CH_TWIST]: 0.06,
      [CH_YAW]: 0.05,
      [CH_HYAW]: -0.1,
      [CH_LABD]: 0.12,
      [CH_LFWD]: 0.22,
      [CH_LELB]: 0.9,
      [CH_LLOF]: 0.3,
      [CH_RABD]: 0.3,
      [CH_RFWD]: 0.12,
      [CH_RELB]: 0.5,
      [CH_RLOF]: 0.4,
    },
  ],
  [
    0.3,
    {
      [CH_CROUCH]: 0.05,
      [CH_SWAY]: 0.058,
      [CH_LIST]: 0.022,
      [CH_LEAN]: 0.05,
      [CH_TWIST]: 0.16,
      [CH_YAW]: 0.12,
      [CH_SIDE]: -0.015,
      [CH_HYAW]: -0.22,
      [CH_HROLL]: 0.04,
      [CH_LABD]: 0.1,
      [CH_LFWD]: 0.3,
      [CH_LELB]: 1.35,
      [CH_LLOF]: 0.25,
      [CH_RABD]: 0.42,
      [CH_RFWD]: 0.1,
      [CH_RELB]: 0.7,
      [CH_LIFTL]: 0.012,
    },
  ],
  [
    0.45,
    {
      [CH_CROUCH]: 0.042,
      [CH_SWAY]: 0.045,
      [CH_LIST]: 0.014,
      [CH_TWIST]: 0.02,
      [CH_YAW]: 0.02,
      [CH_HYAW]: -0.27,
      [CH_LABD]: 0.9,
      [CH_LFWD]: 0.15,
      [CH_LELB]: 0.7,
      [CH_LLOF]: 0.12,
      [CH_RABD]: 0.3,
      [CH_RFWD]: 0.2,
      [CH_RELB]: 0.95,
      [CH_SWGL]: 0.55,
      [CH_LIFTL]: 0.062,
    },
  ],
  [
    0.6,
    {
      [CH_CROUCH]: 0.045,
      [CH_SWAY]: -0.012,
      [CH_LIST]: -0.02,
      [CH_LEAN]: -0.07,
      [CH_TWIST]: -0.18,
      [CH_YAW]: -0.13,
      [CH_SIDE]: 0.015,
      [CH_HYAW]: -0.3,
      [CH_HROLL]: -0.08,
      [CH_HPIT]: 0.03,
      [CH_LABD]: 1.8,
      [CH_LFWD]: 0.05,
      [CH_LELB]: 0.18,
      [CH_LLOF]: 0.05,
      [CH_RABD]: 0.15,
      [CH_RFWD]: 0.35,
      [CH_RELB]: 1.35,
      [CH_RLOF]: 0.3,
      [CH_SWGL]: 1,
      [CH_LIFTL]: 0,
    },
  ],
  [
    0.8,
    {
      [CH_CROUCH]: 0.034,
      [CH_SWAY]: -0.028,
      [CH_LIST]: -0.012,
      [CH_LEAN]: -0.04,
      [CH_TWIST]: -0.08,
      [CH_YAW]: -0.08,
      [CH_HYAW]: -0.16,
      [CH_HROLL]: -0.04,
      [CH_LABD]: 1.15,
      [CH_LELB]: 0.45,
      [CH_LLOF]: 0.2,
      [CH_RABD]: 0.22,
      [CH_RFWD]: 0.2,
      [CH_RELB]: 0.8,
      [CH_SWGL]: 1,
    },
  ],
  [
    1,
    {
      [CH_CROUCH]: 0.04,
      [CH_SWAY]: -0.016,
      [CH_LEAN]: -0.01,
      [CH_YAW]: -0.03,
      [CH_HYAW]: -0.04,
      [CH_LABD]: 0.3,
      [CH_LFWD]: 0.12,
      [CH_LELB]: 0.5,
      [CH_RABD]: 0.22,
      [CH_RFWD]: 0.12,
      [CH_RELB]: 0.45,
      [CH_SWGL]: 1,
    },
  ],
]);

/** STEP to the RIGHT panel = exact mirror of STEP_L (canonical right foot). */
const STEP_R = mirrorClip(STEP_L);

/** STEP to the UP (far) panel, canonical right foot. A tall forward reach:
 *  small bow to coil, then the chest opens, both arms rise into a V overhead
 *  (this is the row that fires the hand-burst), face lifts. */
const STEP_U = makeClip(1.5, 0.6, false, [
  [
    0,
    {
      [CH_CROUCH]: 0.045,
      [CH_SWAY]: -0.025,
      [CH_PITCH]: 0.05,
      [CH_HPIT]: 0.07,
      [CH_LABD]: 0.16,
      [CH_LFWD]: -0.1,
      [CH_LELB]: 0.35,
      [CH_LLOF]: 0.1,
      [CH_RABD]: 0.16,
      [CH_RFWD]: -0.14,
      [CH_RELB]: 0.3,
      [CH_RLOF]: 0.1,
    },
  ],
  [
    0.3,
    {
      [CH_CROUCH]: 0.055,
      [CH_SWAY]: -0.052,
      [CH_LIST]: -0.02,
      [CH_PITCH]: 0.08,
      [CH_LEAN]: -0.03,
      [CH_HPIT]: 0.1,
      [CH_LABD]: 0.22,
      [CH_LFWD]: -0.22,
      [CH_LELB]: 0.5,
      [CH_LLOF]: 0.05,
      [CH_RABD]: 0.22,
      [CH_RFWD]: -0.26,
      [CH_RELB]: 0.45,
      [CH_RLOF]: 0.05,
      [CH_LIFTR]: 0.012,
    },
  ],
  [
    0.45,
    {
      [CH_CROUCH]: 0.03,
      [CH_SWAY]: -0.04,
      [CH_PITCH]: 0.02,
      [CH_HPIT]: -0.02,
      [CH_LABD]: 1.5,
      [CH_LELB]: 0.4,
      [CH_LLOF]: 0.05,
      [CH_RABD]: 1.5,
      [CH_RELB]: 0.4,
      [CH_RLOF]: 0.05,
      [CH_SWGR]: 0.55,
      [CH_LIFTR]: 0.07,
    },
  ],
  [
    0.6,
    {
      [CH_CROUCH]: -0.012,
      [CH_SWAY]: -0.02,
      [CH_PITCH]: -0.07,
      [CH_PELVZ]: -0.02,
      [CH_TWIST]: -0.05,
      [CH_LEAN]: 0.02,
      [CH_HPIT]: -0.16,
      [CH_LABD]: 2.75,
      [CH_LFWD]: 0.1,
      [CH_LELB]: 0.12,
      [CH_LLOF]: 0.05,
      [CH_RABD]: 2.75,
      [CH_RFWD]: 0.1,
      [CH_RELB]: 0.12,
      [CH_RLOF]: 0.05,
      [CH_SWGR]: 1,
      [CH_LIFTR]: 0,
    },
  ],
  [
    0.8,
    {
      [CH_CROUCH]: 0.018,
      [CH_PITCH]: -0.03,
      [CH_HPIT]: -0.07,
      [CH_LABD]: 2.25,
      [CH_LELB]: 0.3,
      [CH_RABD]: 2.25,
      [CH_RELB]: 0.3,
      [CH_SWGR]: 1,
    },
  ],
  [
    1,
    {
      [CH_CROUCH]: 0.038,
      [CH_SWAY]: -0.02,
      [CH_HPIT]: -0.02,
      [CH_LABD]: 0.35,
      [CH_LELB]: 0.4,
      [CH_LLOF]: 0.4,
      [CH_RABD]: 0.3,
      [CH_RELB]: 0.4,
      [CH_RLOF]: 0.4,
      [CH_SWGR]: 1,
    },
  ],
]);

/** STEP to the DOWN (near) panel, canonical left foot. A stomp toward the
 *  viewer: lifts a touch first (anticipation UP before the down hit), then
 *  dips deep over the near panel, fists pulled to the ribs, head down. */
const STEP_D = makeClip(1.5, 0.6, false, [
  [
    0,
    {
      [CH_CROUCH]: 0.02,
      [CH_SWAY]: 0.024,
      [CH_HPIT]: -0.04,
      [CH_LABD]: 0.5,
      [CH_LFWD]: 0.18,
      [CH_LELB]: 0.6,
      [CH_LLOF]: 0.3,
      [CH_RABD]: 0.5,
      [CH_RFWD]: 0.18,
      [CH_RELB]: 0.6,
      [CH_RLOF]: 0.3,
    },
  ],
  [
    0.3,
    {
      [CH_CROUCH]: 0.024,
      [CH_SWAY]: 0.055,
      [CH_LIST]: 0.02,
      [CH_YAW]: 0.08,
      [CH_TWIST]: 0.1,
      [CH_LEAN]: 0.04,
      [CH_HPIT]: -0.02,
      [CH_LABD]: 0.62,
      [CH_LFWD]: 0.22,
      [CH_LELB]: 0.75,
      [CH_RABD]: 0.62,
      [CH_RFWD]: 0.22,
      [CH_RELB]: 0.75,
      [CH_LIFTL]: 0.015,
    },
  ],
  [
    0.44,
    {
      [CH_CROUCH]: 0.05,
      [CH_SWAY]: 0.04,
      [CH_PITCH]: 0.06,
      [CH_HPIT]: 0.05,
      [CH_LABD]: 0.35,
      [CH_LFWD]: 0.3,
      [CH_LELB]: 1.2,
      [CH_RABD]: 0.35,
      [CH_RFWD]: 0.3,
      [CH_RELB]: 1.2,
      [CH_SWGL]: 0.55,
      [CH_LIFTL]: 0.05,
    },
  ],
  [
    0.6,
    {
      [CH_CROUCH]: 0.105,
      [CH_SWAY]: 0.012,
      [CH_PITCH]: 0.13,
      [CH_PELVZ]: 0.02,
      [CH_LEAN]: -0.03,
      [CH_YAW]: -0.05,
      [CH_TWIST]: -0.09,
      [CH_HPIT]: 0.15,
      [CH_LABD]: 0.1,
      [CH_LFWD]: 0.4,
      [CH_LELB]: 1.85,
      [CH_LLOF]: 0.25,
      [CH_RABD]: 0.1,
      [CH_RFWD]: 0.4,
      [CH_RELB]: 1.85,
      [CH_RLOF]: 0.25,
      [CH_SWGL]: 1,
      [CH_LIFTL]: 0,
    },
  ],
  [
    0.8,
    {
      [CH_CROUCH]: 0.06,
      [CH_PITCH]: 0.06,
      [CH_HPIT]: 0.07,
      [CH_LABD]: 0.2,
      [CH_LFWD]: 0.25,
      [CH_LELB]: 1.1,
      [CH_RABD]: 0.2,
      [CH_RFWD]: 0.25,
      [CH_RELB]: 1.1,
      [CH_SWGL]: 1,
    },
  ],
  [
    1,
    {
      [CH_CROUCH]: 0.038,
      [CH_PITCH]: 0.01,
      [CH_SWGL]: 1,
    },
  ],
]);

/** JUMP — a first-class two-foot move (any panel pair: L+R straddle, U+D
 *  split, L+U…): deep wind-up crouch with arms swept back → BOTH feet leave
 *  the floor, body rises, arms fling into an open X at the apex → both feet
 *  land simultaneously ON the beat with a landing squash → rebound settle.
 *  Weight stays CENTERED (sway/list zero) so she lands between her panels. */
const JUMP = makeClip(1.7, 0.65, false, [
  [0, { [CH_CROUCH]: 0.035, [CH_HPIT]: 0.02 }],
  [
    0.28,
    {
      [CH_CROUCH]: 0.105,
      [CH_PITCH]: 0.11,
      [CH_HPIT]: 0.1,
      [CH_LABD]: 0.25,
      [CH_LFWD]: -0.35,
      [CH_LELB]: 0.35,
      [CH_LLOF]: -0.05,
      [CH_RABD]: 0.25,
      [CH_RFWD]: -0.35,
      [CH_RELB]: 0.35,
      [CH_RLOF]: -0.05,
    },
  ],
  [
    0.42,
    {
      [CH_CROUCH]: -0.03,
      [CH_PITCH]: -0.02,
      [CH_HPIT]: -0.05,
      [CH_LABD]: 1.2,
      [CH_LFWD]: 0.05,
      [CH_LELB]: 0.3,
      [CH_RABD]: 1.2,
      [CH_RFWD]: 0.05,
      [CH_RELB]: 0.3,
      [CH_SWGL]: 0.35,
      [CH_SWGR]: 0.35,
      [CH_LIFTL]: 0.06,
      [CH_LIFTR]: 0.06,
    },
  ],
  [
    0.53,
    {
      [CH_CROUCH]: -0.08,
      [CH_PITCH]: -0.06,
      [CH_HPIT]: -0.13,
      [CH_LABD]: 2.55,
      [CH_LELB]: 0.18,
      [CH_LLOF]: 0.05,
      [CH_RABD]: 2.55,
      [CH_RELB]: 0.18,
      [CH_RLOF]: 0.05,
      [CH_SWGL]: 0.7,
      [CH_SWGR]: 0.7,
      [CH_LIFTL]: 0.095,
      [CH_LIFTR]: 0.095,
    },
  ],
  [
    0.65,
    {
      [CH_CROUCH]: 0.09,
      [CH_PITCH]: 0.09,
      [CH_HPIT]: 0.05,
      [CH_LABD]: 1.5,
      [CH_LELB]: 0.5,
      [CH_RABD]: 1.5,
      [CH_RELB]: 0.5,
      [CH_SWGL]: 1,
      [CH_SWGR]: 1,
      [CH_LIFTL]: 0,
      [CH_LIFTR]: 0,
    },
  ],
  [
    0.82,
    {
      [CH_CROUCH]: 0.042,
      [CH_PITCH]: 0.02,
      [CH_HPIT]: -0.02,
      [CH_LABD]: 0.6,
      [CH_LELB]: 0.55,
      [CH_LLOF]: 0.35,
      [CH_RABD]: 0.6,
      [CH_RELB]: 0.55,
      [CH_RLOF]: 0.35,
      [CH_SWGL]: 1,
      [CH_SWGR]: 1,
    },
  ],
  [1, { [CH_CROUCH]: 0.036, [CH_SWGL]: 1, [CH_SWGR]: 1 }],
]);

/** FLOURISH — a 2-beat body-roll wave for long gaps: yaw sweeps left→right
 *  with a counter-twist while one arm winds up and releases overhead. Feet
 *  never move (no swing channels), so plants stay locked. */
const FLOURISH = makeClip(2, 0, false, [
  [0, { [CH_CROUCH]: 0.04, [CH_YAW]: -0.06 }],
  [
    0.22,
    {
      [CH_YAW]: -0.2,
      [CH_TWIST]: 0.22,
      [CH_LEAN]: 0.06,
      [CH_CROUCH]: 0.03,
      [CH_HYAW]: -0.15,
      [CH_HROLL]: 0.06,
      [CH_LABD]: 0.9,
      [CH_LFWD]: 0.3,
      [CH_LELB]: 1.25,
      [CH_LLOF]: 0.2,
      [CH_RABD]: 0.35,
      [CH_RELB]: 0.7,
    },
  ],
  [
    0.48,
    {
      [CH_YAW]: 0.02,
      [CH_TWIST]: -0.06,
      [CH_PITCH]: 0.09,
      [CH_CROUCH]: 0.06,
      [CH_SIDE]: 0.012,
      [CH_HROLL]: 0.1,
      [CH_HPIT]: 0.06,
      [CH_LABD]: 1.9,
      [CH_LELB]: 0.6,
      [CH_LLOF]: 0.15,
      [CH_RABD]: 0.7,
      [CH_RFWD]: 0.25,
      [CH_RELB]: 1.0,
    },
  ],
  [
    0.72,
    {
      [CH_YAW]: 0.2,
      [CH_TWIST]: -0.22,
      [CH_LEAN]: -0.06,
      [CH_PITCH]: -0.04,
      [CH_CROUCH]: 0.02,
      [CH_HYAW]: 0.2,
      [CH_HROLL]: -0.07,
      [CH_LABD]: 2.45,
      [CH_LELB]: 0.18,
      [CH_RABD]: 0.5,
      [CH_RELB]: 0.6,
    },
  ],
  [1, { [CH_YAW]: 0.03, [CH_CROUCH]: 0.04 }],
]);

/** The clip registry. Indices are stable (players store an index). */
const CLIPS: readonly Clip[] = [IDLE, STEP_L, STEP_D, STEP_U, STEP_R, JUMP, FLOURISH];
const CLIP_JUMP = 5;
const CLIP_FLOURISH = 6;
/** Panel (0=L,1=D,2=U,3=R) → step clip index. */
const PANEL_CLIP: readonly number[] = [1, 2, 3, 4];
/** Canonical stepping foot per clip (-1 = none/both). */
const CLIP_FOOT: readonly number[] = [-1, 0, 0, 1, 1, -1, -1];

// ---- chart step type -----------------------------------------------------------

/** One note row: beat + a 4-bit L/D/U/R column mask (bit0=L,1=D,2=U,3=R; a
 *  jump lights >1 bit). lCol/rCol (0..3, or -1) are the optional StepParity foot
 *  placement — the panel each foot steps to this row — so the dancer can foot
 *  the chart exactly as a player would (crossovers included). Absent ⇒ the
 *  dancer falls back to its own column→foot heuristic. */
export interface Step {
  beat: number;
  cols: number;
  lCol?: number;
  rCol?: number;
}

// ---- skeleton ----------------------------------------------------------------

// Joint indices. The first 20 match the classic rig (HAL/HAR wrists, FTL/FTR
// ankles, TAILL/TAILR twin-tail tips, AHOGE cowlick tip, SKIRT lagged hem
// anchor); WSTL/WSTR/COLLAR are 3D torso-plate corners added for the yaw read.
const PEL = 0,
  SH = 1,
  HEADB = 2,
  HEAD = 3,
  SHL = 4,
  SHR = 5,
  ELL = 6,
  HAL = 7,
  ELR = 8,
  HAR = 9,
  HIPL = 10,
  HIPR = 11,
  KNL = 12,
  FTL = 13,
  KNR = 14,
  FTR = 15,
  TAILL = 16,
  TAILR = 17,
  AHOGE = 18,
  SKIRT = 19,
  WSTL = 20,
  WSTR = 21,
  COLLAR = 22;
const JOINTS = 23;

// Color zones → per-variant 3-step lit/mid/shadow ramps.
const ZSKIN = 0,
  ZHAIR = 1,
  ZDRESS = 2,
  ZSKIRT = 3,
  ZTRIM = 4,
  ZEYE = 5,
  ZBLUSH = 6;

// Bone lengths / widths as fractions of BODY_H — cute anime proportions.
const L_TORSO = 0.3,
  L_NECK = 0.045,
  R_HEAD = 0.08,
  W_SHOULDER = 0.1,
  W_HIP = 0.082;
const L_UARM = 0.155,
  L_FARM = 0.125,
  L_THIGH = 0.25,
  L_SHIN = 0.24,
  L_SHOE = 0.025;

// Fixed key light (upper-left) for the flat facet shading.
const LX = -0.62;
const LY = -0.78;

// ---- 3D camera (weak perspective + a gentle downward tilt) --------------------
// Points live in (x right, y down, z toward viewer). Projection: shear y by
// z*TILT (the tilted ground plane — far is higher on screen), then scale about
// the horizon by F/(F−z) (weak perspective — near is bigger). The divide is
// clamped so it can never blow up or emit non-finite verts.

const HORIZON = FOOT_Y - 0.62 * BODY_H; // camera height ≈ her chest line
const PERSP_F = 3.4 * BODY_H;
const TILT = 0.22;
const Z_MAX = PERSP_F * 0.45;

// ---- footwork constants -------------------------------------------------------

/** Half stance width (fraction of BODY_H). */
const STANCE = 0.085;
/** Chart-less synthesized pattern, one row per beat (bit0=L,1=D,2=U,3=R;
 *  9 = L+R jump so the two-foot move shows up in attract mode too). */
const SYNTH: readonly number[] = [1, 2, 8, 4, 1, 8, 2, 9];

/** Player pool size (idle is implicit, not a player). */
const N_PLAYERS = 6;
/** Cross-fade envelope, in clip-phase units. */
const FADE_IN = 0.18;
const FADE_OUT = 0.25;

/** Vertex capacities (5 floats per vertex). Generous: a full body is ~400
 *  solid verts and ~1100 additive verts. */
const SOLID_CAP = 4096;
const ADD_CAP = 8192;

export class AttractDancer {
  private readonly pal: Palette;
  /** Flat [zone*3+shade]*3 → r,g,b in 0..1. */
  private readonly ramps = new Float32Array(7 * 3 * 3);
  private steps: readonly Step[] = [];

  // ---- reused output buffers ----
  private readonly solidBuf = new Float32Array(SOLID_CAP * 5);
  private readonly addBuf = new Float32Array(ADD_CAP * 5);
  private solidPos = 0; // float write cursor
  private addPos = 0;
  private readonly out = {
    solid: null as unknown as Float32Array<ArrayBuffer>,
    solidCount: 0,
    additive: null as unknown as Float32Array<ArrayBuffer>,
    additiveCount: 0,
  };

  // ---- scratch (owned, refilled per frame — never allocated in build) ----
  private readonly poly = new Float64Array(64); // current polygon, x,y pairs
  private np = 0; // point count in `poly`
  private readonly hem = new Float64Array(18); // skirt hem points (9)
  private readonly hemTop = new Float64Array(18); // skirt waistband points (9)
  private readonly jit = new Float32Array(24); // fixed burst jitter
  private readonly skel = new Float32Array(JOINTS * 2); // projected 2D joints
  private readonly skel3 = new Float64Array(JOINTS * 3); // 3D joints (x,y,z)
  private readonly jscale = new Float32Array(JOINTS); // per-joint perspective scale
  private readonly poseAcc = new Float32Array(N_CH); // blended pose
  private readonly poseTmp = new Float32Array(N_CH); // per-clip sample

  // ---- timing ----
  private lastTime = NaN;
  private prevBeat = NaN;

  // ---- clip scheduler (the animation state machine) ----
  private readonly plActive = new Uint8Array(N_PLAYERS);
  private readonly plClip = new Int32Array(N_PLAYERS);
  private readonly plMirror = new Uint8Array(N_PLAYERS);
  private readonly plCross = new Float32Array(N_PLAYERS); // crossover twist bias sign
  private readonly plStart = new Float64Array(N_PLAYERS);
  private readonly plDur = new Float64Array(N_PLAYERS); // beats, time-scaled

  // ---- chart cursors ----
  private hitIdx = -1; // last step whose beat has passed (burst accents)
  private schedIdx = -1; // last step whose clip has been scheduled
  private synthHit = -1e9; // chart-less mode bookkeeping
  private synthSched = -1e9;
  private lastFlourish = -1e9;
  private lastFoot = 1; // which foot stepped last (alternation for U/D)

  // ---- feet (3D plants + active swing ownership; 0 = left, 1 = right) ----
  private readonly plantX = new Float64Array(2); // committed plant (x, z)
  private readonly plantZ = new Float64Array(2);
  private readonly fromX = new Float64Array(2); // swing origin
  private readonly fromZ = new Float64Array(2);
  private readonly toX = new Float64Array(2); // swing target (the panel)
  private readonly toZ = new Float64Array(2);
  private readonly footOwner = new Int32Array(2); // player slot, -1 = locked
  private readonly footX = new Float64Array(2); // this frame's 3D ankle
  private readonly footYv = new Float64Array(2);
  private readonly footZ = new Float64Array(2);
  private readonly footSwg = new Float64Array(2); // per-frame owner samples
  private readonly footLift = new Float64Array(2);
  private readonly pt = new Float64Array(2); // panelTarget out (x, z)

  // ---- accents fired by note hits (bursts + glow only, not body pose) ----
  private hitBeat = -1e9;
  private hitCols = 0;

  // ---- hair / cloth secondary state (NaN = uninitialized, snaps to rest) ----
  private tailLX = NaN;
  private tailLY = NaN;
  private tailLVX = 0;
  private tailLVY = 0;
  private tailRX = NaN;
  private tailRY = NaN;
  private tailRVX = 0;
  private tailRVY = 0;
  private ahogeX = NaN;
  private ahogeY = NaN;
  private skirtX = NaN;
  private skirtY = NaN;
  private skirtVX = 0;
  private skirtVY = 0;

  // ---- per-frame paint parameters ----
  private bcx = CX; // body center the glow silhouette scales about
  private bcy = FOOT_Y - BODY_H * 0.6;
  private glowS = 1.05;
  private edgeR = 0;
  private edgeG = 0;
  private edgeB = 0;
  private softR = 0;
  private softG = 0;
  private softB = 0;
  private glowR = 0;
  private glowG = 0;
  private glowB = 0;
  private faceTurn = 0; // px offset of face features from head yaw

  // ---- torso frame, set by emitBody for at()/cap() ----
  private tfPx = 0;
  private tfPy = 0;
  private tfUx = 0;
  private tfUy = -1;
  private tfVx = 1;
  private tfVy = 0;
  private tfUl = 1;

  constructor(variant: number) {
    this.pal = PALETTES[((variant % PALETTES.length) + PALETTES.length) % PALETTES.length];

    // Dancer color zones: 3-step flat ramps toward near-black ink. Eyes/blush
    // are pre-composited over the lit face (the mesh is opaque — no alpha).
    const ink: RGB = [6, 7, 14];
    const skin = mix([255, 213, 190], this.pal.white, 0.2);
    const setRamp = (zone: number, shade: number, c: RGB): void => {
      const o = (zone * 3 + shade) * 3;
      this.ramps[o] = c[0] / 255;
      this.ramps[o + 1] = c[1] / 255;
      this.ramps[o + 2] = c[2] / 255;
    };
    const ramp = (zone: number, c: RGB, sh: number, md: number, lt: number): void => {
      setRamp(zone, 0, mix(ink, c, sh));
      setRamp(zone, 1, mix(ink, c, md));
      setRamp(zone, 2, mix(ink, c, lt));
    };
    // Ramps run hot on purpose: she's drawn behind the note-field dim
    // (fragment multiplies by ~0.75), so rich saturated fills are what keep
    // her reading as a COLORED character instead of a neon-rimmed silhouette.
    ramp(ZSKIN, skin, 0.45, 0.72, 0.98);
    ramp(ZHAIR, this.pal.accentA, 0.4, 0.72, 1);
    ramp(ZDRESS, this.pal.accentA, 0.26, 0.46, 0.66);
    ramp(ZSKIRT, this.pal.accentB, 0.38, 0.68, 0.98);
    ramp(ZTRIM, this.pal.accentC, 0.34, 0.58, 0.85);
    const faceLit = mix(ink, skin, 0.98);
    const eye = mix(faceLit, mix(ink, this.pal.accentA, 0.2), 0.9);
    const blush = mix(faceLit, mix(this.pal.accentA, [255, 118, 148], 0.5), 0.3);
    ramp(ZEYE, eye, 1, 1, 1);
    ramp(ZBLUSH, blush, 1, 1, 1);

    // Deterministic burst jitter (no Math.random so replays are stable).
    for (let i = 0; i < this.jit.length; i++) {
      const h = Math.sin((i + 1) * 12.9898) * 43758.5453;
      this.jit[i] = h - Math.floor(h) - 0.5;
    }

    // Feet start locked in a neutral stance on the floor plane.
    for (let f = 0; f < 2; f++) {
      const x = CX + (f === 0 ? -1 : 1) * STANCE * BODY_H;
      this.plantX[f] = x;
      this.plantZ[f] = 0;
      this.fromX[f] = x;
      this.fromZ[f] = 0;
      this.toX[f] = x;
      this.toZ[f] = 0;
      this.footOwner[f] = -1;
      this.footX[f] = x;
      this.footYv[f] = FOOT_Y - L_SHOE * BODY_H;
      this.footZ[f] = 0;
    }

    this.out.solid = this.solidBuf;
    this.out.additive = this.addBuf;
  }

  /** The chart timeline (sorted ascending by beat). */
  setSteps(steps: readonly Step[]): void {
    this.steps = [...steps].sort((a, b) => a.beat - b.beat);
    this.rewind();
  }

  private rewind(): void {
    this.hitIdx = -1;
    this.schedIdx = -1;
    this.synthHit = -1e9;
    this.synthSched = -1e9;
    this.lastFlourish = -1e9;
    this.hitBeat = -1e9;
    this.plActive.fill(0);
    // Lock the feet where they stand (plants stay finite and committed).
    for (let f = 0; f < 2; f++) {
      if (!Number.isFinite(this.plantX[f]) || !Number.isFinite(this.plantZ[f])) {
        this.plantX[f] = CX + (f === 0 ? -1 : 1) * STANCE * BODY_H;
        this.plantZ[f] = 0;
      }
      this.footOwner[f] = -1;
      this.toX[f] = this.plantX[f];
      this.toZ[f] = this.plantZ[f];
    }
  }

  /** Build this frame's mesh into REUSED internal buffers; returns current
   *  vertex counts. Coordinates are in a fixed 960x540 design space, origin
   *  top-left, y DOWN. Each vertex is 5 floats: x, y, r, g, b (0..1).
   *  Triangle list. */
  build(
    time: number,
    beat: number,
  ): {
    solid: Float32Array<ArrayBuffer>;
    solidCount: number;
    additive: Float32Array<ArrayBuffer>;
    additiveCount: number;
  } {
    if (!Number.isFinite(time)) time = 0;
    let dt = time - this.lastTime;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, 0.1);
    this.lastTime = time;
    const s30 = Math.min(dt * 30, 2.5); // secondary-spring step vs 30fps

    const valid = Number.isFinite(beat) && beat >= 0;
    const chart = valid && this.steps.length > 0;
    if (valid && Number.isFinite(this.prevBeat) && beat < this.prevBeat - 0.5) this.rewind();
    this.prevBeat = valid ? beat : NaN;

    const B = BODY_H;
    const phase = valid ? beat - Math.floor(beat) : (time * 1.4) % 1;
    const kick = valid ? Math.exp(-6 * phase) : 0;

    // ---- 1. the scheduler: fire hit accents, schedule upcoming clips -------
    if (chart) this.scheduleChart(beat);
    else if (valid) this.scheduleSynth(beat);
    // Flourish in long gaps (chart or synth), aligned to the groove.
    if (valid && beat - this.lastFlourish >= 6) {
      const nextGap = this.nextNoteGap(beat, chart);
      if (nextGap > 3.2 && !this.anyStepActive()) {
        this.spawnPlayer(CLIP_FLOURISH, false, 0, beat, CLIPS[CLIP_FLOURISH].beats);
        this.lastFlourish = beat;
      }
    }

    // ---- 2. sample + cross-fade blend the active clips ----------------------
    // Pose = normalized Σ wᵢ·clipᵢ(phaseᵢ); the idle groove owns the remaining
    // weight, so she always settles back into the groove between notes.
    const acc = this.poseAcc;
    const tmp = this.poseTmp;
    acc.fill(0);
    this.footSwg[0] = -1; // -1 ⇒ no owner sampled this frame (foot locked)
    this.footSwg[1] = -1;
    this.footLift[0] = 0;
    this.footLift[1] = 0;
    let wsum = 0;
    for (let s = 0; s < N_PLAYERS; s++) {
      if (!this.plActive[s]) continue;
      const clip = CLIPS[this.plClip[s]];
      const ph = valid ? (beat - this.plStart[s]) / this.plDur[s] : 1.01;
      if (!(ph < 1.0005)) {
        this.freeSlot(s);
        continue;
      }
      if (ph < 0) continue; // not started yet (scheduled ahead)
      const w = smooth01(ph / FADE_IN) * (1 - smooth01((ph - (1 - FADE_OUT)) / FADE_OUT));
      const ownsFoot = this.footOwner[0] === s || this.footOwner[1] === s;
      if (!(w > 1e-4) && !ownsFoot) continue;
      sampleClip(clip, ph, tmp, this.plMirror[s] !== 0);
      // Crossover additive layer: the mirrored clip already carries the
      // correct support-side weight for the stepping foot; on top of it the
      // body twists and the head looks toward the crossed panel.
      const cross = this.plCross[s];
      if (cross !== 0) {
        tmp[CH_HYAW] = -tmp[CH_HYAW];
        tmp[CH_HROLL] = -tmp[CH_HROLL];
        tmp[CH_TWIST] += cross * 0.3;
        tmp[CH_YAW] += cross * 0.22;
      }
      if (w > 1e-4) {
        for (let ch = CH_YAW; ch <= CH_RLOF; ch++) acc[ch] += w * tmp[ch];
        wsum += w;
      }
      // Foot channels come from the OWNING player only (weight 1, sampled
      // even while its cross-fade weight is ~0): the swing is a deterministic
      // contract with the plant, not a blend — this is the foot-lock
      // guarantee. Past the impact key the land is forced exact.
      for (let f = 0; f < 2; f++) {
        if (this.footOwner[f] !== s) continue;
        const landed = ph >= clip.impact;
        const swg = tmp[f === 0 ? CH_SWGL : CH_SWGR];
        const lift = tmp[f === 0 ? CH_LIFTL : CH_LIFTR];
        this.footSwg[f] = landed ? 1 : clamp(swg, 0, 1);
        this.footLift[f] = landed ? 0 : Math.max(0, lift);
      }
    }
    {
      const idleW = Math.max(0, 1 - wsum);
      if (idleW > 1e-4) {
        const ib = valid ? beat : time * 1.05; // lead-in: slow internal pulse
        sampleClip(IDLE, (ib % 2) / 2, tmp, false);
        for (let ch = CH_YAW; ch <= CH_RLOF; ch++) acc[ch] += idleW * tmp[ch];
        wsum += idleW;
      }
      const inv = wsum > 1e-6 ? 1 / wsum : 1;
      for (let ch = CH_YAW; ch <= CH_RLOF; ch++) {
        const v = acc[ch] * inv;
        acc[ch] = Number.isFinite(v) ? v : REST[ch];
      }
    }

    // ---- 3. foot kinematics: locked plants + owned swings -------------------
    for (let f = 0; f < 2; f++) {
      let x: number;
      let z: number;
      let lift = 0;
      const s = this.footSwg[f];
      if (this.footOwner[f] >= 0 && s >= 0) {
        x = this.fromX[f] + (this.toX[f] - this.fromX[f]) * s;
        z = this.fromZ[f] + (this.toZ[f] - this.fromZ[f]) * s;
        lift = this.footLift[f] * B;
      } else {
        x = this.plantX[f];
        z = this.plantZ[f];
      }
      if (!valid) {
        // Lead-in: ease plants back to the neutral stance (feet only).
        const k = 1 - Math.exp(-dt * 4);
        const sx0 = CX + (f === 0 ? -1 : 1) * STANCE * B;
        this.plantX[f] += (sx0 - this.plantX[f]) * k;
        this.plantZ[f] += (0 - this.plantZ[f]) * k;
        x = this.plantX[f];
        z = this.plantZ[f];
        lift = 0;
      }
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(lift)) {
        x = CX + (f === 0 ? -1 : 1) * STANCE * B;
        z = 0;
        lift = 0;
      }
      this.footX[f] = x;
      this.footZ[f] = z;
      this.footYv[f] = FOOT_Y - L_SHOE * B - lift;
    }

    // ---- 4. solve the 3D skeleton (FK + two-bone leg IK), project ----------
    this.solve3D(time, s30);

    // ---- 5. paint params -----------------------------------------------------
    // Neon is an accent, not the read: the colored solid fills lead, the
    // additive edges just rim the silhouette (they pulse a little on the beat).
    const pa = this.pal.accentA;
    const eI = (0.28 + 0.2 * kick) / 255;
    this.edgeR = pa[0] * eI;
    this.edgeG = pa[1] * eI;
    this.edgeB = pa[2] * eI;
    const sI = 0.09 / 255;
    this.softR = pa[0] * sI;
    this.softG = pa[1] * sI;
    this.softB = pa[2] * sI;
    const gI = (0.04 + 0.06 * kick) / 255;
    this.glowR = pa[0] * gI;
    this.glowG = pa[1] * gI;
    this.glowB = pa[2] * gI;
    this.glowS = 1.045 + 0.02 * kick;

    // ---- 6. emit geometry ---------------------------------------------------
    this.solidPos = 0;
    this.addPos = 0;
    this.emitBody();
    const bd = beat - this.hitBeat;
    const burstLife = valid && bd >= 0 && bd < 0.22 && raisesHand(this.hitCols) ? 1 - bd / 0.22 : 0;
    if (burstLife > 0) this.emitBurst(burstLife, bitCount(this.hitCols) >= 2);

    this.out.solidCount = (this.solidPos / 5) | 0;
    this.out.additiveCount = (this.addPos / 5) | 0;
    return this.out;
  }

  // ---- scheduler internals ----------------------------------------------------

  private anyStepActive(): boolean {
    for (let s = 0; s < N_PLAYERS; s++) {
      if (this.plActive[s] && this.plClip[s] !== CLIP_FLOURISH) return true;
    }
    return false;
  }

  private nextNoteGap(beat: number, chart: boolean): number {
    if (chart) {
      const i = this.schedIdx + 1;
      return i < this.steps.length ? this.steps[i].beat - beat : 1e9;
    }
    return this.synthSched > beat ? this.synthSched - beat : Math.floor(beat) + 1 - beat;
  }

  /** Advance the chart cursors: burst accents on rows that just hit, and
   *  clip scheduling so each move's IMPACT keyframe lands on its note beat. */
  private scheduleChart(beat: number): void {
    const steps = this.steps;
    let guard = 0;
    while (this.hitIdx + 1 < steps.length && steps[this.hitIdx + 1].beat <= beat) {
      this.hitIdx++;
      if (++guard <= 32) {
        this.hitBeat = steps[this.hitIdx].beat;
        this.hitCols = steps[this.hitIdx].cols;
      }
    }
    guard = 0;
    while (this.schedIdx + 1 < steps.length && guard++ < 8) {
      const i = this.schedIdx + 1;
      const st = steps[i];
      if (st.beat < beat - 0.1) {
        this.schedIdx = i; // long past (seek/jump) — skip silently
        continue;
      }
      const gap = i > 0 ? st.beat - steps[i - 1].beat : 2;
      if (st.beat - beat > this.windupFor(st, gap)) break; // not yet in window
      this.spawnStep(st, gap);
      this.schedIdx = i;
    }
  }

  /** Chart-less attract mode: synthesize the SYNTH pattern one row per beat. */
  private scheduleSynth(beat: number): void {
    const ib = Math.floor(beat);
    if (ib > this.synthHit) {
      this.synthHit = ib;
      this.hitBeat = ib;
      this.hitCols = SYNTH[((ib % 8) + 8) % 8];
    }
    const nb = ib + 1;
    if (this.synthSched < nb) {
      const cols = SYNTH[((nb % 8) + 8) % 8];
      const st: Step = { beat: nb, cols };
      if (nb - beat <= this.windupFor(st, 1)) {
        this.synthSched = nb;
        this.spawnStep(st, 1);
      }
    }
  }

  /** Beats of wind-up (clip start → impact) a row's clip needs, after the
   *  time-scaling that compresses moves to fit dense streams. */
  private windupFor(st: Step, gap: number): number {
    const jump = this.isJump(st);
    const clip = CLIPS[jump ? CLIP_JUMP : PANEL_CLIP[this.panelOf(st)]];
    const nominal = clip.impact * clip.beats;
    const ts = clamp((gap * 0.92) / nominal, 0.3, 1);
    return nominal * ts;
  }

  private isJump(st: Step): boolean {
    const lp = st.lCol ?? -1;
    const rp = st.rCol ?? -1;
    if (lp >= 0 && lp <= 3 && rp >= 0 && rp <= 3) return true; // both feet step
    if (st.lCol !== undefined || st.rCol !== undefined) return false; // parity: single foot
    return bitCount(st.cols) >= 2;
  }

  /** The panel a single-foot row steps to (parity-first, else heuristic). */
  private panelOf(st: Step): number {
    const lp = st.lCol ?? -1;
    const rp = st.rCol ?? -1;
    if (lp >= 0 && lp <= 3) return lp;
    if (rp >= 0 && rp <= 3) return rp;
    if (st.cols & 1) return 0;
    if (st.cols & 8) return 3;
    return st.cols & 4 ? 2 : 1;
  }

  /** Schedule the clip for one note row. JUMPS are first-class: any row where
   *  both feet step (parity lCol AND rCol, or a 2+ column mask) fires the
   *  JUMP clip owning BOTH feet, each foot targeted at its own panel. */
  private spawnStep(st: Step, gap: number): void {
    const lp = st.lCol !== undefined && Number.isFinite(st.lCol) ? Math.trunc(st.lCol) : -1;
    const rp = st.rCol !== undefined && Number.isFinite(st.rCol) ? Math.trunc(st.rCol) : -1;
    const lSteps = lp >= 0 && lp <= 3;
    const rSteps = rp >= 0 && rp <= 3;

    if (this.isJump(st)) {
      // Two-foot jump. Panels from parity when present; otherwise split the
      // lit columns leftmost→left foot, rightmost→right foot.
      let jl = lSteps ? lp : -1;
      let jr = rSteps ? rp : -1;
      if (jl < 0 || jr < 0) {
        jl = -1;
        jr = -1;
        for (let p = 0; p < 4; p++) {
          if (st.cols & (1 << p)) {
            if (jl < 0) jl = p;
            jr = p;
          }
        }
        if (jl < 0) return; // empty row — nothing to do
      }
      const clip = CLIPS[CLIP_JUMP];
      const ts = clamp((gap * 0.92) / (clip.impact * clip.beats), 0.3, 1);
      const dur = clip.beats * ts;
      const slot = this.spawnPlayer(CLIP_JUMP, false, 0, st.beat - clip.impact * dur, dur);
      this.assignFoot(0, jl, slot);
      this.assignFoot(1, jr, slot);
      this.lastFoot = 1;
      return;
    }

    // Single-foot step: parity decides the foot; the heuristic falls back to
    // L→left, R→right, U/D alternating off the last stepping foot.
    let foot: number;
    let panel: number;
    if (lSteps || rSteps) {
      foot = lSteps ? 0 : 1;
      panel = lSteps ? lp : rp;
    } else {
      panel = this.panelOf(st);
      if (panel === 0) foot = 0;
      else if (panel === 3) foot = 1;
      else foot = 1 - this.lastFoot;
    }
    const clipIdx = PANEL_CLIP[panel];
    const clip = CLIPS[clipIdx];
    const mirrored = foot !== CLIP_FOOT[clipIdx];
    // Crossover: the foot targets the opposite side's panel — flag the
    // additive cross layer (twist through, weight to the true support).
    const cross = (foot === 0 && panel === 3) || (foot === 1 && panel === 0);
    const ts = clamp((gap * 0.92) / (clip.impact * clip.beats), 0.3, 1);
    const dur = clip.beats * ts;
    const slot = this.spawnPlayer(
      clipIdx,
      mirrored,
      cross ? (foot === 0 ? 1 : -1) : 0,
      st.beat - clip.impact * dur,
      dur,
    );
    this.assignFoot(foot, panel, slot);
    this.lastFoot = foot;
  }

  /** Claim a player slot (recycling the nearest-done one if the pool is full)
   *  and start the clip on it. Returns the slot index. */
  private spawnPlayer(
    clipIdx: number,
    mirrored: boolean,
    cross: number,
    startBeat: number,
    durBeats: number,
  ): number {
    let slot = -1;
    let bestEnd = Infinity;
    for (let s = 0; s < N_PLAYERS; s++) {
      if (!this.plActive[s]) {
        slot = s;
        break;
      }
    }
    if (slot < 0) {
      for (let s = 0; s < N_PLAYERS; s++) {
        const end = this.plStart[s] + this.plDur[s];
        if (end < bestEnd) {
          bestEnd = end;
          slot = s;
        }
      }
      this.freeSlot(slot); // commits any feet the evicted player owned
    }
    this.plActive[slot] = 1;
    this.plClip[slot] = clipIdx;
    this.plMirror[slot] = mirrored ? 1 : 0;
    this.plCross[slot] = cross;
    this.plStart[slot] = startBeat;
    this.plDur[slot] = Math.max(durBeats, 1e-3);
    return slot;
  }

  /** Hand a foot's swing to a player: origin = wherever the foot is NOW
   *  (mid-swing supersede included), target = its panel spot on the floor. */
  private assignFoot(foot: number, panel: number, slot: number): void {
    this.panelTarget(panel, foot);
    let x0 = this.footX[foot];
    let z0 = this.footZ[foot];
    if (!Number.isFinite(x0) || !Number.isFinite(z0)) {
      x0 = this.pt[0];
      z0 = this.pt[1];
    }
    this.fromX[foot] = x0;
    this.fromZ[foot] = z0;
    this.toX[foot] = this.pt[0];
    this.toZ[foot] = this.pt[1];
    this.footOwner[foot] = slot;
  }

  /** Retire a player; feet it still owns commit their plant at the target
   *  (the landed panel) and lock there. */
  private freeSlot(slot: number): void {
    for (let f = 0; f < 2; f++) {
      if (this.footOwner[f] === slot) {
        this.plantX[f] = this.toX[f];
        this.plantZ[f] = this.toZ[f];
        this.footOwner[f] = -1;
      }
    }
    this.plActive[slot] = 0;
  }

  /** 3D floor spot for a panel (0=L,1=D,2=U,3=R), per foot. The pad lies flat
   *  in front of her: L/R straddle wide at z=0, Up is the far panel (z away
   *  from camera — projects higher and smaller), Down is the near panel
   *  (z toward camera — projects lower and bigger). Out: pt = [x, z]. */
  private panelTarget(panel: number, foot: number): void {
    const B = BODY_H;
    const s = foot === 0 ? -1 : 1;
    if (panel === 0) {
      this.pt[0] = CX - 0.245 * B;
      this.pt[1] = 0;
    } else if (panel === 3) {
      this.pt[0] = CX + 0.245 * B;
      this.pt[1] = 0;
    } else if (panel === 2) {
      this.pt[0] = CX + s * 0.055 * B;
      this.pt[1] = -0.28 * B;
    } else {
      this.pt[0] = CX + s * 0.1 * B;
      this.pt[1] = 0.2 * B;
    }
  }

  // ---- 3D skeleton solve --------------------------------------------------------

  private readonly sp4 = new Float64Array(4); // springTail out: px, py, vx, vy

  /** FK the torso/head/arms from the blended pose channels, two-bone-IK the
   *  legs onto the animated ankle targets, project everything through the
   *  weak-perspective camera, then run the secondary hair/cloth springs on
   *  the projected joints. */
  private solve3D(time: number, s30: number): void {
    const B = BODY_H;
    const ch = this.poseAcc;
    const s3 = this.skel3;

    // Clamped channels (a blend of sane clips is sane, but never trust math).
    const yaw = clamp(ch[CH_YAW], -0.7, 0.7);
    const lean = clamp(ch[CH_LEAN], -0.5, 0.5);
    const pitch = clamp(ch[CH_PITCH], -0.5, 0.6);
    const twist = clamp(ch[CH_TWIST], -0.8, 0.8);
    const side = clamp(ch[CH_SIDE], -0.08, 0.08);
    const hyaw = clamp(ch[CH_HYAW], -0.8, 0.8);
    const hpit = clamp(ch[CH_HPIT], -0.6, 0.6);
    const hroll = clamp(ch[CH_HROLL], -0.6, 0.6);
    const crouch = clamp(ch[CH_CROUCH], -0.14, 0.2);
    const sway = clamp(ch[CH_SWAY], -0.2, 0.2);
    const pelvz = clamp(ch[CH_PELVZ], -0.12, 0.12);
    const list = clamp(ch[CH_LIST], -0.08, 0.08);

    // Pelvis: authored sway + a pelvis-adjustment bias toward the feet
    // midpoint (the standard foot-IK pelvis correction — the clip doesn't
    // know which panels the feet actually landed on, the rig does).
    const midFx = (this.footX[0] + this.footX[1]) * 0.5 - CX;
    const midFz = (this.footZ[0] + this.footZ[1]) * 0.5;
    const pelX = CX + sway * B + clamp(midFx * 0.55, -0.22 * B, 0.22 * B);
    const pelZ = pelvz * B + clamp(midFz * 0.45, -0.15 * B, 0.15 * B);
    const pelY = FOOT_Y - (L_THIGH + L_SHIN + L_SHOE) * B * 0.985 + crouch * B;
    s3[PEL * 3] = pelX;
    s3[PEL * 3 + 1] = pelY;
    s3[PEL * 3 + 2] = pelZ;

    // Body axes. Pelvis frame from yaw; shoulder frame adds the twist.
    const latX = Math.cos(yaw);
    const latZ = -Math.sin(yaw);
    const fwdX = Math.sin(yaw);
    const fwdZ = Math.cos(yaw);
    const yawS = clamp(yaw + twist, -1.1, 1.1);
    const latSX = Math.cos(yawS);
    const latSZ = -Math.sin(yawS);
    const fwdSX = Math.sin(yawS);
    const fwdSZ = Math.cos(yawS);
    // Torso up vector: straight up, rolled by lean toward lateral, pitched
    // toward the viewer-forward.
    const sinL = Math.sin(lean);
    const cosL = Math.cos(lean);
    const sinP = Math.sin(pitch);
    const cosP = Math.cos(pitch);
    const ux = latX * sinL * cosP + fwdX * sinP;
    const uy = -cosL * cosP;
    const uz = latZ * sinL * cosP + fwdZ * sinP;

    // Chest (= shoulder center) with the ribcage side-shift (contrapposto).
    const shX = pelX + ux * L_TORSO * B + latSX * side * B;
    const shY = pelY + uy * L_TORSO * B;
    const shZ = pelZ + uz * L_TORSO * B + latSZ * side * B;
    s3[SH * 3] = shX;
    s3[SH * 3 + 1] = shY;
    s3[SH * 3 + 2] = shZ;
    s3[COLLAR * 3] = shX + ux * 0.06 * B;
    s3[COLLAR * 3 + 1] = shY + uy * 0.06 * B;
    s3[COLLAR * 3 + 2] = shZ + uz * 0.06 * B;

    // Neck + head (head roll shifts the skull laterally, pitch nods it).
    const nbX = shX + ux * L_NECK * B;
    const nbY = shY + uy * L_NECK * B;
    const nbZ = shZ + uz * L_NECK * B;
    s3[HEADB * 3] = nbX;
    s3[HEADB * 3 + 1] = nbY;
    s3[HEADB * 3 + 2] = nbZ;
    const r = R_HEAD * B;
    const nod = Math.sin(hpit) * r * 0.4;
    const hX = nbX + ux * r * 0.9 + latSX * Math.sin(hroll) * r + fwdSX * nod;
    const hY = nbY + uy * r * 0.9 + Math.sin(hpit) * r * 0.25;
    const hZ = nbZ + uz * r * 0.9 + latSZ * Math.sin(hroll) * r + fwdSZ * nod;
    s3[HEAD * 3] = hX;
    s3[HEAD * 3 + 1] = hY;
    s3[HEAD * 3 + 2] = hZ;
    this.faceTurn = clamp(Math.sin(hyaw + yawS * 0.35) * r * 0.5, -r, r);

    // Shoulder sockets: on the twisted shoulder line, counter-tilted against
    // the pelvic list (weight-bearing hip up ⇒ same-side shoulder down).
    const shTilt = list * B * 0.55;
    s3[SHL * 3] = shX - latSX * W_SHOULDER * B;
    s3[SHL * 3 + 1] = shY - shTilt;
    s3[SHL * 3 + 2] = shZ - latSZ * W_SHOULDER * B;
    s3[SHR * 3] = shX + latSX * W_SHOULDER * B;
    s3[SHR * 3 + 1] = shY + shTilt;
    s3[SHR * 3 + 2] = shZ + latSZ * W_SHOULDER * B;

    // Waist corners (torso-plate geometry rides the blended frame so body
    // yaw foreshortens the plates through z).
    const waistW = 0.05 * B;
    const latWX = (latX + latSX) * 0.5;
    const latWZ = (latZ + latSZ) * 0.5;
    const wcX = pelX + ux * L_TORSO * B * 0.42 + latSX * side * B * 0.42;
    const wcY = pelY + uy * L_TORSO * B * 0.42;
    const wcZ = pelZ + uz * L_TORSO * B * 0.42 + latSZ * side * B * 0.42;
    s3[WSTL * 3] = wcX - latWX * waistW;
    s3[WSTL * 3 + 1] = wcY;
    s3[WSTL * 3 + 2] = wcZ - latWZ * waistW;
    s3[WSTR * 3] = wcX + latWX * waistW;
    s3[WSTR * 3 + 1] = wcY;
    s3[WSTR * 3 + 2] = wcZ + latWZ * waistW;

    // Hips: pelvis frame, listed (support hip hikes).
    s3[HIPL * 3] = pelX - latX * W_HIP * B;
    s3[HIPL * 3 + 1] = pelY + list * B;
    s3[HIPL * 3 + 2] = pelZ - latZ * W_HIP * B;
    s3[HIPR * 3] = pelX + latX * W_HIP * B;
    s3[HIPR * 3 + 1] = pelY - list * B;
    s3[HIPR * 3 + 2] = pelZ + latZ * W_HIP * B;

    // Arms: FK. Upper arm = down rotated outward by abduction in the coronal
    // plane, then toward the viewer by the fwd channel; the forearm continues
    // the arc (elbow bend) with its own forward component.
    for (let f = 0; f < 2; f++) {
      const sgn = f === 0 ? -1 : 1;
      const abd = clamp(ch[f === 0 ? CH_LABD : CH_RABD], -0.6, 3.3);
      const fw = clamp(ch[f === 0 ? CH_LFWD : CH_RFWD], -1.2, 1.2);
      const elb = clamp(ch[f === 0 ? CH_LELB : CH_RELB], -0.5, 2.6);
      const lof = clamp(ch[f === 0 ? CH_LLOF : CH_RLOF], -1.2, 1.6);
      const soI = f === 0 ? SHL : SHR;
      const elI = f === 0 ? ELL : ELR;
      const haI = f === 0 ? HAL : HAR;
      const outX = sgn * latSX;
      const outZ = sgn * latSZ;
      const sA = Math.sin(abd);
      const cA = Math.cos(abd);
      const sF = Math.sin(fw);
      const cF = Math.cos(fw);
      // d1 = (down*cosA + out*sinA)*cosF + fwd*sinF   (down = +y)
      const d1x = outX * sA * cF + fwdSX * sF;
      const d1y = cA * cF;
      const d1z = outZ * sA * cF + fwdSZ * sF;
      const eX = s3[soI * 3] + d1x * L_UARM * B;
      const eY = s3[soI * 3 + 1] + d1y * L_UARM * B;
      const eZ = s3[soI * 3 + 2] + d1z * L_UARM * B;
      s3[elI * 3] = eX;
      s3[elI * 3 + 1] = eY;
      s3[elI * 3 + 2] = eZ;
      const a2 = abd + elb;
      const f2 = clamp(fw + lof, -1.35, 1.45);
      const sA2 = Math.sin(a2);
      const cA2 = Math.cos(a2);
      const sF2 = Math.sin(f2);
      const cF2 = Math.cos(f2);
      s3[haI * 3] = eX + (outX * sA2 * cF2 + fwdSX * sF2) * L_FARM * B;
      s3[haI * 3 + 1] = eY + cA2 * cF2 * L_FARM * B;
      s3[haI * 3 + 2] = eZ + (outZ * sA2 * cF2 + fwdSZ * sF2) * L_FARM * B;
    }

    // Legs: analytic two-bone IK from each hip to its animated ankle. The
    // knee pole aims forward (toward the viewer) and slightly outward, so
    // knees bend naturally and never flip sides — crossovers included.
    const l1 = L_THIGH * B;
    const l2 = L_SHIN * B;
    for (let f = 0; f < 2; f++) {
      const sgn = f === 0 ? -1 : 1;
      const hipI = f === 0 ? HIPL : HIPR;
      const knI = f === 0 ? KNL : KNR;
      const ftI = f === 0 ? FTL : FTR;
      const hx = s3[hipI * 3];
      const hy = s3[hipI * 3 + 1];
      const hz = s3[hipI * 3 + 2];
      let dx = this.footX[f] - hx;
      let dy = this.footYv[f] - hy;
      let dz = this.footZ[f] - hz;
      let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(d > 1e-4)) {
        dx = 0;
        dy = 1;
        dz = 0;
        d = 1;
      }
      const nx = dx / d;
      const ny = dy / d;
      const nz = dz / d;
      // Soft knees: never lock the chain fully straight.
      const dc = clamp(d, Math.abs(l1 - l2) + 1, (l1 + l2) * 0.985);
      const ca = clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1);
      const sa = Math.sqrt(Math.max(0, 1 - ca * ca));
      // Pole = body-forward + a little outward, orthogonalized to the chain.
      let px = fwdX + sgn * latX * 0.3;
      let py = 0;
      let pz = fwdZ + sgn * latZ * 0.3;
      const dot = px * nx + py * ny + pz * nz;
      px -= nx * dot;
      py -= ny * dot;
      pz -= nz * dot;
      let pl = Math.sqrt(px * px + py * py + pz * pz);
      if (!(pl > 1e-4)) {
        px = sgn * latX;
        py = 0;
        pz = sgn * latZ;
        pl = 1;
      }
      px /= pl;
      py /= pl;
      pz /= pl;
      s3[knI * 3] = hx + nx * (l1 * ca) + px * (l1 * sa);
      s3[knI * 3 + 1] = hy + ny * (l1 * ca) + py * (l1 * sa);
      s3[knI * 3 + 2] = hz + nz * (l1 * ca) + pz * (l1 * sa);
      // Ankle re-derived on the (possibly reach-clamped) chain.
      s3[ftI * 3] = hx + nx * dc;
      s3[ftI * 3 + 1] = hy + ny * dc;
      s3[ftI * 3 + 2] = hz + nz * dc;
    }

    // ---- project the body joints through the tilted weak-perspective camera.
    const s2 = this.skel;
    for (let j = 0; j < JOINTS; j++) {
      if (j === TAILL || j === TAILR || j === AHOGE || j === SKIRT) continue;
      const x3 = s3[j * 3];
      const y3 = s3[j * 3 + 1];
      let z3 = s3[j * 3 + 2];
      if (!Number.isFinite(x3) || !Number.isFinite(y3) || !Number.isFinite(z3)) {
        s2[j * 2] = CX;
        s2[j * 2 + 1] = HORIZON;
        this.jscale[j] = 1;
        continue;
      }
      z3 = clamp(z3, -Z_MAX, Z_MAX);
      const s = PERSP_F / (PERSP_F - z3); // denominator ≥ 0.55·F, never 0
      const yy = y3 + z3 * TILT;
      s2[j * 2] = CX + (x3 - CX) * s;
      s2[j * 2 + 1] = HORIZON + (yy - HORIZON) * s;
      this.jscale[j] = s;
    }
    this.jscale[TAILL] = this.jscale[HEAD];
    this.jscale[TAILR] = this.jscale[HEAD];
    this.jscale[AHOGE] = this.jscale[HEAD];
    this.jscale[SKIRT] = this.jscale[PEL];

    // ---- secondary motion: twin-tails, ahoge, skirt (damped springs on the
    // projected joints — standard cloth/hair smoothing, body stays clip-driven).
    const hx2 = s2[HEAD * 2];
    const hy2 = s2[HEAD * 2 + 1];
    const rp = r * this.jscale[HEAD];
    const swing = this.faceTurn * 2.4;
    this.springTail(
      -1,
      this.tailLX,
      this.tailLY,
      this.tailLVX,
      this.tailLVY,
      hx2,
      hy2,
      rp,
      swing,
      s30,
    );
    this.tailLX = this.sp4[0];
    this.tailLY = this.sp4[1];
    this.tailLVX = this.sp4[2];
    this.tailLVY = this.sp4[3];
    s2[TAILL * 2] = this.tailLX;
    s2[TAILL * 2 + 1] = this.tailLY;
    this.springTail(
      1,
      this.tailRX,
      this.tailRY,
      this.tailRVX,
      this.tailRVY,
      hx2,
      hy2,
      rp,
      swing,
      s30,
    );
    this.tailRX = this.sp4[0];
    this.tailRY = this.sp4[1];
    this.tailRVX = this.sp4[2];
    this.tailRVY = this.sp4[3];
    s2[TAILR * 2] = this.tailRX;
    s2[TAILR * 2 + 1] = this.tailRY;

    // Ahoge tip: a lagged point above the crown with a slow idle wobble.
    const ahRX = hx2 + this.faceTurn * 0.6 + Math.sin(time * 2.1) * 0.012 * B;
    const ahRY = hy2 - rp * 1.9 + Math.cos(time * 1.7) * 0.005 * B;
    if (!Number.isFinite(this.ahogeX) || !Number.isFinite(this.ahogeY)) {
      this.ahogeX = ahRX;
      this.ahogeY = ahRY;
    }
    this.ahogeX += (ahRX - this.ahogeX) * (1 - Math.pow(0.78, s30));
    this.ahogeY += (ahRY - this.ahogeY) * (1 - Math.pow(0.7, s30));
    s2[AHOGE * 2] = this.ahogeX;
    s2[AHOGE * 2 + 1] = this.ahogeY;

    // Skirt anchor: a damped spring chasing a point under the pelvis — the
    // hem hangs off it, so the cloth lags each hip move and settles without
    // ever flying away (deflection clamped).
    const plx = s2[PEL * 2];
    const ply = s2[PEL * 2 + 1];
    const skRX = plx;
    const skRY = ply + 0.1 * B;
    if (
      !Number.isFinite(this.skirtX) ||
      !Number.isFinite(this.skirtY) ||
      !Number.isFinite(this.skirtVX) ||
      !Number.isFinite(this.skirtVY)
    ) {
      this.skirtX = skRX;
      this.skirtY = skRY;
      this.skirtVX = 0;
      this.skirtVY = 0;
    }
    const skD = Math.pow(0.74, s30);
    this.skirtVX = (this.skirtVX + (skRX - this.skirtX) * 0.09 * s30) * skD;
    this.skirtVY = (this.skirtVY + (skRY - this.skirtY) * 0.13 * s30) * skD;
    this.skirtX += this.skirtVX * s30;
    this.skirtY += this.skirtVY * s30;
    this.skirtX = clamp(this.skirtX, skRX - 0.09 * B, skRX + 0.09 * B);
    this.skirtY = clamp(this.skirtY, skRY - 0.05 * B, skRY + 0.06 * B);
    s2[SKIRT * 2] = this.skirtX;
    s2[SKIRT * 2 + 1] = this.skirtY;

    // Center the rim-glow silhouette scaling on the torso.
    this.bcx = plx;
    this.bcy = (ply + s2[SH * 2 + 1]) * 0.5;
  }

  /** Near-critically-damped spring for one twin-tail tip (result in sp4). */
  private springTail(
    side: number,
    px: number,
    py: number,
    vx: number,
    vy: number,
    hx: number,
    hy: number,
    r: number,
    swing: number,
    s30: number,
  ): void {
    const B = BODY_H;
    const o = this.sp4;
    const bx = hx + side * r * 0.85;
    const by = hy - r * 0.1;
    const rx = bx + side * 0.09 * B - swing;
    const ry = by + 0.4 * B;
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) {
      o[0] = px;
      o[1] = py;
      o[2] = 0;
      o[3] = 0;
      return;
    }
    if (
      !Number.isFinite(px) ||
      !Number.isFinite(py) ||
      !Number.isFinite(vx) ||
      !Number.isFinite(vy)
    ) {
      o[0] = rx;
      o[1] = ry;
      o[2] = 0;
      o[3] = 0;
      return;
    }
    const damp = Math.pow(0.72, s30);
    vx = (vx + (rx - px) * 0.075 * s30) * damp;
    vy = (vy + (ry - py) * 0.075 * s30) * damp;
    px += vx * s30;
    py += vy * s30;
    const dx = px - bx;
    const dy = py - by;
    const d = Math.hypot(dx, dy);
    const MAXLEN = 0.56 * B;
    if (d > MAXLEN) {
      px = bx + (dx / d) * MAXLEN;
      py = by + (dy / d) * MAXLEN;
    }
    o[0] = px;
    o[1] = py;
    o[2] = vx;
    o[3] = vy;
  }

  // ---- triangle emission ------------------------------------------------------

  private beginPoly(): void {
    this.np = 0;
  }

  private v(x: number, y: number): void {
    const i = this.np * 2;
    if (i + 1 < this.poly.length) {
      this.poly[i] = x;
      this.poly[i + 1] = y;
      this.np++;
    }
  }

  /** Fan-triangulate the current polygon into the solid stream with the
   *  zone/shade ramp color, plus a scaled dim copy into the additive stream
   *  (the rim-glow silhouette behind her). Leaves `poly` intact. */
  private facet(zone: number, shade: number): void {
    const o = (zone * 3 + shade) * 3;
    const r = this.ramps[o];
    const g = this.ramps[o + 1];
    const b = this.ramps[o + 2];
    const p = this.poly;
    const n = this.np;
    const x0 = p[0];
    const y0 = p[1];
    for (let i = 1; i < n - 1; i++) {
      this.solidTri(x0, y0, p[2 * i], p[2 * i + 1], p[2 * i + 2], p[2 * i + 3], r, g, b);
    }
    if (zone < ZEYE) {
      const sc = this.glowS;
      const cx = this.bcx;
      const cy = this.bcy;
      for (let i = 1; i < n - 1; i++) {
        this.addTri(
          cx + (x0 - cx) * sc,
          cy + (y0 - cy) * sc,
          cx + (p[2 * i] - cx) * sc,
          cy + (p[2 * i + 1] - cy) * sc,
          cx + (p[2 * i + 2] - cx) * sc,
          cy + (p[2 * i + 3] - cy) * sc,
          this.glowR,
          this.glowG,
          this.glowB,
        );
      }
    }
  }

  /** Stroke the current polygon into the additive stream as thin quads —
   *  crisp neon silhouettes (bright) or soft creases (faint). */
  private edge(soft: boolean, closed: boolean): void {
    const p = this.poly;
    const n = this.np;
    if (n < 2) return;
    const hw = soft ? 0.45 : 0.62;
    const r = soft ? this.softR : this.edgeR;
    const g = soft ? this.softG : this.edgeG;
    const b = soft ? this.softB : this.edgeB;
    const m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const k = (i + 1) % n;
      let ax = p[2 * i];
      let ay = p[2 * i + 1];
      let bx = p[2 * k];
      let by = p[2 * k + 1];
      let dx = bx - ax;
      let dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (!(len > 1e-6)) continue;
      dx /= len;
      dy /= len;
      // Extend both ends by the half-width to fake mitred joins.
      ax -= dx * hw;
      ay -= dy * hw;
      bx += dx * hw;
      by += dy * hw;
      const px = -dy * hw;
      const py = dx * hw;
      this.addTri(ax + px, ay + py, bx + px, by + py, bx - px, by - py, r, g, b);
      this.addTri(ax + px, ay + py, bx - px, by - py, ax - px, ay - py, r, g, b);
    }
  }

  /** Push one triangle (design-space coords) into the solid stream.
   *  Non-finite triangles are dropped. */
  private solidTri(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    r: number,
    g: number,
    b: number,
  ): void {
    if (!Number.isFinite(x1 + y1 + x2 + y2 + x3 + y3)) return;
    const buf = this.solidBuf;
    let p = this.solidPos;
    if (p + 15 > buf.length) return;
    buf[p++] = x1;
    buf[p++] = y1;
    buf[p++] = r;
    buf[p++] = g;
    buf[p++] = b;
    buf[p++] = x2;
    buf[p++] = y2;
    buf[p++] = r;
    buf[p++] = g;
    buf[p++] = b;
    buf[p++] = x3;
    buf[p++] = y3;
    buf[p++] = r;
    buf[p++] = g;
    buf[p++] = b;
    this.solidPos = p;
  }

  /** Same, into the additive stream. */
  private addTri(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    r: number,
    g: number,
    b: number,
  ): void {
    if (!Number.isFinite(x1 + y1 + x2 + y2 + x3 + y3)) return;
    const buf = this.addBuf;
    let p = this.addPos;
    if (p + 15 > buf.length) return;
    buf[p++] = x1;
    buf[p++] = y1;
    buf[p++] = r;
    buf[p++] = g;
    buf[p++] = b;
    buf[p++] = x2;
    buf[p++] = y2;
    buf[p++] = r;
    buf[p++] = g;
    buf[p++] = b;
    buf[p++] = x3;
    buf[p++] = y3;
    buf[p++] = r;
    buf[p++] = g;
    buf[p++] = b;
    this.addPos = p;
  }

  // ---- body geometry (facets + neon edges over the projected skeleton) ------

  private jx(i: number): number {
    return this.skel[i * 2];
  }
  private jy(i: number): number {
    return this.skel[i * 2 + 1];
  }
  private js(i: number): number {
    const s = this.jscale[i];
    return Number.isFinite(s) ? s : 1;
  }
  /** Point on the torso frame: t along pelvis→shoulder (0..1), w to the right. */
  private atX(t: number, w: number): number {
    return this.tfPx + this.tfUx * this.tfUl * t + this.tfVx * w;
  }
  private atY(t: number, w: number): number {
    return this.tfPy + this.tfUy * this.tfUl * t + this.tfVy * w;
  }

  private emitBody(): void {
    const B = BODY_H;

    // Torso frame (shared by the shoulder caps and skirt fan).
    const plx = this.jx(PEL);
    const ply = this.jy(PEL);
    let ux = this.jx(SH) - plx;
    let uy = this.jy(SH) - ply;
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul;
    uy /= ul;
    this.tfPx = plx;
    this.tfPy = ply;
    this.tfUx = ux;
    this.tfUy = uy;
    this.tfVx = -uy;
    this.tfVy = ux;
    this.tfUl = ul;

    // Depth ordering from the 3D solve: far limbs draw first, near last.
    const leftArmFar = this.skel3[HAL * 3 + 2] <= this.skel3[HAR * 3 + 2];
    const leftLegFar = this.skel3[FTL * 3 + 2] <= this.skel3[FTR * 3 + 2];

    // Twin-tails first: behind everything.
    this.emitTail(-1, TAILL);
    this.emitTail(1, TAILR);

    // The FAR arm goes behind the torso.
    this.emitArm(leftArmFar ? 0 : 1);

    // Legs, far leg first so crossovers layer correctly.
    this.emitLeg(leftLegFar ? 0 : 1);
    this.emitLeg(leftLegFar ? 1 : 0);

    // Torso plates from the projected 3D corner joints — body yaw
    // foreshortens them through z, which is what sells the turn.
    const lsx = this.jx(SHL);
    const lsy = this.jy(SHL);
    const rsx = this.jx(SHR);
    const rsy = this.jy(SHR);
    const cpx = this.jx(COLLAR);
    const cpy = this.jy(COLLAR);
    const wlx = this.jx(WSTL);
    const wly = this.jy(WSTL);
    const wrx = this.jx(WSTR);
    const wry = this.jy(WSTR);
    const sbx = (wlx + wrx) * 0.5;
    const sby = (wly + wry) * 0.5;
    this.beginPoly();
    this.v(cpx, cpy);
    this.v(lsx, lsy);
    this.v(wlx, wly);
    this.v(sbx, sby);
    this.facet(ZDRESS, 2); // chest, lit plane
    this.beginPoly();
    this.v(cpx, cpy);
    this.v(rsx, rsy);
    this.v(wrx, wry);
    this.v(sbx, sby);
    this.facet(ZDRESS, 0); // chest, shadow plane
    // Hip plate corners: the hip sockets, widened a touch about the pelvis.
    const hlx = plx + (this.jx(HIPL) - plx) * 1.18;
    const hly = ply + (this.jy(HIPL) - ply) * 1.18;
    const hrx = plx + (this.jx(HIPR) - plx) * 1.18;
    const hry = ply + (this.jy(HIPR) - ply) * 1.18;
    this.beginPoly();
    this.v(wlx, wly);
    this.v(wrx, wry);
    this.v(hrx, hry);
    this.v(hlx, hly);
    this.facet(ZDRESS, 1); // waist plate
    this.beginPoly();
    this.v(hlx, hly);
    this.v(hrx, hry);
    this.v(this.atX(-0.12, 0), this.atY(-0.12, 0));
    this.facet(ZDRESS, 0); // pelvis wedge
    // Torso silhouette (open at the bottom where the skirt takes over).
    this.beginPoly();
    this.v(this.atX(0.18, -0.08 * B), this.atY(0.18, -0.08 * B));
    this.v(wlx, wly);
    this.v(lsx, lsy);
    this.v(cpx, cpy);
    this.v(rsx, rsy);
    this.v(wrx, wry);
    this.v(this.atX(0.18, 0.08 * B), this.atY(0.18, 0.08 * B));
    this.edge(false, false);
    // Waist seam crease.
    this.beginPoly();
    this.v(wlx, wly);
    this.v(wrx, wry);
    this.edge(true, false);
    // Shoulder caps: small diamonds over the arm sockets.
    this.emitCap(SHL, 2);
    this.emitCap(SHR, 0);

    // Pleated skirt: a short A-line cone. The WAISTBAND rides the projected
    // hip line (it tilts and foreshortens with the pelvis), but the HEM hangs
    // in WORLD space under gravity, chasing the spring-lagged SKIRT anchor —
    // it trails every hip move and settles. Short (hem at mid-thigh) so the
    // footwork always reads.
    {
      const ps = this.js(PEL);
      const lagX = clamp(this.jx(SKIRT) - plx, -0.08 * B, 0.08 * B);
      const vLag = clamp(this.jy(SKIRT) - (ply + 0.1 * B), -0.05 * B, 0.06 * B);
      const swish = Math.min(0.03 * B, Math.abs(this.skirtVX) * 3);
      const hipHx = (hrx - hlx) * 0.5;
      const hipHy = (hry - hly) * 0.5;
      const bandS = (0.098 * B + 0.014 * B) / Math.max(1e-3, Math.hypot(hipHx, hipHy));
      const hemW = (0.155 * B + swish) * ps; // A-line flare, breathes with motion
      const hemYc = ply + 0.165 * B * ps + vLag * 0.7; // world-down drop, mid-thigh
      const hem = this.hem;
      const top = this.hemTop;
      const bcxW = (hlx + hrx) * 0.5;
      const bcyW = (hly + hry) * 0.5;
      for (let k = 0; k <= 8; k++) {
        const f = (k - 4) / 4; // -1..1 across the skirt
        top[k * 2] = bcxW + hipHx * bandS * f;
        top[k * 2 + 1] = bcyW + hipHy * bandS * f + 0.012 * B;
        // Hem: sides ride up (the 2D read of a cone seen from the front),
        // odd points dip a hair (soft scallop pleats, not a sawtooth), and
        // the whole hem swings like a bell off the lagged anchor.
        hem[k * 2] = plx + hemW * f + lagX * (0.85 - 0.2 * Math.abs(f));
        hem[k * 2 + 1] =
          hemYc - Math.abs(f) * 0.02 * B + (k % 2 === 1 ? 0.009 * B : 0) - lagX * f * 0.25;
      }
      for (let k = 0; k < 8; k++) {
        this.beginPoly();
        this.v(top[k * 2], top[k * 2 + 1]);
        this.v(top[k * 2 + 2], top[k * 2 + 3]);
        this.v(hem[k * 2 + 2], hem[k * 2 + 3]);
        this.v(hem[k * 2], hem[k * 2 + 1]);
        // Soft key-light sweep across the cone (lit upper-left → shadow
        // right), not alternating light/dark blades.
        this.facet(ZSKIRT, k < 3 ? 2 : k < 6 ? 1 : 0);
      }
      // Full silhouette (side seams + scalloped hem, open at the waist) and
      // three faint pleat creases on the lower half.
      this.beginPoly();
      this.v(top[0], top[1]);
      for (let k = 0; k <= 8; k++) this.v(hem[k * 2], hem[k * 2 + 1]);
      this.v(top[16], top[17]);
      this.edge(false, false);
      for (let k = 2; k <= 6; k += 2) {
        this.beginPoly();
        this.v(
          top[k * 2] + (hem[k * 2] - top[k * 2]) * 0.55,
          top[k * 2 + 1] + (hem[k * 2 + 1] - top[k * 2 + 1]) * 0.55,
        );
        this.v(hem[k * 2], hem[k * 2 + 1]);
        this.edge(true, false);
      }
    }

    // The NEAR arm draws over the torso and skirt.
    this.emitArm(leftArmFar ? 1 : 0);

    // Neck (fill only, no line) + the head stack.
    this.emitLimb(SH, HEADB, 0.022, 0.018, ZSKIN, false);
    this.emitHead();
  }

  /** One arm: slim bare-skin prisms + a hand diamond. */
  private emitArm(side: number): void {
    const so = side === 0 ? SHL : SHR;
    const el = side === 0 ? ELL : ELR;
    const ha = side === 0 ? HAL : HAR;
    this.emitLimb(so, el, 0.03, 0.021, ZSKIN, true);
    this.emitLimb(el, ha, 0.02, 0.014, ZSKIN, true);
    this.emitHand(el, ha);
  }

  /** One leg: bare thigh, knee-high boot shin, cuff band, shoe. */
  private emitLeg(side: number): void {
    const hip = side === 0 ? HIPL : HIPR;
    const kn = side === 0 ? KNL : KNR;
    const ft = side === 0 ? FTL : FTR;
    this.emitLimb(hip, kn, 0.038, 0.026, ZSKIN, true);
    this.emitLimb(kn, ft, 0.027, 0.013, ZTRIM, true);
    this.emitCuff(kn, ft);
    this.emitShoe(kn, ft, side === 0 ? -1 : 1);
  }

  /** Angular tapered limb as a two-facet prism with a mid-edge knot; which
   *  face is lit is decided by the fixed key light. Widths scale with the
   *  joints' perspective so near limbs read bigger. The silhouette is one
   *  open polyline (open at joint `a`). */
  private emitLimb(
    a: number,
    b: number,
    wa: number,
    wb: number,
    zone: number,
    line: boolean,
  ): void {
    const B = BODY_H;
    let ax = this.jx(a);
    let ay = this.jy(a);
    let bx = this.jx(b);
    let by = this.jy(b);
    let dx = bx - ax;
    let dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const o = 0.012 * B; // overshoot both ends so bent joints don't gap
    ax -= dx * o;
    ay -= dy * o;
    bx += dx * o;
    by += dy * o;
    const px = -dy;
    const py = dx;
    const wA = wa * B * this.js(a);
    const wB = wb * B * this.js(b);
    const wM = Math.max(wA, wB) * 1.07;
    const mx = ax + dx * (len + 2 * o) * 0.45;
    const my = ay + dy * (len + 2 * o) * 0.45;
    const ro = -0.2; // ridge offset → asymmetric lit/shadow faces
    const arx = ax + px * wA * ro;
    const ary = ay + py * wA * ro;
    const brx = bx + px * wB * ro;
    const bry = by + py * wB * ro;
    const minusLit = px * LX + py * LY < 0;
    this.beginPoly();
    this.v(arx, ary);
    this.v(brx, bry);
    this.v(bx - px * wB, by - py * wB);
    this.v(mx - px * wM, my - py * wM);
    this.v(ax - px * wA, ay - py * wA);
    this.facet(zone, minusLit ? 2 : 1);
    this.beginPoly();
    this.v(arx, ary);
    this.v(brx, bry);
    this.v(bx + px * wB, by + py * wB);
    this.v(mx + px * wM, my + py * wM);
    this.v(ax + px * wA, ay + py * wA);
    this.facet(zone, minusLit ? 1 : 2);
    if (line) {
      this.beginPoly();
      this.v(ax - px * wA, ay - py * wA);
      this.v(mx - px * wM, my - py * wM);
      this.v(bx - px * wB, by - py * wB);
      this.v(bx + px * wB, by + py * wB);
      this.v(mx + px * wM, my + py * wM);
      this.v(ax + px * wA, ay + py * wA);
      this.edge(false, false);
    }
  }

  /** Hand: a small skin diamond just beyond the wrist, along the forearm. */
  private emitHand(elb: number, wri: number): void {
    const B = BODY_H * this.js(wri);
    const wx = this.jx(wri);
    const wy = this.jy(wri);
    let dx = wx - this.jx(elb);
    let dy = wy - this.jy(elb);
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const px = -dy;
    const py = dx;
    const cx = wx + dx * 0.022 * B;
    const cy = wy + dy * 0.022 * B;
    this.beginPoly();
    this.v(wx - dx * 0.012 * B, wy - dy * 0.012 * B);
    this.v(cx + px * 0.026 * B, cy + py * 0.026 * B);
    this.v(wx + dx * 0.06 * B, wy + dy * 0.06 * B);
    this.v(cx - px * 0.026 * B, cy - py * 0.026 * B);
    this.facet(ZSKIN, 2);
    this.edge(false, true);
  }

  /** Dainty flat off the ankle: one angular wedge; the toe blends from
   *  pointing outward (standing) toward the shin direction (kicking). */
  private emitShoe(kne: number, ank: number, side: number): void {
    const B = BODY_H * this.js(ank);
    const ax = this.jx(ank);
    const ay = this.jy(ank);
    const shinAng = Math.atan2(ax - this.jx(kne), ay - this.jy(kne));
    const blend = Math.min(1, Math.abs(shinAng));
    const toeAng = side * 1.25 * (1 - blend) + shinAng * blend;
    const dx = Math.sin(toeAng);
    const dy = Math.cos(toeAng);
    let px = Math.cos(toeAng);
    let py = -Math.sin(toeAng);
    if (py < 0) {
      px = -px;
      py = -py; // perp points toward the sole
    }
    const tl = 0.07 * B;
    const tx = ax + dx * tl;
    const ty = ay + dy * tl;
    this.beginPoly();
    this.v(ax - dx * 0.018 * B - px * 0.018 * B, ay - dy * 0.018 * B - py * 0.018 * B);
    this.v(ax + dx * 0.03 * B - px * 0.02 * B, ay + dy * 0.03 * B - py * 0.02 * B);
    this.v(tx - px * 0.004 * B, ty - py * 0.004 * B);
    this.v(tx + px * 0.013 * B, ty + py * 0.013 * B);
    this.v(ax - dx * 0.035 * B + px * 0.02 * B, ay - dy * 0.035 * B + py * 0.02 * B);
    this.facet(ZTRIM, 1);
    this.edge(false, true);
  }

  /** Knee-boot cuff: an angular band just below the knee. */
  private emitCuff(kne: number, ank: number): void {
    const B = BODY_H * this.js(kne);
    const kx = this.jx(kne);
    const ky = this.jy(kne);
    let dx = this.jx(ank) - kx;
    let dy = this.jy(ank) - ky;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const px = -dy;
    const py = dx;
    const cx = kx + dx * 0.055 * B;
    const cy = ky + dy * 0.055 * B;
    const w = 0.032 * B;
    const h = 0.013 * B;
    this.beginPoly();
    this.v(cx - px * w - dx * h, cy - py * w - dy * h);
    this.v(cx + px * w - dx * h, cy + py * w - dy * h);
    this.v(cx + px * w + dx * h, cy + py * w + dy * h);
    this.v(cx - px * w + dx * h, cy - py * w + dy * h);
    this.facet(ZTRIM, 2);
  }

  /** Twin-tail: a tapered strip from a side-of-head base to the sprung tip,
   *  with a darker tip step, one open silhouette and a scrunchie diamond. */
  private emitTail(side: number, tipI: number): void {
    const B = BODY_H * this.js(HEAD);
    const hx = this.jx(HEAD);
    const hy = this.jy(HEAD);
    const r = R_HEAD * B;
    const bx = hx + side * r * 0.85;
    const by = hy - r * 0.1;
    const tx = this.jx(tipI);
    const ty = this.jy(tipI);
    let dx = tx - bx;
    let dy = ty - by;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const px = -dy;
    const py = dx;
    const zig = side * 0.02 * B; // gentle spine zigzag → angular S-curve
    const p1x = bx + dx * len * 0.4 + px * zig;
    const p1y = by + dy * len * 0.4 + py * zig;
    const p2x = bx + dx * len * 0.74 - px * zig * 0.6;
    const p2y = by + dy * len * 0.74 - py * zig * 0.6;
    const w0 = 0.042 * B;
    const w1 = 0.05 * B;
    const w2 = 0.026 * B;
    this.beginPoly();
    this.v(bx - px * w0, by - py * w0);
    this.v(p1x - px * w1, p1y - py * w1);
    this.v(p2x - px * w2, p2y - py * w2);
    this.v(tx, ty);
    this.v(p2x + px * w2, p2y + py * w2);
    this.v(p1x + px * w1, p1y + py * w1);
    this.v(bx + px * w0, by + py * w0);
    this.facet(ZHAIR, side < 0 ? 2 : 1);
    this.edge(false, false);
    this.beginPoly();
    this.v(p2x - px * w2, p2y - py * w2);
    this.v(tx, ty);
    this.v(p2x + px * w2, p2y + py * w2);
    this.facet(ZHAIR, side < 0 ? 1 : 0); // darker tip step
    this.beginPoly();
    this.v(bx, by - 0.028 * B);
    this.v(bx + 0.022 * B, by);
    this.v(bx, by + 0.028 * B);
    this.v(bx - 0.022 * B, by);
    this.facet(ZTRIM, 2); // scrunchie
  }

  /** Shoulder cap: a small diamond over the arm socket, on the torso frame. */
  private emitCap(i: number, shade: number): void {
    const B = BODY_H * this.js(i);
    const x = this.jx(i);
    const y = this.jy(i);
    this.beginPoly();
    this.v(x + this.tfUx * 0.032 * B, y + this.tfUy * 0.032 * B);
    this.v(x + this.tfVx * 0.05 * B, y + this.tfVy * 0.05 * B);
    this.v(x - this.tfUx * 0.032 * B, y - this.tfUy * 0.032 * B);
    this.v(x - this.tfVx * 0.05 * B, y - this.tfVy * 0.05 * B);
    this.facet(ZDRESS, shade);
  }

  /** The head: hair back-mass silhouette, clean lit face with one shadow
   *  sliver, swept bangs plate, parting crease, eyes, blush, ahoge. The face
   *  features slide with head yaw (faceTurn) so she reads as turning in 3D. */
  private emitHead(): void {
    const B = BODY_H * this.js(HEAD);
    const hx = this.jx(HEAD);
    const hy = this.jy(HEAD);
    const r = R_HEAD * B;
    const tilt = clamp((hx - this.jx(HEADB)) * 0.5 + this.faceTurn, -r, r);
    const chX = hx + tilt * 0.3;
    const chY = hy + r * 1.04;
    const crX = hx - tilt * 0.5;
    const crY = hy - r * 1.28;
    // Hair back-mass base — the face and bangs carve into it.
    this.beginPoly();
    this.v(hx - r * 1.12, hy - r * 0.15);
    this.v(hx - r * 0.85 - tilt * 0.5, hy - r * 0.95);
    this.v(crX, crY);
    this.v(hx + r * 0.85 - tilt * 0.5, hy - r * 0.92);
    this.v(hx + r * 1.12, hy - r * 0.1);
    this.v(hx + r * 0.95, hy + r * 0.5);
    this.v(hx + r * 0.52, hy + r * 0.9);
    this.v(chX, chY);
    this.v(hx - r * 0.52, hy + r * 0.92);
    this.v(hx - r * 0.95, hy + r * 0.55);
    this.facet(ZHAIR, 0);
    this.edge(false, true);
    // Face: one smooth lit plane.
    this.beginPoly();
    this.v(hx - r * 0.9, hy - r * 0.4);
    this.v(hx + r * 0.9, hy - r * 0.4);
    this.v(hx + r * 0.92, hy + r * 0.42);
    this.v(hx + r * 0.5, hy + r * 0.85);
    this.v(hx + tilt * 0.3, hy + r);
    this.v(hx - r * 0.5, hy + r * 0.87);
    this.v(hx - r * 0.92, hy + r * 0.47);
    this.facet(ZSKIN, 2);
    // Narrow face shadow sliver on the off-light side.
    this.beginPoly();
    this.v(hx + r * 0.52, hy - r * 0.4);
    this.v(hx + r * 0.9, hy - r * 0.4);
    this.v(hx + r * 0.92, hy + r * 0.42);
    this.v(hx + r * 0.5, hy + r * 0.85);
    this.facet(ZSKIN, 1);
    // Bangs: a swept plate from temple to temple with a 3-notch hem.
    this.beginPoly();
    this.v(hx - r * 0.95, hy - r * 0.25);
    this.v(hx - r * 0.52, hy + r * 0.18);
    this.v(hx - r * 0.08 + tilt * 0.2, hy - r * 0.12);
    this.v(hx + r * 0.42, hy + r * 0.2);
    this.v(hx + r * 0.92, hy - r * 0.28);
    this.v(hx + r * 0.8 - tilt * 0.4, hy - r * 0.9);
    this.v(crX, crY);
    this.v(hx - r * 0.82 - tilt * 0.4, hy - r * 0.88);
    this.facet(ZHAIR, 2);
    // Bangs shadow wedge for hair volume.
    this.beginPoly();
    this.v(hx + r * 0.42, hy + r * 0.2);
    this.v(hx + r * 0.92, hy - r * 0.28);
    this.v(hx + r * 0.8 - tilt * 0.4, hy - r * 0.9);
    this.facet(ZHAIR, 1);
    // Soft hair-parting crease.
    this.beginPoly();
    this.v(hx - r * 0.08 + tilt * 0.2, hy - r * 0.12);
    this.v(hx - r * 0.16 - tilt * 0.4, hy - r * 1.18);
    this.edge(true, false);
    // Eyes + blush diamonds.
    const eyeY = hy + r * 0.32;
    for (let s = -1; s <= 1; s += 2) {
      const ex = hx + s * r * 0.4 + tilt * 0.25;
      this.beginPoly();
      this.v(ex, eyeY - r * 0.22);
      this.v(ex + r * 0.11, eyeY);
      this.v(ex, eyeY + r * 0.22);
      this.v(ex - r * 0.11, eyeY);
      this.facet(ZEYE, 0);
      const bx = hx + s * r * 0.6 + tilt * 0.2;
      const by = hy + r * 0.62;
      this.beginPoly();
      this.v(bx, by - r * 0.07);
      this.v(bx + r * 0.16, by);
      this.v(bx, by + r * 0.07);
      this.v(bx - r * 0.16, by);
      this.facet(ZBLUSH, 0);
    }
    // Ahoge: one thin triangle wisp to its wobbling sprung tip.
    this.beginPoly();
    this.v(crX - 0.009 * B, crY + 0.004 * B);
    this.v(this.jx(AHOGE), this.jy(AHOGE));
    this.v(crX + 0.009 * B, crY);
    this.facet(ZHAIR, 2);
    this.edge(false, false);
  }

  /** Hand-burst: additive spark spikes radiating off the raised wrist(s),
   *  fired by Up notes and jumps, sized by remaining burst life. */
  private emitBurst(life: number, both: boolean): void {
    this.burstAt(this.jx(HAR), this.jy(HAR), life);
    if (both) this.burstAt(this.jx(HAL), this.jy(HAL), life);
  }

  private burstAt(hx: number, hy: number, life: number): void {
    const w = this.pal.white;
    const c = this.pal.accentC;
    const r = (lerp(w[0], c[0], 0.45) / 255) * life;
    const g = (lerp(w[1], c[1], 0.45) / 255) * life;
    const b = (lerp(w[2], c[2], 0.45) / 255) * life;
    for (let k = 0; k < 9; k++) {
      const ang = k * 0.6981 + this.jit[k] * 0.9;
      const len = (16 + 16 * (this.jit[k + 9] + 0.5)) * life;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      const o = 5 + 9 * life;
      const hw = 0.6 + 2.4 * life;
      const px = -dy * hw;
      const py = dx * hw;
      this.addTri(
        hx + dx * o + px,
        hy + dy * o + py,
        hx + dx * o - px,
        hy + dy * o - py,
        hx + dx * (o + len),
        hy + dy * (o + len),
        r,
        g,
        b,
      );
    }
  }
}

// ---- small chart utilities ------------------------------------------------------

function bitCount(cols: number): number {
  return (cols & 1) + ((cols >> 1) & 1) + ((cols >> 2) & 1) + ((cols >> 3) & 1);
}

/** True if a note row raises a hand skyward (→ hand-burst spikes). */
function raisesHand(cols: number): boolean {
  return bitCount(cols) >= 2 || (cols & 4) !== 0;
}
