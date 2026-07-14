/**
 * AttractDancer — the low-poly anime-girl dancer, driven by a physically
 * grounded motion core. It is a pure-CPU triangle-mesh generator for the GPU
 * pipeline: build(time, beat) refills two reused vertex buffers (x, y, r, g, b
 * per vertex, triangle list, 960x540 design space, y down) — `solid` holds the
 * opaque flat-shaded body facets, `additive` holds the neon silhouette edges,
 * rim-glow and hand-burst spikes.
 *
 * MOTION MODEL (one coherent source — real full-body dance mocap):
 *
 *  1. THE WHOLE BODY (torso, arms, head, legs) is reconstructed every frame from
 *     one baked full-body dance clip (mocapDance.ts): 15 joints as positions
 *     relative to the hips, in a pelvis heading-aligned frame, leg-length units.
 *     We yaw-damp the clip so she faces the viewer, ground the LOWEST foot to the
 *     pad floor plane (the bounce emerges from foot/pelvis relative motion, never
 *     a float), and map the joints onto our skel3 with an L/R cross (she faces
 *     us, so mocap-left reads as screen-right).
 *
 *  2. FOOT-IK layer: the scheduler + per-foot state machine still produce a
 *     plant/swing target on the chart's arrow panels, landing exactly on the note
 *     beat (StepParity panels, crossovers included). Each foot is blended from its
 *     MOCAP position toward that chart target (full while a step owns the foot,
 *     easing to a resting blend between steps), then the leg is re-solved with the
 *     analytic two-bone IK (law of cosines, forward knee pole). A HARD pelvis
 *     reach clamp drops the pelvis so a planted leg never over-extends. A chart
 *     JUMP is simply a two-foot step through this same layer.
 *
 *  3. THE DANCEPAD is a physical 3D slab in the SAME worldspace, projected through
 *     the same camera: a dark platform on the floor plane with four arrow panels
 *     at the foot-target spots, lit on the beat they are stepped.
 *
 *  4. SECONDARY MOTION — twin-tails, ahoge and skirt hem — ride simple damped
 *     springs layered after the body solve (standard cloth/hair smoothing).
 *
 * With no chart the scheduler synthesizes an 8-beat L/D/R/U pattern; with no beat
 * (NaN/negative lead-in) the clocks run off `time`. Everything is deterministic
 * (no Math.random / Date.now) and framerate-independent (dt clamped ≤ 0.1s);
 * nothing allocates per frame, and every emitted value is guarded against
 * non-finite (skel3 also feeds the VRM aim-retarget — one NaN would poison it).
 */

import { MOCAP_DIRS, MOCAP_FRAMES, MOCAP_STRIDE } from './mocapDance';

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

// ---- tempo / footwork tunables ----------------------------------------------
// Lengths in design px. The chart schedule is in beats; a low-passed `bps`
// (this.bps) tracks local tempo.

/** Local tempo tracking: bps = lowpass(Δbeat/Δt), clamped to a sane band. */
const BPS_LP = 0.12;
const BPS_MIN = 0.5;
const BPS_MAX = 8;

/** Foot-swing window (beats), clamped shorter by the gap to the next note so
 *  fast streams stay crisp. A step lands exactly on its note beat. */
const STEP_SWING_BEATS = 0.42;

/** Foot-IK blend: how strongly a foot is pulled from its MOCAP position toward
 *  the chart panel target. 1 while a step owns the foot; between steps it eases
 *  toward FOOT_CHART_REST so the planted foot mostly holds its last panel while
 *  the leg still breathes with the mocap. FOOT_BLEND_RATE = ease speed (1/s). */
const FOOT_CHART_REST = 0.85; // planted feet hold their panel firmly (feet stay ON
// the pad's arrows and step between them on the beat — a dancer's footwork), while
// the mocap still drives the hips/torso/arms/head above them.
const FOOT_BLEND_RATE = 9;

// ---- physics helpers (pure, allocation-free) --------------------------------

/** Minimum-jerk easing on [0,1]: zero velocity AND acceleration at both ends —
 *  the natural shape of a reach/step, no slide-in or overshoot. */
function minJerk(t: number): number {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * u * (10 + u * (-15 + 6 * u));
}
/** Half-sine on [0,1] for a swing/lift clearance arc (0 → 1 → 0). */
function halfSine(t: number): number {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.sin(Math.PI * u);
}

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

/** Named joint indices into the solved 3D skeleton (getSkeleton3D()), for
 *  retargeting our animation onto a real rigged model's bones. The buffer is
 *  [x,y,z] per joint in the dancer's design space: x = screen-right, y = DOWN,
 *  z = toward the viewer; units are design px (H=540). Chains: pelvis→chest→
 *  neck→head; shoulder→elbow→hand; hip→knee→foot. */
export const DANCER_SKELETON = {
  pelvis: PEL,
  chest: SH,
  neck: HEADB,
  head: HEAD,
  shoulderL: SHL,
  elbowL: ELL,
  handL: HAL,
  shoulderR: SHR,
  elbowR: ELR,
  handR: HAR,
  hipL: HIPL,
  kneeL: KNL,
  footL: FTL,
  hipR: HIPR,
  kneeR: KNR,
  footR: FTR,
} as const;

// Color zones → per-variant 3-step lit/mid/shadow ramps.
const ZSKIN = 0,
  ZHAIR = 1,
  ZDRESS = 2,
  ZSKIRT = 3,
  ZTRIM = 4,
  ZEYE = 5,
  ZBLUSH = 6;

// Proportions as fractions of BODY_H — cute anime proportions. The full-body
// mocap supplies every joint POSITION (in leg-length units), so only the head
// radius and the leg lengths (the leg-length unit + the two-bone IK) are needed
// here; the torso/arm bone lengths are implicit in the mocap and no longer used.
const R_HEAD = 0.08;
const L_THIGH = 0.25,
  L_SHIN = 0.24,
  L_SHOE = 0.025;

// ---- full-body dance mocap (Bandai Namco dance dataset, CC BY-NC) -------------
// ONE baked full-body clip drives the entire body (mocapDance.ts: 15 joints as
// hip-relative positions in a pelvis heading-aligned frame, leg-length units,
// then [heading,hipY,hipX,hipZ]). BEAT SYNC: advancing exactly MOCAP_FPB frames
// per musical beat locks the dance to the beat and loops with no drift.
//
// SIGN / MAPPING CONSTS — the coordinate signs are hard to get right without
// seeing the render; the parent verifies visually and flips these from captures.
// Wire them here structurally; do not over-tune blind.
const MOCAP_FPB = 6.5; // baked frames advanced per musical beat (520 frames loop)
const MOCAP_PHASE = 0; // beats of phase offset to align the clip's accent to the beat
const MOCAP_SEAM = 12; // frames of loop cross-blend hiding the segment seam
const MOCAP_SR = 1; // sign of the mocap +right (screenRight) axis remap
const MOCAP_SF = 1; // sign of the mocap +fwd (screenFwd) axis remap
const MOCAP_SWAP = 1; // 1 = mocap-L → our screen-RIGHT joints (crossed), 0 = direct
const MOCAP_YAW_DAMP = 0.35; // fraction of the clip's heading kept (keeps her ~facing us)
const MOCAP_SWAY = 0; // pin the pelvis on the pad: the clip's root WANDERS around the
// capture volume (large translation), which flung her off-screen; the real dance
// (stepping, weight sway) lives in the joints RELATIVE to the pelvis, so pinning
// the root keeps her centred on the pad while the body still moves naturally.

// CHART-REACTIVE GROOVE — the fixed mocap loop reads as "canned" during the
// clip's own calm stretches, so the body does a knee-bend bounce on every note and
// anticipates the next one, scaled by how busy the chart is around now (a lookahead
// over the real beatmap). The bounce sinks the whole pelvis toward the pad; the
// foot-IK clamps the planted feet to the floor, so the KNEES absorb the dip while
// the torso and arms stay upright and undistorted (no per-segment amplitude scaling
// — that broke the arms before; no torso slouch — an upper-body-only dip did that).
// y is DOWN, so the dip is +y (pelvis sinks on the beat) and the anticipation coil
// is -y (a small pre-note rise that releases into the hit).
const GROOVE_WIN = 2; // beats of lookahead for the local note-density energy
const GROOVE_DENSITY_REF = 2; // notes/beat that reads as full energy (caps at 1)
const GROOVE_ENERGY_LP = 0.08; // low-pass on the density envelope (per frame)
const GROOVE_HIT_K = 5.5; // decay rate of the per-note dip pulse (in beats)
const GROOVE_BEAT_K = 4.5; // decay of the steady on-beat pulse between notes
const GROOVE_MIN = 0.022; // knee-bend bounce at rest energy (fraction of leg length)
const GROOVE_MAX = 0.06; // knee-bend bounce at full energy
const GROOVE_ANTIC = 0.34; // beats before a note the anticipation coil starts
const GROOVE_ANTIC_AMT = 0.5; // coil rise as a fraction of the dip amplitude

/** Circular / arithmetic mean of a per-frame float over the whole clip — the
 *  neutral the yaw/sway are measured against, so she centres on the viewer.
 *  Computed once at module load (deterministic, no per-frame cost). */
function clipMean(k: number): number {
  let s = 0;
  for (let f = 0; f < MOCAP_FRAMES; f++) s += MOCAP_DIRS[f * MOCAP_STRIDE + k];
  return s / MOCAP_FRAMES;
}
const MEAN_HEADING = (() => {
  let sx = 0;
  let sy = 0;
  for (let f = 0; f < MOCAP_FRAMES; f++) {
    const h = MOCAP_DIRS[f * MOCAP_STRIDE + 45];
    sx += Math.cos(h);
    sy += Math.sin(h);
  }
  return Math.atan2(sy, sx);
})();
const MEAN_HIPX = clipMean(47);
const MEAN_HIPZ = clipMean(48);

/** skel3 joint index → source mocap joint index (−1 = derived/accessory). The
 *  L/R cross: the dancer faces the viewer, so mocap-LEFT joints (3/4/5 arm,
 *  9/10/11 leg) feed our screen-RIGHT indices and vice-versa (MOCAP_SWAP=1). */
function buildMocapMap(swap: number): Int8Array {
  const m = new Int8Array(JOINTS).fill(-1);
  m[SH] = 0; // Chest
  m[HEADB] = 1; // Neck
  m[HEAD] = 2; // Head
  if (swap === 1) {
    m[SHR] = 3;
    m[ELR] = 4;
    m[HAR] = 5; // mocap L arm → our R
    m[SHL] = 6;
    m[ELL] = 7;
    m[HAL] = 8; // mocap R arm → our L
    m[HIPR] = 9;
    m[KNR] = 10;
    m[FTR] = 11; // mocap L leg → our R
    m[HIPL] = 12;
    m[KNL] = 13;
    m[FTL] = 14; // mocap R leg → our L
  } else {
    m[SHL] = 3;
    m[ELL] = 4;
    m[HAL] = 5;
    m[SHR] = 6;
    m[ELR] = 7;
    m[HAR] = 8;
    m[HIPL] = 9;
    m[KNL] = 10;
    m[FTL] = 11;
    m[HIPR] = 12;
    m[KNR] = 13;
    m[FTR] = 14;
  }
  return m;
}
const MOCAP_MAP = buildMocapMap(MOCAP_SWAP);

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

// ---- rest geometry (derived from the proportions) ---------------------------

/** Rest pelvis height (px, y DOWN): the pelvis when standing on both feet. Used
 *  only as a non-finite fallback for the mocap-grounded pelvis. */
const PEL_REST_Y = FOOT_Y - (L_THIGH + L_SHIN + L_SHOE) * BODY_H * 0.985;
/** Base foot-swing clearance (fraction of BODY_H): the foot lifts this far in a
 *  swing so a step reads as lift-and-plant, not a slide. */
const SWING_LIFT = 0.07;

// ---- footwork constants -------------------------------------------------------

/** Half stance width (fraction of BODY_H). */
const STANCE = 0.085;
/** Chart-less synthesized pattern, one row per beat (bit0=L,1=D,2=U,3=R;
 *  9 = L+R jump so the two-foot move shows up in attract mode too). */
const SYNTH: readonly number[] = [1, 2, 8, 4, 1, 8, 2, 9];

// ---- dance pad ----------------------------------------------------------------
// A 4-panel + laid FLAT on the floor plane (world y = FOOT_Y), each panel
// centered on the SAME 3D spot the corresponding foot steps to, so a planted
// foot reads as ON its panel. Panels are low-poly DDR arrows: a dim neon
// outline at rest, flashing bright on the beat the panel is stepped.

/** Panel centers on the floor, in (x, z): Left/Right straddle at z≈0, Up is
 *  the far panel (−z), Down the near panel (+z). Matches panelTarget. */
const PAD_CX: readonly number[] = [CX - 0.245 * BODY_H, CX, CX, CX + 0.245 * BODY_H];
const PAD_CZ: readonly number[] = [0, 0.2 * BODY_H, -0.28 * BODY_H, 0];
/** Unit pointing dir (pux,puz) per panel (L points −x, D +z, U −z, R +x). */
const PAD_PUX: readonly number[] = [-1, 0, 0, 1];
const PAD_PUZ: readonly number[] = [0, 1, -1, 0];
/** Half-size of an arrow on the floor (fraction of BODY_H). */
const PAD_HS = 0.092 * BODY_H;
/** Arrow outline template in (u,v): u = pointing dir, v = perpendicular. Seven
 *  points trace a classic chevron arrow (tip, barbs, shaft). */
const ARROW_U: readonly number[] = [1, 0, 0, -1, -1, 0, 0];
const ARROW_V: readonly number[] = [0, 1, 0.42, 0.42, -0.42, -0.42, -1];
/** Draw order: far panel (Up) first → near (Down) last, so the near panels
 *  layer over the far ones on the receding floor. */
const PAD_ORDER: readonly number[] = [2, 0, 3, 1];

/** Vertex capacities (5 floats per vertex). Generous: a full body is ~400
 *  solid verts and ~1100 additive verts, the pad ~250 more. */
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
    padSolidCount: 0, // leading verts of solid/additive that are the floor pad
    padAddCount: 0,
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
  private readonly md = new Float64Array(MOCAP_STRIDE); // sampled mocap frame (49)
  private readonly moff = new Float64Array(45); // world pelvis-relative offsets (15×xyz)
  private readonly footBlend = new Float64Array(2); // per-foot mocap→chart-target weight

  // ---- timing / tempo ----
  private lastTime = NaN;
  private prevBeat = NaN;
  private bps = 2; // low-passed beats-per-second

  // ---- feet (0 = screen-left, 1 = screen-right) ----
  private readonly footState = new Uint8Array(2); // 0 stance, 1 swing
  private readonly plantX = new Float64Array(2); // committed plant (x, z)
  private readonly plantZ = new Float64Array(2);
  private readonly fromX = new Float64Array(2); // swing origin
  private readonly fromZ = new Float64Array(2);
  private readonly toX = new Float64Array(2); // swing target (the panel)
  private readonly toZ = new Float64Array(2);
  private readonly liftBeatA = new Float64Array(2); // swing beat window
  private readonly landBeatA = new Float64Array(2);
  private readonly liftHA = new Float64Array(2); // swing clearance / tuck (px)
  private readonly footX = new Float64Array(2); // this frame's 3D ankle
  private readonly footYv = new Float64Array(2);
  private readonly footZ = new Float64Array(2);
  private readonly pt = new Float64Array(2); // panelTarget out (x, z)
  private readonly padPts = new Float64Array(16); // projected arrow outline (x,y)*8
  private readonly padPlat = new Float64Array(16); // projected pad slab + tile corners
  private lastFoot = 1; // which foot stepped last (U/D alternation)

  // ---- chart cursors ----
  private hitIdx = -1; // last step whose beat has passed (burst accents)
  private schedIdx = -1; // last step whose swing has been commanded
  private synthHit = -1e9; // chart-less mode bookkeeping
  private synthSched = -1e9;

  // ---- accents fired by note hits (bursts + glow only, not body pose) ----
  private hitBeat = -1e9;
  private hitCols = 0;

  // ---- chart-reactive upper-body groove (see GROOVE_* consts) ----
  private energyLP = 0.4; // low-passed local note density (0..1)
  private grooveDip = 0; // upper-body bounce this frame (fraction of leg length, +y down)

  // ---- dance-pad panel flashes (beat each panel was last stepped on) ----
  private readonly padFlash = new Float64Array(4).fill(-1e9);

  // ---- stable painter's-order state (opaque stream has no depth buffer, so
  //      part draw order = emission order). These booleans decide which
  //      arm/leg is FAR (drawn behind); a raw z-compare flips at ties/float
  //      noise and flickers, so they only flip past a hysteresis band. ----
  private armFarLeft = true;
  private legFarLeft = true;

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

    this.resetPhysics();
    this.out.solid = this.solidBuf;
    this.out.additive = this.addBuf;
  }

  /** The chart timeline (sorted ascending by beat). */
  setSteps(steps: readonly Step[]): void {
    this.steps = [...steps].sort((a, b) => a.beat - b.beat);
    this.rewind();
  }

  /** Live-inject a step (the keyboard test mode). Appended at/after the last
   *  step's beat so the forward scheduler cursors stay valid — no rewind, so
   *  the groove/springs don't reset. cols = L/D/U/R mask; lCol/rCol = foot
   *  panels (or -1 to let the heuristic pick the foot). */
  pushStep(atBeat: number, cols: number, lCol: number, rCol: number): void {
    const last = this.steps.length ? this.steps[this.steps.length - 1].beat : -Infinity;
    const beat = Math.max(atBeat, last + 1e-3);
    this.steps = [...this.steps, { beat, cols, lCol, rCol }];
  }

  /** The solved 3D skeleton after the most recent build() — [x,y,z] per joint
   *  (design space: x right, y DOWN, z toward viewer). Indexed by
   *  DANCER_SKELETON. For retargeting our animation onto a real model. */
  getSkeleton3D(): Float64Array {
    return this.skel3;
  }

  /** Per-panel dance-pad flash intensity (0..1) at `beat`, written L,D,U,R into
   *  `out` — bright the instant a foot lands on that panel, fading over ~a beat.
   *  Lets the GPU background draw the pad arrows under ANY dancer (2D or 3D). */
  padFlashInto(beat: number, out: Float32Array): void {
    for (let p = 0; p < 4; p++) {
      const db = Number.isFinite(beat) ? beat - this.padFlash[p] : 1e9;
      out[p] = db >= 0 && db < 1.2 ? Math.exp(-3.2 * db) : 0;
    }
  }

  /** Reset to a neutral two-foot stance (seek/rewind, and construction): tempo
   *  parks, both feet plant on the neutral stance, blends go mocap-only. */
  private resetPhysics(): void {
    const B = BODY_H;
    this.bps = 2;
    for (let f = 0; f < 2; f++) {
      const x = CX + (f === 0 ? -1 : 1) * STANCE * B;
      this.plantX[f] = x;
      this.plantZ[f] = 0;
      this.fromX[f] = x;
      this.fromZ[f] = 0;
      this.toX[f] = x;
      this.toZ[f] = 0;
      this.footState[f] = 0;
      this.liftBeatA[f] = -1e9;
      this.landBeatA[f] = -1e9;
      this.liftHA[f] = 0;
      this.footX[f] = x;
      this.footZ[f] = 0;
      this.footYv[f] = FOOT_Y - L_SHOE * B;
      this.footBlend[f] = 0;
    }
    this.faceTurn = 0;
  }

  private rewind(): void {
    this.hitIdx = -1;
    this.schedIdx = -1;
    this.synthHit = -1e9;
    this.synthSched = -1e9;
    this.hitBeat = -1e9;
    this.padFlash.fill(-1e9);
    this.lastFoot = 1;
    this.armFarLeft = true;
    this.legFarLeft = true;
    this.resetPhysics();
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
    padSolidCount: number;
    padAddCount: number;
  } {
    if (!Number.isFinite(time)) time = 0;
    let dt = time - this.lastTime;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, 0.1);
    this.lastTime = time;
    const s30 = Math.min(dt * 30, 2.5); // secondary-spring step vs 30fps

    const valid = Number.isFinite(beat) && beat >= 0;
    const chart = valid && this.steps.length > 0;

    // Tempo: track bps = lowpass(Δbeat/Δt). A big beat LEAP (backward seek or
    // forward warp) resyncs everything to a neutral stance.
    if (valid && Number.isFinite(this.prevBeat)) {
      const db = beat - this.prevBeat;
      if (db < -0.5 || db > 4) this.rewind();
      else if (dt > 1e-5) {
        const inst = db / dt;
        if (Number.isFinite(inst)) this.bps += (inst - this.bps) * BPS_LP;
      }
    }
    this.bps = clamp(Number.isFinite(this.bps) ? this.bps : 2, BPS_MIN, BPS_MAX);
    this.prevBeat = valid ? beat : NaN;

    // Phase clock: musical beat when valid, else a slow internal pulse off time
    // (lead-in), so the groove/bob never freezes with no chart.
    const clock = valid ? beat : time * 1.4;
    const drv = valid ? beat : clock; // physics beat driver
    const phase = clock - Math.floor(clock);
    const kick = valid ? Math.exp(-6 * phase) : 0;
    // ---- 1. scheduler: fire hit accents, command footsteps ------------------
    if (chart) this.scheduleChart(beat);
    else if (valid) this.scheduleSynth(beat);

    // ---- 1b. chart-reactive upper-body groove (density lookahead + anticipation)
    this.updateGroove(valid, chart, clock, phase);

    // ---- 2. feet: chart panel targets (locked plants + minJerk/halfSine
    //        swings) + the per-foot mocap→chart-target blend weight -----------
    this.stepFeet(drv, valid, dt);

    // ---- 3. sample the full-body dance mocap for this frame -----------------
    this.sampleMocap(drv, valid, time);

    // ---- 4. reconstruct the 3D skeleton from the mocap, apply the foot-IK
    //        layer, project through the camera, run the hair/cloth springs ----
    this.solve3D(time, s30);

    // ---- 7. paint params -----------------------------------------------------
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

    // ---- 8. emit geometry ---------------------------------------------------
    this.solidPos = 0;
    this.addPos = 0;
    this.emitPad(valid ? beat : NaN); // floor pad, behind/under the dancer — FIRST,
    // so its verts occupy [0, padSolidCount) and can be drawn on their own under
    // the VRM avatar (whose render replaces the procedural body mesh but not the pad).
    this.out.padSolidCount = (this.solidPos / 5) | 0;
    this.out.padAddCount = (this.addPos / 5) | 0;
    this.emitBody();
    const bd = beat - this.hitBeat;
    const burstLife = valid && bd >= 0 && bd < 0.22 && raisesHand(this.hitCols) ? 1 - bd / 0.22 : 0;
    if (burstLife > 0) this.emitBurst(burstLife, bitCount(this.hitCols) >= 2);
    this.out.solidCount = (this.solidPos / 5) | 0;
    this.out.additiveCount = (this.addPos / 5) | 0;
    return this.out;
  }

  // ---- feet (chart-panel targets) --------------------------------------------

  /** Advance each foot's CHART target: hold plant, or run a minJerk horizontal
   *  glide + a half-sine vertical lift over its beat window, landing exactly on
   *  the note beat, always on the pad floor plane. Also eases the per-foot
   *  mocap→chart blend weight (1 while a step owns the foot, FOOT_CHART_REST
   *  between steps, 0 during the chart-less lead-in). */
  private stepFeet(drv: number, valid: boolean, dt: number): void {
    const B = BODY_H;
    const ground = FOOT_Y - L_SHOE * B;
    const blendK = 1 - Math.exp(-dt * FOOT_BLEND_RATE);
    for (let f = 0; f < 2; f++) {
      let x: number;
      let z: number;
      let y: number;
      let owns = false; // a step currently owns this foot (mid-swing)
      if (!valid) {
        // Lead-in: ease plants back to the neutral stance (feet only).
        const k = 1 - Math.exp(-dt * 4);
        const sx0 = CX + (f === 0 ? -1 : 1) * STANCE * B;
        this.plantX[f] += (sx0 - this.plantX[f]) * k;
        this.plantZ[f] += (0 - this.plantZ[f]) * k;
        this.footState[f] = 0;
        x = this.plantX[f];
        z = this.plantZ[f];
        y = ground;
      } else if (this.footState[f] === 1) {
        owns = true;
        const span = Math.max(this.landBeatA[f] - this.liftBeatA[f], 1e-4);
        let tau = (drv - this.liftBeatA[f]) / span;
        if (tau >= 1) {
          // Land: commit the plant, drop back to stance.
          this.plantX[f] = this.toX[f];
          this.plantZ[f] = this.toZ[f];
          this.footState[f] = 0;
          owns = false;
          x = this.plantX[f];
          z = this.plantZ[f];
          y = ground;
        } else {
          tau = tau < 0 ? 0 : tau;
          const mj = minJerk(tau);
          x = this.fromX[f] + (this.toX[f] - this.fromX[f]) * mj;
          z = this.fromZ[f] + (this.toZ[f] - this.fromZ[f]) * mj;
          y = ground - this.liftHA[f] * halfSine(tau);
        }
      } else {
        x = this.plantX[f];
        z = this.plantZ[f];
        y = ground;
      }
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(y)) {
        x = CX + (f === 0 ? -1 : 1) * STANCE * B;
        z = 0;
        y = ground;
      }
      this.footX[f] = x;
      this.footZ[f] = z;
      this.footYv[f] = y;
      // Blend weight: full while a step owns the foot, resting between steps,
      // zero during the chart-less lead-in (pure mocap).
      const target = valid ? (owns ? 1 : FOOT_CHART_REST) : 0;
      let fb = this.footBlend[f];
      if (!Number.isFinite(fb)) fb = target;
      this.footBlend[f] = fb + (target - fb) * blendK;
    }
  }

  // ---- scheduler -------------------------------------------------------------

  /** Record a flash on every pad panel this row steps on (parity feet first,
   *  else the lit column bits) at `beat` — the instant the foot plants. */
  private flashPanels(st: Step, beat: number): void {
    const lp = st.lCol ?? -1;
    const rp = st.rCol ?? -1;
    let any = false;
    if (lp >= 0 && lp <= 3) {
      this.padFlash[lp] = beat;
      any = true;
    }
    if (rp >= 0 && rp <= 3) {
      this.padFlash[rp] = beat;
      any = true;
    }
    if (!any) {
      for (let p = 0; p < 4; p++) if (st.cols & (1 << p)) this.padFlash[p] = beat;
    }
  }

  /** Advance the chart cursors: burst accents on rows that just hit, and
   *  command each move's footstep so it lands exactly on its note beat. */
  private scheduleChart(beat: number): void {
    const steps = this.steps;
    let guard = 0;
    while (this.hitIdx + 1 < steps.length && steps[this.hitIdx + 1].beat <= beat) {
      this.hitIdx++;
      if (++guard <= 32) {
        this.hitBeat = steps[this.hitIdx].beat;
        this.hitCols = steps[this.hitIdx].cols;
        this.flashPanels(steps[this.hitIdx], steps[this.hitIdx].beat);
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
      this.commitStep(st, gap, beat);
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
      this.flashPanels({ beat: ib, cols: this.hitCols }, ib);
    }
    const nb = ib + 1;
    if (this.synthSched < nb) {
      const cols = SYNTH[((nb % 8) + 8) % 8];
      const st: Step = { beat: nb, cols };
      if (nb - beat <= this.windupFor(st, 1)) {
        this.synthSched = nb;
        this.commitStep(st, 1, beat);
      }
    }
  }

  /** Beats of wind-up a row needs before its note beat (the foot-swing window),
   *  clamped shorter by the gap so streams stay crisp. Two-foot rows (jumps) use
   *  the same window — both feet just swing together through the foot-IK. */
  private windupFor(_st: Step, gap: number): number {
    return clamp(Math.min(STEP_SWING_BEATS, gap * 0.85), 0.1, STEP_SWING_BEATS);
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

  /** Command one note row. A two-foot row (jump) swings BOTH feet to their
   *  panels on the beat; a single step swings one foot. The foot-IK layer then
   *  plants them — there is no ballistic jump any more (the mocap has its own
   *  hops). Landing lands exactly on the note beat. */
  private commitStep(st: Step, _gap: number, beat: number): void {
    const lp = st.lCol !== undefined && Number.isFinite(st.lCol) ? Math.trunc(st.lCol) : -1;
    const rp = st.rCol !== undefined && Number.isFinite(st.rCol) ? Math.trunc(st.rCol) : -1;
    const lSteps = lp >= 0 && lp <= 3;
    const rSteps = rp >= 0 && rp <= 3;

    if (this.isJump(st)) {
      // Panels from parity when present; otherwise split the lit columns
      // leftmost→left foot, rightmost→right foot.
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
      this.assignFoot(0, jl, beat, st.beat);
      this.assignFoot(1, jr, beat, st.beat);
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
    this.assignFoot(foot, panel, beat, st.beat);
    this.lastFoot = foot;
  }

  /** Start a foot swinging: origin = wherever the foot is NOW (mid-swing
   *  supersede included), target = its panel spot, landing ON the note beat. */
  private assignFoot(foot: number, panel: number, liftBeat: number, landBeat: number): void {
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
    this.footState[foot] = 1;
    this.liftBeatA[foot] = liftBeat;
    this.landBeatA[foot] = landBeat;
    const dist = Math.hypot(this.pt[0] - x0, this.pt[1] - z0);
    this.liftHA[foot] = clamp(SWING_LIFT * BODY_H + 0.14 * dist, 0.045 * BODY_H, 0.15 * BODY_H);
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

  /** Chart-reactive upper-body groove. Looks AHEAD over the beatmap to gauge how
   *  busy the music is around now (note density → an energy envelope), then drives
   *  a rigid vertical bounce of the torso/arms/head (applied in solve3D): a dip
   *  pulse on each note hit, a small steady on-beat pulse between notes, and an
   *  anticipation coil that rises just before the next note and releases into it.
   *  Amplitude scales with energy, so the clip's calm stretches still groove when
   *  the chart is busy and settle when it rests. Pelvis/legs/feet are untouched. */
  private updateGroove(valid: boolean, chart: boolean, beat: number, phase: number): void {
    if (!valid || !Number.isFinite(beat)) {
      this.grooveDip = 0;
      return;
    }
    // Local note density over a short lookahead window → energy in [0,1].
    let energy: number;
    let nextBeat: number;
    if (chart) {
      const steps = this.steps;
      let i = this.hitIdx + 1;
      nextBeat = i < steps.length ? steps[i].beat : beat + 1;
      let c = 0;
      while (i < steps.length && steps[i].beat < beat + GROOVE_WIN) {
        c++;
        i++;
      }
      energy = clamp(c / GROOVE_WIN / GROOVE_DENSITY_REF, 0, 1);
    } else {
      // Synth attract pattern: ~one note per beat, steady moderate energy.
      nextBeat = Math.floor(beat) + 1;
      energy = 0.6;
    }
    this.energyLP += (energy - this.energyLP) * GROOVE_ENERGY_LP;
    const amp = GROOVE_MIN + (GROOVE_MAX - GROOVE_MIN) * clamp(this.energyLP, 0, 1);
    // Dip: a decaying pulse on every note hit + a steady on-beat pulse so the
    // groove never fully flatlines between sparse notes.
    const bd = Math.max(0, beat - this.hitBeat);
    const hit = Number.isFinite(bd) ? Math.exp(-GROOVE_HIT_K * bd) : 0;
    const pulse = Math.exp(-GROOVE_BEAT_K * phase);
    // Anticipation coil (lookahead): rise as the next note nears, release on hit.
    const toNext = nextBeat - beat;
    const coil = toNext > 0 && toNext < GROOVE_ANTIC ? 1 - toNext / GROOVE_ANTIC : 0;
    const dip = amp * (0.7 * hit + 0.3 * pulse) - amp * GROOVE_ANTIC_AMT * coil * coil;
    this.grooveDip = Number.isFinite(dip) ? dip : 0;
  }

  // ---- 3D skeleton solve --------------------------------------------------------

  private readonly sp4 = new Float64Array(4); // springTail out: px, py, vx, vy

  /** Sample the baked full-body dance clip into `this.md` (49 floats: 15 joint
   *  positions + pelvis motion), interpolated between frames and cross-blended
   *  over the loop seam so the wrap doesn't pop. Advanced by the beat (native
   *  tempo) with a time fallback during the chart-less lead-in. */
  private sampleMocap(drv: number, valid: boolean, time: number): void {
    const S = MOCAP_STRIDE;
    const t = valid ? (drv + MOCAP_PHASE) * MOCAP_FPB : time * 30;
    let fp = t % MOCAP_FRAMES;
    if (!(fp >= 0)) fp += MOCAP_FRAMES;
    if (!(fp >= 0 && fp < MOCAP_FRAMES)) fp = 0;
    const f0 = Math.floor(fp);
    const a = fp - f0;
    const f1 = f0 + 1 >= MOCAP_FRAMES ? 0 : f0 + 1;
    const o0 = f0 * S;
    const o1 = f1 * S;
    const md = this.md;
    for (let k = 0; k < S; k++)
      md[k] = MOCAP_DIRS[o0 + k] + (MOCAP_DIRS[o1 + k] - MOCAP_DIRS[o0 + k]) * a;
    if (fp > MOCAP_FRAMES - MOCAP_SEAM) {
      const w = (fp - (MOCAP_FRAMES - MOCAP_SEAM)) / MOCAP_SEAM;
      for (let k = 0; k < S; k++) md[k] += (MOCAP_DIRS[k] - md[k]) * w;
    }
  }

  /** Reconstruct the WHOLE body from the sampled full-body mocap frame: pelvis
   *  world transform (yaw-damped heading + damped hip sway + grounded so the
   *  lowest foot touches the pad floor), every joint = pelvis + its mocap offset
   *  (L/R crossed), then the foot-IK layer (blend each foot toward its chart
   *  panel target and re-solve the leg with two-bone IK). Then project through
   *  the weak-perspective camera and run the secondary hair/cloth springs. */
  private solve3D(time: number, s30: number): void {
    const B = BODY_H;
    const s3 = this.skel3;
    const md = this.md;
    const moff = this.moff;
    const r = R_HEAD * B; // head radius (used by faceTurn + the hair springs)
    const legPx = (L_THIGH + L_SHIN + L_SHOE) * B; // one leg length in px

    // --- pelvis world transform from the mocap heading -----------------------
    // yaw = damped deviation from the clip's mean heading (keeps her ~facing us).
    const yawRaw = md[45] - MEAN_HEADING;
    const yaw = clamp(Number.isFinite(yawRaw) ? yawRaw * MOCAP_YAW_DAMP : 0, -1.2, 1.2);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    // Frame axes (px per leg-length unit), with the tunable sign flips. y is DOWN
    // so mocap +up maps to screen up via suY = -1. srX/srZ map mocap +right,
    // sfX/sfZ map mocap +fwd (toward the viewer).
    const srX = MOCAP_SR * cy;
    const srZ = MOCAP_SR * -sy;
    const suY = -1;
    const sfX = MOCAP_SF * sy;
    const sfZ = MOCAP_SF * cy;
    // World pelvis-relative offset of every mocap joint (leg-length → px).
    for (let j = 0; j < 15; j++) {
      const rr = md[j * 3];
      const uu = md[j * 3 + 1];
      const ff = md[j * 3 + 2];
      moff[j * 3] = (rr * srX + ff * sfX) * legPx;
      moff[j * 3 + 1] = uu * suY * legPx;
      moff[j * 3 + 2] = (rr * srZ + ff * sfZ) * legPx;
    }

    // Pelvis position: damped horizontal hip sway; grounded so the LOWEST foot
    // sits on the pad floor plane (the bounce comes from the feet/pelvis relative
    // motion, NOT from md[46], so she never floats).
    let pelX = CX + (md[47] - MEAN_HIPX) * legPx * MOCAP_SWAY;
    let pelZ = (md[48] - MEAN_HIPZ) * legPx * MOCAP_SWAY;
    const lowestFootYoff = Math.max(moff[11 * 3 + 1], moff[14 * 3 + 1]); // y DOWN
    let pelY = FOOT_Y - L_SHOE * B - lowestFootYoff;
    // Chart-reactive bounce: sink the WHOLE body toward the pad on the beat (y is
    // DOWN, so +grooveDip lowers the pelvis). The planted feet are pinned to the
    // floor by the foot-IK clamp below, so the knees absorb the dip — a real
    // knee-bend groove, not a torso slouch — and the torso/arms stay upright and
    // undistorted. Applied BEFORE the reach clamp so an anticipation lift (a small
    // pelvis RISE, -grooveDip) that would over-extend a planted leg is corrected.
    const grooveY = (Number.isFinite(this.grooveDip) ? this.grooveDip : 0) * legPx;
    pelY += grooveY;

    // HARD pelvis reach clamp: a planted leg must never over-extend to its chart
    // panel — drop the pelvis (increase pelY) so the worst planted leg reaches.
    const maxR = (L_THIGH + L_SHIN) * B * 0.98;
    for (let f = 0; f < 2; f++) {
      if (this.footState[f] !== 0) continue; // planted legs only
      const mHip = MOCAP_MAP[f === 0 ? HIPL : HIPR];
      const hxx = pelX + moff[mHip * 3];
      const hzz = pelZ + moff[mHip * 3 + 2];
      const dh = Math.hypot(this.footX[f] - hxx, this.footZ[f] - hzz);
      const vs = Math.sqrt(Math.max(0, maxR * maxR - dh * dh));
      const need = this.footYv[f] - vs - moff[mHip * 3 + 1];
      if (Number.isFinite(need) && need > pelY) pelY = need;
    }
    if (!Number.isFinite(pelX)) pelX = CX;
    if (!Number.isFinite(pelY)) pelY = PEL_REST_Y;
    if (!Number.isFinite(pelZ)) pelZ = 0;

    // --- place every skeleton joint = pelvis + its mocap offset (L/R crossed) --
    for (let j = 0; j < JOINTS; j++) {
      const mj = MOCAP_MAP[j];
      if (mj < 0) continue; // pelvis + derived/accessory joints, filled below
      s3[j * 3] = pelX + moff[mj * 3];
      s3[j * 3 + 1] = pelY + moff[mj * 3 + 1];
      s3[j * 3 + 2] = pelZ + moff[mj * 3 + 2];
    }
    s3[PEL * 3] = pelX;
    s3[PEL * 3 + 1] = pelY;
    s3[PEL * 3 + 2] = pelZ;

    // Head-yaw hint for the 2D face features (driven straight from the pelvis
    // yaw — the head joint itself already carries the mocap look).
    this.faceTurn = clamp(Math.sin(yaw) * r * 0.9, -r, r);

    // COLLAR: a bit up the neck from the chest.
    s3[COLLAR * 3] = s3[SH * 3] + (s3[HEADB * 3] - s3[SH * 3]) * 0.3;
    s3[COLLAR * 3 + 1] = s3[SH * 3 + 1] + (s3[HEADB * 3 + 1] - s3[SH * 3 + 1]) * 0.3;
    s3[COLLAR * 3 + 2] = s3[SH * 3 + 2] + (s3[HEADB * 3 + 2] - s3[SH * 3 + 2]) * 0.3;

    // Waist corners: 42% up the pelvis→chest midline, ± a half-width along the
    // hip line, so the torso plates foreshorten with the body yaw through z.
    const wcX = pelX + (s3[SH * 3] - pelX) * 0.42;
    const wcY = pelY + (s3[SH * 3 + 1] - pelY) * 0.42;
    const wcZ = pelZ + (s3[SH * 3 + 2] - pelZ) * 0.42;
    let lx = s3[HIPR * 3] - s3[HIPL * 3];
    let ly = s3[HIPR * 3 + 1] - s3[HIPL * 3 + 1];
    let lz = s3[HIPR * 3 + 2] - s3[HIPL * 3 + 2];
    const ll = Math.hypot(lx, ly, lz) || 1;
    lx /= ll;
    ly /= ll;
    lz /= ll;
    const waistW = 0.05 * B;
    s3[WSTL * 3] = wcX - lx * waistW;
    s3[WSTL * 3 + 1] = wcY - ly * waistW;
    s3[WSTL * 3 + 2] = wcZ - lz * waistW;
    s3[WSTR * 3] = wcX + lx * waistW;
    s3[WSTR * 3 + 1] = wcY + ly * waistW;
    s3[WSTR * 3 + 2] = wcZ + lz * waistW;

    // --- foot-IK layer: blend each foot from its MOCAP position toward the chart
    // panel target, then re-solve the leg with the analytic two-bone IK (law of
    // cosines, forward-dominant knee pole). Hip stays from the mocap; KN/FT are
    // overwritten. A JUMP is just both feet stepping through this layer.
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
      // Blend the mocap ankle toward the chart target by the per-foot weight.
      const w = clamp(this.footBlend[f], 0, 1);
      let tx = s3[ftI * 3] + (this.footX[f] - s3[ftI * 3]) * w;
      // The groove dipped the WHOLE skeleton (pelY += grooveY), including this
      // mocap ankle. Undo that dip on the foot's mocap reference so the feet stay
      // grounded while the hips sink — the knee then absorbs the bounce. Planted
      // feet track the fixed chart target (already bounce-independent); this keeps
      // the idle (low-blend) feet planted on the pad too, instead of riding the
      // body down off the front edge.
      const mFootY = s3[ftI * 3 + 1] - grooveY;
      const ty = mFootY + (this.footYv[f] - mFootY) * w;
      let tz = s3[ftI * 3 + 2] + (this.footZ[f] - s3[ftI * 3 + 2]) * w;
      // Keep a PLANTED foot ON the physical pad. This clip's stances are wider
      // than the pad, so an extreme straddle/lunge would plant a foot past the
      // edge, hanging at pad height over the lower floor (breaks the "on the pad"
      // read). Pull a floor-height target back into the pad rect, weighted by how
      // planted it is (`plant`≈1 near the floor, →0 as it lifts) so a genuine
      // step-out/kick isn't truncated. The 4 step panels sit inside this rect, so
      // chart footwork is untouched; only wide idle mocap stances get reined in.
      const plant = clamp(1 - (FOOT_Y - L_SHOE * B - ty) / (0.22 * B), 0, 1);
      if (plant > 0) {
        const inset = 0.04 * B; // shoe half-length margin so the whole shoe stays on
        const cxl = clamp(tx, CX - 0.36 * B + inset, CX + 0.36 * B - inset);
        const czl = clamp(tz, -0.36 * B + inset, 0.27 * B - inset);
        tx += (cxl - tx) * plant;
        tz += (czl - tz) * plant;
      }
      let dx = tx - hx;
      let dy = ty - hy;
      let dz = tz - hz;
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
      // Soft knees: never lock the chain fully straight (keeps a natural bend
      // and kills the rubber-band pop at full reach).
      const dc = clamp(d, Math.abs(l1 - l2) + 1, (l1 + l2) * 0.94);
      const ca = clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1);
      const sa = Math.sqrt(Math.max(0, 1 - ca * ca));
      // Knee pole: mostly FORWARD (over the toes) with a little outward splay,
      // in the mocap heading frame — never inverts the joint.
      let px = sgn * srX * 0.4 + sfX * 0.78;
      let py = 0;
      let pz = sgn * srZ * 0.4 + sfZ * 0.78;
      const dot = px * nx + py * ny + pz * nz;
      px -= nx * dot;
      py -= ny * dot;
      pz -= nz * dot;
      let pl = Math.sqrt(px * px + py * py + pz * pz);
      if (!(pl > 1e-4)) {
        px = sgn * srX;
        py = 0;
        pz = sgn * srZ;
        pl = Math.hypot(px, pz) || 1;
      }
      px /= pl;
      py /= pl;
      pz /= pl;
      s3[knI * 3] = hx + nx * (l1 * ca) + px * (l1 * sa);
      s3[knI * 3 + 1] = hy + ny * (l1 * ca) + py * (l1 * sa);
      s3[knI * 3 + 2] = hz + nz * (l1 * ca) + pz * (l1 * sa);
      s3[ftI * 3] = hx + nx * dc;
      s3[ftI * 3 + 1] = hy + ny * dc;
      s3[ftI * 3 + 2] = hz + nz * dc;
    }

    // Guard every skel3 value against non-finite (it also feeds the VRM
    // aim-retarget — one NaN would poison it). Fall back to the pelvis.
    for (let j = 0; j < JOINTS; j++) {
      if (
        !Number.isFinite(s3[j * 3]) ||
        !Number.isFinite(s3[j * 3 + 1]) ||
        !Number.isFinite(s3[j * 3 + 2])
      ) {
        s3[j * 3] = pelX;
        s3[j * 3 + 1] = pelY;
        s3[j * 3 + 2] = pelZ;
      }
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

  /** Project a point on the floor plane (world y = FOOT_Y, depth z) through
   *  the same tilted weak-perspective camera as the skeleton. Writes (x,y)
   *  into `out` at `oi`; the perspective divide is clamped so it stays finite. */
  private projFloor(x: number, z: number, out: Float64Array, oi: number): void {
    const zc = clamp(Number.isFinite(z) ? z : 0, -Z_MAX, Z_MAX);
    const s = PERSP_F / (PERSP_F - zc);
    const yy = FOOT_Y + zc * TILT;
    out[oi] = CX + ((Number.isFinite(x) ? x : CX) - CX) * s;
    out[oi + 1] = HORIZON + (yy - HORIZON) * s;
  }

  /** The physical 3D dancepad: a dark slab on the floor plane (world y=FOOT_Y),
   *  spanning the four panels, projected through the same camera as the body,
   *  with a faked front lip for thickness — then a square tile + a chevron arrow
   *  per panel (dim at rest, flashing bright on the beat it is stepped). Drawn
   *  first so the dancer's body and feet layer over it (feet read as ON it). */
  private emitPad(beat: number): void {
    const B = BODY_H;
    const pts = this.padPts;
    const pp = this.padPlat;
    const pa = this.pal.accentA;
    const pb = this.pal.accentB;
    const wht = this.pal.white;
    const gb = this.pal.gradBot;

    // --- platform slab: dark rounded quad spanning the panels ---
    const hw = 0.36 * B; // half width in world x
    const zN = 0.27 * B; // near edge (+z, toward the viewer) — snug past the D arrow
    const zF = -0.36 * B; // far edge (−z) — snug past the U arrow, so she stands ON it
    this.projFloor(CX - hw, zN, pp, 0); // front-left
    this.projFloor(CX + hw, zN, pp, 2); // front-right
    this.projFloor(CX + hw, zF, pp, 4); // back-right
    this.projFloor(CX - hw, zF, pp, 6); // back-left
    const dr = (gb[0] / 255) * 0.55;
    const dg = (gb[1] / 255) * 0.55;
    const dbl = (gb[2] / 255) * 0.55;
    this.solidTri(pp[0], pp[1], pp[2], pp[3], pp[4], pp[5], dr, dg, dbl);
    this.solidTri(pp[0], pp[1], pp[4], pp[5], pp[6], pp[7], dr, dg, dbl);
    // Front lip: extrude the near edge down in screen space (fakes thickness).
    const lip = 0.045 * B;
    this.solidTri(pp[0], pp[1], pp[2], pp[3], pp[2], pp[3] + lip, dr * 0.5, dg * 0.5, dbl * 0.5);
    this.solidTri(
      pp[0],
      pp[1],
      pp[2],
      pp[3] + lip,
      pp[0],
      pp[1] + lip,
      dr * 0.5,
      dg * 0.5,
      dbl * 0.5,
    );
    // Neon rim outline around the slab top — an emissive edge that reads as the
    // deck's lit trim (was near-invisible before).
    const rr = (pb[0] / 255) * 0.42;
    const rg = (pb[1] / 255) * 0.42;
    const rb = (pb[2] / 255) * 0.42;
    this.padEdge(pp[0], pp[1], pp[2], pp[3], 1.1, rr, rg, rb);
    this.padEdge(pp[2], pp[3], pp[4], pp[5], 0.8, rr, rg, rb);
    this.padEdge(pp[4], pp[5], pp[6], pp[7], 0.8, rr, rg, rb);
    this.padEdge(pp[6], pp[7], pp[0], pp[1], 0.8, rr, rg, rb);

    for (let oi = 0; oi < 4; oi++) {
      const panel = PAD_ORDER[oi];
      const cx = PAD_CX[panel];
      const cz = PAD_CZ[panel];
      const pux = PAD_PUX[panel];
      const puz = PAD_PUZ[panel];
      // Perpendicular in the floor plane (rotate the pointing dir 90°).
      const pvx = -puz;
      const pvz = pux;

      // Dark square tile under the arrow (a physical panel on the slab).
      const ts = PAD_HS * 1.16;
      this.projFloor(cx + pux * ts + pvx * ts, cz + puz * ts + pvz * ts, pp, 8);
      this.projFloor(cx - pux * ts + pvx * ts, cz - puz * ts + pvz * ts, pp, 10);
      this.projFloor(cx - pux * ts - pvx * ts, cz - puz * ts - pvz * ts, pp, 12);
      this.projFloor(cx + pux * ts - pvx * ts, cz + puz * ts - pvz * ts, pp, 14);
      const tr = (gb[0] / 255) * 0.9 + 0.02;
      const tg = (gb[1] / 255) * 0.9 + 0.02;
      const tb = (gb[2] / 255) * 0.9 + 0.03;
      this.solidTri(pp[8], pp[9], pp[10], pp[11], pp[12], pp[13], tr, tg, tb);
      this.solidTri(pp[8], pp[9], pp[12], pp[13], pp[14], pp[15], tr, tg, tb);
      // Project the 7 arrow-outline points + centroid (index 7) to screen.
      let mx = 0;
      let my = 0;
      for (let k = 0; k < 7; k++) {
        const u = ARROW_U[k] * PAD_HS;
        const vv = ARROW_V[k] * PAD_HS;
        const fx = cx + pux * u + pvx * vv;
        const fz = cz + puz * u + pvz * vv;
        this.projFloor(fx, fz, pts, k * 2);
        mx += pts[k * 2];
        my += pts[k * 2 + 1];
      }
      pts[14] = mx / 7;
      pts[15] = my / 7;

      // Flash intensity: bright on the step beat, fading over ~a beat.
      const db = Number.isFinite(beat) ? beat - this.padFlash[panel] : 1e9;
      const flash = db >= 0 && db < 1.2 ? Math.exp(-3.2 * db) : 0;

      // Lit fill (additive glow) — a fan from the centroid. Persistently emissive
      // (a neon arrow always glows) and much hotter on the stepped beat, so the
      // pad reads as a lit stage, not a shadow.
      const glow = 0.16 + 1.0 * flash;
      const fr = (lerp(pa[0], wht[0], 0.3 + 0.4 * flash) / 255) * glow;
      const fg = (lerp(pa[1], wht[1], 0.3 + 0.4 * flash) / 255) * glow;
      const fb = (lerp(pa[2], wht[2], 0.3 + 0.4 * flash) / 255) * glow;
      for (let k = 0; k < 7; k++) {
        const n = (k + 1) % 7;
        this.addTri(
          pts[14],
          pts[15],
          pts[k * 2],
          pts[k * 2 + 1],
          pts[n * 2],
          pts[n * 2 + 1],
          fr,
          fg,
          fb,
        );
      }

      // Outline: neon floor line at rest, ramping to hot white on flash.
      const baseI = 0.34 + 0.85 * flash;
      const oc0 = pb;
      const or = (lerp(oc0[0], wht[0], flash) / 255) * baseI;
      const og = (lerp(oc0[1], wht[1], flash) / 255) * baseI;
      const ob = (lerp(oc0[2], wht[2], flash) / 255) * baseI;
      const hw = 0.7 + 1.6 * flash;
      for (let k = 0; k < 7; k++) {
        const n = (k + 1) % 7;
        this.padEdge(pts[k * 2], pts[k * 2 + 1], pts[n * 2], pts[n * 2 + 1], hw, or, og, ob);
      }
    }
  }

  /** One thick additive line segment (a mitred quad) for the pad outline. */
  private padEdge(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    hw: number,
    r: number,
    g: number,
    b: number,
  ): void {
    let dx = bx - ax;
    let dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) return;
    dx /= len;
    dy /= len;
    const px = -dy * hw;
    const py = dx * hw;
    const a0x = ax - dx * hw;
    const a0y = ay - dy * hw;
    const b0x = bx + dx * hw;
    const b0y = by + dy * hw;
    this.addTri(a0x + px, a0y + py, b0x + px, b0y + py, b0x - px, b0y - py, r, g, b);
    this.addTri(a0x + px, a0y + py, b0x - px, b0y - py, a0x - px, a0y - py, r, g, b);
  }

  /** Hysteretic far/near decision for two limbs by their depth (z, larger =
   *  nearer the viewer). Returns true when the LEFT limb is the far one. Only
   *  flips once one side is clearly further than the other (by DEPTH_EPS);
   *  within the band it keeps the previous choice, so near-coplanar limbs get
   *  a fixed, non-flickering draw order. NaN-safe. */
  private stableFar(prev: boolean, zLeft: number, zRight: number): boolean {
    const DEPTH_EPS = 2.5; // z units (~px); wider than per-frame float jitter
    if (!Number.isFinite(zLeft) || !Number.isFinite(zRight)) return prev;
    if (zLeft < zRight - DEPTH_EPS) return true; // left clearly further ⇒ far
    if (zLeft > zRight + DEPTH_EPS) return false; // left clearly nearer
    return prev; // ambiguous ⇒ hold the last order (no flip)
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

    // Depth ordering from the 3D solve: far limbs draw first, near last. The
    // FAR/near decision is HYSTERETIC (stableFar): it only flips once one side
    // is clearly nearer than the other, so equal-depth limbs (a symmetric
    // straddle, the idle groove) never swap order frame-to-frame and flicker.
    this.armFarLeft = this.stableFar(
      this.armFarLeft,
      this.skel3[HAL * 3 + 2],
      this.skel3[HAR * 3 + 2],
    );
    // Legs use the COMMITTED foot-target depth (footZ), not the IK-derived
    // ankle z, which wobbles a hair with pelvis depth — so a locked straddle
    // (both feet z=0) stays a dead-stable tie and never reorders.
    this.legFarLeft = this.stableFar(this.legFarLeft, this.footZ[0], this.footZ[1]);
    const leftArmFar = this.armFarLeft;
    const leftLegFar = this.legFarLeft;

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
    // Thigh bottom and shin top share the SAME width (0.03) at the knee, so
    // the skin thigh and the boot meet flush there — one continuous limb, no
    // step/gap. The knee-high boot (ZTRIM) runs from the knee down.
    this.emitLimb(hip, kn, 0.04, 0.03, ZSKIN, true);
    this.emitLimb(kn, ft, 0.03, 0.014, ZTRIM, true);
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
