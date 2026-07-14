/**
 * AttractDancer — the low-poly anime-girl dancer, driven by a physically
 * grounded motion core. It is a pure-CPU triangle-mesh generator for the GPU
 * pipeline: build(time, beat) refills two reused vertex buffers (x, y, r, g, b
 * per vertex, triangle list, 960x540 design space, y down) — `solid` holds the
 * opaque flat-shaded body facets, `additive` holds the neon silhouette edges,
 * rim-glow and hand-burst spikes.
 *
 * MOTION MODEL (first principles, not authored angle curves):
 *
 *  1. CENTRE OF MASS is the character. A weighted body carries momentum, so
 *     every visible motion is the shadow of the CoM plus a family of CLOSED-FORM
 *     springs — nothing is numerically integrated, so a 0.1s hitch or a tempo
 *     warp can never blow the state up. Physics runs in SECONDS; the chart runs
 *     in BEATS. A low-passed `bps` converts between them, so height/hang emerge
 *     from tempo rather than being keyed.
 *
 *  2. LATERAL / DEPTH CoM is an UNDER-damped spring (it overshoots = the vault
 *     read) chasing an anticipatory support-weight target: as a foot swings the
 *     weight commits onto the standing leg, scaled by the step gap so fast
 *     same-side steps become taps. VERTICAL CoM is a critically-damped bob into
 *     each beat. A JUMP swaps both for an analytic ballistic parabola seeded
 *     continuously from the spring state at takeoff; the fall speed is fed back
 *     into the landing spring as its initial velocity, so the squash emerges.
 *
 *  3. FEET are a tiny per-foot state machine (stance / swing). A swing is a
 *     minimum-jerk horizontal glide + half-sine vertical lift over a beat
 *     window that lands exactly on the note beat, on the exact StepParity panel
 *     (crossovers included). Jumps swing both feet and tuck the knees in flight.
 *
 *  4. LEGS keep an analytic two-bone IK (law of cosines, crossover-aware knee
 *     pole, soft knee floor) onto the animated ankle; a HARD pelvis-reach clamp
 *     drops the pelvis so the worst planted leg always stays reachable.
 *
 *  5. TORSO leans into the CoM's lateral acceleration (≈atan(aₓ/G)) and pitches
 *     with forward accel; the shoulder line counter-twists against pelvis yaw.
 *     ARMS are a sparse accent vocabulary (scalar set-points chosen by the
 *     scheduler) plus a staggered shoulder→elbow→forearm spring chain for
 *     follow-through, driven primarily by the contralateral leg phase, with a
 *     between-steps groove orbit so they never dangle. HEAD is a damped look +
 *     beat nod + slight counter to the torso.
 *
 *  6. SECONDARY MOTION — twin-tails, ahoge and skirt hem — ride simple damped
 *     springs layered after the body solve (standard cloth/hair smoothing).
 *
 * With no chart the scheduler synthesizes an 8-beat L/D/R/U(+jump) pattern;
 * with no beat (NaN/negative lead-in) the phase clock runs off `time`.
 * Everything is deterministic (no Math.random / Date.now) and framerate-
 * independent (closed-form springs, dt clamped ≤ 0.1s); nothing allocates per
 * frame, and every emitted value is guarded against non-finite (skel3 also
 * feeds the VRM aim-retarget — a single NaN would poison it).
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

// ---- physics tunables --------------------------------------------------------
// Lengths in design px, time in SECONDS. The chart schedule is in beats; a
// low-passed `bps` (this.bps) converts. These are the knobs to tune the feel.

/** Gravity, px/s². Jump apex h = G·T²/8 emerges from the airtime T, so this
 *  sets how a jump reads at a given tempo (bigger G ⇒ snappier, lower hang). */
const G = 2000;

/** CoM lateral (x) "vault" spring: under-damped so the weight OVERSHOOTS the
 *  support foot a few px each step — the read that sells the weight transfer. */
const COM_OMEGA = 12; // rad/s
const COM_ZETA = 0.62; // <1 ⇒ overshoot
/** CoM depth (z) spring: softer, so U/D steps read as a pitch lean + hip list
 *  rather than a hard slide toward/away from the camera. */
const COM_OMEGA_Z = 10;
const COM_ZETA_Z = 0.72;

/** Critically-damped spring half-lives (s). Staggered down the arm so the
 *  shoulder leads, the elbow trails and the forearm whips in last = a limp,
 *  weighted follow-through instead of one rigid unit arriving at once. */
const HL_BOB = 0.09; // vertical beat bob
const HL_LEAN = 0.1;
const HL_PITCH = 0.12;
const HL_YAW = 0.14;
const HL_TWIST = 0.12;
const HL_SIDE = 0.14;
const HL_LIST = 0.1;
const HL_HEAD = 0.12; // head look / nod / roll
const HL_ARM_SH = 0.09; // shoulder (abduction + swing)
const HL_ARM_EL = 0.15; // elbow bend (trails the shoulder)
const HL_ARM_FA = 0.26; // forearm fold (softest, whips in last — ~80ms drag)
/** Hard minimum elbow flex (rad, ~25°): a human elbow never locks straight —
 *  even a full reach keeps this much bend, which kills the ramrod-plank look. */
const ELBOW_FLOOR = 0.44;

/** Local tempo tracking: bps = lowpass(Δbeat/Δt), clamped to a sane band. */
const BPS_LP = 0.12;
const BPS_MIN = 0.5;
const BPS_MAX = 8;

/** Foot-swing window (beats), clamped shorter by the gap to the next note so
 *  fast streams stay crisp. A step lands exactly on its note beat. */
const STEP_SWING_BEATS = 0.42;
/** Jump budget (beats): a load crouch, then the airtime, landing on the beat.
 *  Airtime drives apex height physically (h = G·T²/8), so it must be long enough
 *  to read: ~1.1 beats ≈ 0.5s at 128 BPM → ~60px apex (vs a 0.5-beat twitch that
 *  barely left the floor). Dense charts compress it via windupFor, so fast songs
 *  naturally become quick low hops — correct. */
const JUMP_LOAD_BEATS = 0.24;
const JUMP_AIR_BEATS = 1.1;

/** Arm accent vocabulary. Each row is a set-point [abduction, fwd, elbow,
 *  forearm-fold] for the accent arm; the scheduler fires one by context and the
 *  staggered spring chain turns it into a weighted, following gesture. Values
 *  live inside the FK clamp ranges (abd -0.6..3.3, fwd -1.2..1.2, elb -0.5..2.6,
 *  lof -1.2..1.6). Index 0 is the resting groove pose. */
const ACC_REST = 0;
const ACC_PUNCH = 1; // downbeat fist punch up in front
const ACC_FLARE = 2; // jump: arms fling open into an X
const ACC_SKY = 3; // overhead reach (Up panel)
const ACC_SIDE = 4; // reach out along the step line (L/R)
const ACC_CROSS = 5; // arm pulls across the chest (crossover)
const ACC_DRIVE = 6; // punch down past the hip (Down stomp)
const ACC_LEAD = 7; // flexed-elbow victory pump overhead
const N_ACC = 8;
// prettier-ignore
// Arm accent set-points [abduction, forward, elbow-flex, forearm-fold], radians.
// Every entry keeps a BENT elbow (≥~0.8) and caps abduction near horizontal for
// the everyday poses — a locked, ramrod-straight side-arm reads robotic, so the
// only near-overhead reaches (sky) are reserved for rare Up/jump accents. The
// staggered spring chain turns these set-points into weighted follow-through.
const ACCENTS = new Float32Array([
  0.26, 0.14, 1.0, 0.35, // 0 rest — relaxed bent hang, hand near the hip
  0.45, 0.38, 1.55, 0.28, // 1 punch — bent fist up in front
  0.85, 0.12, 1.05, 0.22, // 2 flare — open, capped ~49° with a bent elbow
  2.15, 0.14, 0.9, 0.16, // 3 sky — overhead reach, elbow bent (rare: Up / jump)
  0.7, 0.22, 1.25, 0.2, // 4 side — reach along the step line, ELBOW BENT (no ramrod)
  0.55, -0.35, 1.3, 0.12, // 5 cross-body — bent pull across the chest
  0.24, -0.3, 0.9, 0.06, // 6 low drive — low bent pump past the hip
  1.0, 0.2, 1.45, 0.18, // 7 lead pump — bent-elbow runner/victory pump
]);

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

// ---- CoM rest geometry (derived from the proportions) -----------------------

/** Rest CoM height (px, y DOWN): the pelvis when standing on both feet. */
const REST_COM_Y = FOOT_Y - (L_THIGH + L_SHIN + L_SHOE) * BODY_H * 0.985;
/** Rest hip→ankle vertical span — feet hang this far below the pelvis; a jump
 *  keeps that (feet rise WITH the body) and the tuck subtracts from it. */
const HANG0 = FOOT_Y - L_SHOE * BODY_H - REST_COM_Y;
/** Beat-bob depth (px): the CoM sinks this much INTO each count. */
const BOB_AMP = 0.03 * BODY_H;
/** Pre-takeoff load crouch depth (px). */
const JUMP_LOAD = 0.11 * BODY_H;
/** Base foot swing clearance + in-flight knee tuck (fractions of BODY_H). The
 *  swing clearance gives a visible passing pose (foot lifts + knee flexes) so a
 *  step reads as lift-and-plant, not a slide; the tuck pulls the feet up under
 *  the body at the jump apex so knees bend in the air. */
const SWING_LIFT = 0.07;
const JUMP_TUCK = 0.28;

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
  private readonly sp2 = new Float64Array(2); // spring stepper out: [x, v]

  // ---- timing / tempo ----
  private lastTime = NaN;
  private prevBeat = NaN;
  private bps = 2; // low-passed beats-per-second

  // ---- centre of mass (the weight). Design px, y DOWN so gravity is +y. ----
  private comX = CX;
  private comY = REST_COM_Y;
  private comZ = 0;
  private comVX = 0;
  private comVY = 0;
  private comVZ = 0;
  private goalX = CX; // this frame's support-weight target (lateral, depth)
  private goalZ = 0;
  private wbias = 0; // signed lateral weight bias in [-1,1] (+ = screen-right)

  // ---- jump (ballistic regime) ----
  private airborne = false;
  private jpPending = false; // scheduled, not yet taken off
  private jpTakeoff = -1e9; // beats
  private jpLand = -1e9;
  private jpJl = 0; // panel each foot lands on
  private jpJr = 3;
  private jT = 0.3; // airtime (s), set at takeoff
  private jY0 = REST_COM_Y; // takeoff CoM state (continuous seed)
  private jVY0 = 0;
  private jX0 = CX;
  private jZ0 = 0;
  private jVX0 = 0;
  private jVZ0 = 0;

  // ---- torso / head pose springs (each a critically-damped scalar) ----
  private sLean = 0;
  private sLeanV = 0;
  private sPitch = 0;
  private sPitchV = 0;
  private sYaw = 0; // pelvis yaw
  private sYawV = 0;
  private sTwist = 0; // shoulder yaw vs pelvis
  private sTwistV = 0;
  private sSide = 0; // ribcage side-shift (contrapposto)
  private sSideV = 0;
  private sList = 0; // pelvic list (support hip hikes)
  private sListV = 0;
  private sHyaw = 0;
  private sHyawV = 0;
  private sHpit = 0;
  private sHpitV = 0;
  private sHroll = 0;
  private sHrollV = 0;
  private faceLook = 0; // decaying gaze target toward the last step panel

  // ---- arms: staggered shoulder→elbow→forearm spring chain, per foot side ----
  private readonly armAbd = new Float64Array(2);
  private readonly armAbdV = new Float64Array(2);
  private readonly armFwd = new Float64Array(2);
  private readonly armFwdV = new Float64Array(2);
  private readonly armElb = new Float64Array(2);
  private readonly armElbV = new Float64Array(2);
  private readonly armLof = new Float64Array(2);
  private readonly armLofV = new Float64Array(2);

  // ---- one live arm accent (latest wins) ----
  private accActive = false;
  private accArm = 2; // 0 = left, 1 = right, 2 = both
  private accIdx = ACC_REST;
  private accBeat = -1e9; // impact beat
  private accWindup = 0.3; // rise time (beats) before impact

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
  private curGapSec = 1; // gap of the active step (scales the weight transfer)
  private lastFoot = 1; // which foot stepped last (U/D alternation)
  private stepAlt = 0; // accent styling alternator
  private stepCount = 0; // total single steps committed (accent-firing gate)

  // ---- chart cursors ----
  private hitIdx = -1; // last step whose beat has passed (burst accents)
  private schedIdx = -1; // last step whose swing has been commanded
  private synthHit = -1e9; // chart-less mode bookkeeping
  private synthSched = -1e9;

  // ---- accents fired by note hits (bursts + glow only, not body pose) ----
  private hitBeat = -1e9;
  private hitCols = 0;

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

  /** Reset the whole physics state to a neutral two-foot stance (seek/rewind,
   *  and construction). Springs settle, CoM parks over the feet, feet plant. */
  private resetPhysics(): void {
    const B = BODY_H;
    this.bps = 2;
    this.airborne = false;
    this.jpPending = false;
    this.jpTakeoff = -1e9;
    this.jpLand = -1e9;
    this.jpJl = 0;
    this.jpJr = 3;
    this.jT = 0.3;
    this.jY0 = REST_COM_Y;
    this.jVY0 = 0;
    this.jX0 = CX;
    this.jZ0 = 0;
    this.jVX0 = 0;
    this.jVZ0 = 0;
    this.comX = CX;
    this.comY = REST_COM_Y;
    this.comZ = 0;
    this.comVX = 0;
    this.comVY = 0;
    this.comVZ = 0;
    this.goalX = CX;
    this.goalZ = 0;
    this.wbias = 0;
    this.curGapSec = 1;
    this.faceLook = 0;
    this.sLean = this.sLeanV = 0;
    this.sPitch = this.sPitchV = 0;
    this.sYaw = this.sYawV = 0;
    this.sTwist = this.sTwistV = 0;
    this.sSide = this.sSideV = 0;
    this.sList = this.sListV = 0;
    this.sHyaw = this.sHyawV = 0;
    this.sHpit = this.sHpitV = 0;
    this.sHroll = this.sHrollV = 0;
    this.accActive = false;
    this.accArm = 2;
    this.accIdx = ACC_REST;
    this.accBeat = -1e9;
    this.accWindup = 0.3;
    for (let f = 0; f < 2; f++) {
      this.armAbd[f] = 0.3;
      this.armAbdV[f] = 0;
      this.armFwd[f] = 0.1;
      this.armFwdV[f] = 0;
      this.armElb[f] = 0.55;
      this.armElbV[f] = 0;
      this.armLof[f] = 0.35;
      this.armLofV[f] = 0;
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
    this.stepAlt = 0;
    this.stepCount = 0;
    this.lastFoot = 1;
    this.armFarLeft = true;
    this.legFarLeft = true;
    this.resetPhysics();
  }

  // ---- closed-form spring steppers (stable at ANY dt) ------------------------

  /** Holden exact critically-damped spring. Steps (x, v) toward (goal, goalV)
   *  over dt with the given half-life; writes [x', v'] into sp2. No overshoot,
   *  unconditionally stable, framerate-independent. NaN ⇒ snap to goal. */
  private critStep(
    x: number,
    v: number,
    goal: number,
    goalV: number,
    halflife: number,
    dt: number,
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(v)) {
      x = goal;
      v = 0;
    }
    const d = (4 * 0.6931471805599453) / (halflife + 1e-5); // 4 ln2 / halflife
    const c = goal + (4 * goalV) / d;
    const y = d * 0.5;
    const j0 = x - c;
    const j1 = v + j0 * y;
    const e = Math.exp(-y * dt);
    let nx = e * (j0 + j1 * dt) + c;
    let nv = e * (v - j1 * y * dt);
    if (!Number.isFinite(nx)) {
      nx = goal;
      nv = 0;
    }
    if (!Number.isFinite(nv)) nv = 0;
    this.sp2[0] = nx;
    this.sp2[1] = nv;
  }

  /** Exact UNDER-damped spring (ζ<1) toward a stationary goal — the CoM vault
   *  wants a little overshoot. Closed-form (sin/cos of the damped frequency),
   *  stable at any dt; writes [x', v'] into sp2. NaN ⇒ snap. */
  private underStep(
    x: number,
    v: number,
    goal: number,
    omega: number,
    zeta: number,
    dt: number,
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(v)) {
      x = goal;
      v = 0;
    }
    const z = clamp(zeta, 0.05, 0.999);
    const wd = omega * Math.sqrt(1 - z * z);
    const e = Math.exp(-z * omega * dt);
    const cw = Math.cos(wd * dt);
    const sw = Math.sin(wd * dt);
    const dsp = x - goal;
    const bC = (v + z * omega * dsp) / wd;
    let nx = goal + e * (dsp * cw + bC * sw);
    let nv = e * (v * cw - (z * omega * bC + wd * dsp) * sw);
    if (!Number.isFinite(nx)) {
      nx = goal;
      nv = 0;
    }
    if (!Number.isFinite(nv)) nv = 0;
    this.sp2[0] = nx;
    this.sp2[1] = nv;
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
    const bop = 0.5 + 0.5 * Math.cos(phase * Math.PI * 2); // 1 ON the count
    const lfo = Math.sin(clock * Math.PI); // 2-beat side-to-side cycle

    // ---- 1. scheduler: fire hit accents, command footsteps / jumps ----------
    if (chart) this.scheduleChart(beat);
    else if (valid) this.scheduleSynth(beat);

    // ---- 2. jump regime transitions (takeoff / land) ------------------------
    if (this.jpPending && !this.airborne && drv >= this.jpTakeoff) this.takeoff();
    if (this.airborne && drv >= this.jpLand) this.land();

    // ---- 3. CoM: closed-form springs (grounded) or ballistic (airborne) -----
    this.stepCoM(drv, valid, dt, bop);

    // ---- 4. feet: locked plants + minJerk/halfSine swings -------------------
    this.stepFeet(drv, valid, dt);

    // ---- 5. torso / head / arm goal springs ---------------------------------
    this.stepPose(dt, bop);
    this.stepArms(drv, dt, bop, lfo);

    // ---- 6. solve the 3D skeleton (FK + two-bone leg IK), project -----------
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
    this.emitPad(valid ? beat : NaN); // floor pad, behind/under the dancer
    this.emitBody();
    const bd = beat - this.hitBeat;
    const burstLife = valid && bd >= 0 && bd < 0.22 && raisesHand(this.hitCols) ? 1 - bd / 0.22 : 0;
    if (burstLife > 0) this.emitBurst(burstLife, bitCount(this.hitCols) >= 2);
    this.out.solidCount = (this.solidPos / 5) | 0;
    this.out.additiveCount = (this.addPos / 5) | 0;
    return this.out;
  }

  // ---- centre of mass --------------------------------------------------------

  /** Grounded: lateral/depth = under-damped springs toward the anticipatory
   *  support-weight target; vertical = a critically-damped bob into each beat
   *  (+ a pre-jump load crouch). Airborne: an analytic parabola seeded from the
   *  spring state at takeoff, so position AND velocity stay continuous. */
  private stepCoM(drv: number, valid: boolean, dt: number, bop: number): void {
    const B = BODY_H;
    if (this.airborne) {
      const span = Math.max(this.jpLand - this.jpTakeoff, 1e-4);
      const frac = clamp((drv - this.jpTakeoff) / span, 0, 1);
      const tau = frac * this.jT; // seconds into the flight
      this.comY = this.jY0 + this.jVY0 * tau + 0.5 * G * tau * tau;
      this.comX = this.jX0 + this.jVX0 * tau;
      this.comZ = this.jZ0 + this.jVZ0 * tau;
      this.comVY = this.jVY0 + G * tau;
      this.comVX = this.jVX0;
      this.comVZ = this.jVZ0;
    } else {
      this.weightTarget(drv);
      this.underStep(this.comX, this.comVX, this.goalX, COM_OMEGA, COM_ZETA, dt);
      this.comX = this.sp2[0];
      this.comVX = this.sp2[1];
      this.underStep(this.comZ, this.comVZ, this.goalZ, COM_OMEGA_Z, COM_ZETA_Z, dt);
      this.comZ = this.sp2[0];
      this.comVZ = this.sp2[1];
      // Vertical bob toward a phase goal (sink ON the count), + a load crouch
      // during the pre-takeoff windup of a pending jump.
      let goalY = REST_COM_Y + BOB_AMP * bop;
      if (this.jpPending && drv < this.jpTakeoff) {
        const w = this.jpTakeoff - JUMP_LOAD_BEATS;
        goalY += JUMP_LOAD * smooth01((drv - w) / Math.max(JUMP_LOAD_BEATS, 1e-3));
      }
      this.critStep(this.comY, this.comVY, goalY, 0, HL_BOB, dt);
      this.comY = this.sp2[0];
      this.comVY = this.sp2[1];
    }
    if (!valid) {
      // Lead-in: ease the CoM back toward the neutral centre.
      const k = 1 - Math.exp(-dt * 4);
      this.comX += (CX - this.comX) * k;
      this.comZ += (0 - this.comZ) * k;
    }
    if (!Number.isFinite(this.comX)) {
      this.comX = CX;
      this.comVX = 0;
    }
    if (!Number.isFinite(this.comY)) {
      this.comY = REST_COM_Y;
      this.comVY = 0;
    }
    if (!Number.isFinite(this.comZ)) {
      this.comZ = 0;
      this.comVZ = 0;
    }
    // Signed lateral weight bias for the torso list / contrapposto.
    this.wbias = clamp((this.comX - CX) / (0.14 * B), -1, 1);
  }

  /** The anticipatory support-weight target: a convex blend of the feet, with a
   *  swinging foot UNLOADED (weight on the standing leg) and anticipating its
   *  landing spot. The deviation from the plain midpoint is scaled by the step
   *  gap, so fast same-side steps barely shift the weight (taps). */
  private weightTarget(drv: number): void {
    let sumw = 0;
    let tx = 0;
    let tz = 0;
    let mx = 0;
    let mz = 0;
    for (let f = 0; f < 2; f++) {
      let px: number;
      let pz: number;
      let load: number;
      if (this.footState[f] === 1) {
        const span = Math.max(this.landBeatA[f] - this.liftBeatA[f], 1e-4);
        const tau = clamp((drv - this.liftBeatA[f]) / span, 0, 1);
        px = this.toX[f]; // anticipate the landing spot
        pz = this.toZ[f];
        load = 0.1 + 0.9 * smooth01((tau - 0.7) / 0.3); // nearly weightless, reloads late
      } else {
        px = this.plantX[f];
        pz = this.plantZ[f];
        load = 1;
      }
      tx += load * px;
      tz += load * pz;
      sumw += load;
      mx += px;
      mz += pz;
    }
    mx *= 0.5;
    mz *= 0.5;
    const rawX = sumw > 1e-6 ? tx / sumw : mx;
    const rawZ = sumw > 1e-6 ? tz / sumw : mz;
    // Commit HARD over the support foot (overshoot the load-weighted centroid by
    // ~30%) so the hips visibly stack over the standing leg — a real contrapposto,
    // not a hover at the midpoint. Scaled by gap so fast same-side steps stay taps.
    const wShift = clamp(this.curGapSec / 0.4, 0.3, 1) * 1.3;
    let gx = mx + (rawX - mx) * wShift;
    let gz = mz + (rawZ - mz) * wShift;
    if (!Number.isFinite(gx)) gx = CX;
    if (!Number.isFinite(gz)) gz = 0;
    this.goalX = gx;
    this.goalZ = gz;
  }

  // ---- feet ------------------------------------------------------------------

  /** Advance each foot: hold plant, or run a minJerk horizontal glide + a
   *  half-sine vertical lift over its beat window, landing exactly on the note
   *  beat. Airborne feet rise with the CoM and tuck (knees bend in flight). */
  private stepFeet(drv: number, valid: boolean, dt: number): void {
    const B = BODY_H;
    for (let f = 0; f < 2; f++) {
      let x: number;
      let z: number;
      let y: number;
      if (!valid) {
        // Lead-in: ease plants back to the neutral stance (feet only).
        const k = 1 - Math.exp(-dt * 4);
        const sx0 = CX + (f === 0 ? -1 : 1) * STANCE * B;
        this.plantX[f] += (sx0 - this.plantX[f]) * k;
        this.plantZ[f] += (0 - this.plantZ[f]) * k;
        this.footState[f] = 0;
        x = this.plantX[f];
        z = this.plantZ[f];
        y = FOOT_Y - L_SHOE * B;
      } else if (this.footState[f] === 1) {
        const span = Math.max(this.landBeatA[f] - this.liftBeatA[f], 1e-4);
        let tau = (drv - this.liftBeatA[f]) / span;
        if (tau >= 1) {
          // Land: commit the plant, drop back to stance.
          this.plantX[f] = this.toX[f];
          this.plantZ[f] = this.toZ[f];
          this.footState[f] = 0;
          x = this.plantX[f];
          z = this.plantZ[f];
          y = this.airborne ? this.comY + HANG0 : FOOT_Y - L_SHOE * B;
        } else {
          tau = tau < 0 ? 0 : tau;
          const mj = minJerk(tau);
          x = this.fromX[f] + (this.toX[f] - this.fromX[f]) * mj;
          z = this.fromZ[f] + (this.toZ[f] - this.fromZ[f]) * mj;
          if (this.airborne) {
            // Feet hang HANG0 below the (rising) CoM, tucked by the lift arc.
            y = this.comY + HANG0 - this.liftHA[f] * halfSine(tau);
          } else {
            y = FOOT_Y - L_SHOE * B - this.liftHA[f] * halfSine(tau);
          }
        }
      } else {
        x = this.plantX[f];
        z = this.plantZ[f];
        y = this.airborne ? this.comY + HANG0 : FOOT_Y - L_SHOE * B;
      }
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(y)) {
        x = CX + (f === 0 ? -1 : 1) * STANCE * B;
        z = 0;
        y = FOOT_Y - L_SHOE * B;
      }
      this.footX[f] = x;
      this.footZ[f] = z;
      this.footYv[f] = y;
    }
  }

  // ---- torso / head pose -----------------------------------------------------

  /** Lean into the CoM's lateral acceleration (≈atan(aₓ/G) — the exact physics
   *  of ground reaction through the CoM), pitch with forward accel + a beat dip,
   *  yaw the hips into the travel and counter-twist the shoulders, list onto the
   *  support hip. Head: damped look + beat nod + counter-roll. All critically
   *  damped so they trail the CoM with weight, never snap. */
  private stepPose(dt: number, bop: number): void {
    // Analytic spring accelerations (goalV = 0): a = -ω²·disp - 2ζω·v.
    const ax =
      -COM_OMEGA * COM_OMEGA * (this.comX - this.goalX) - 2 * COM_ZETA * COM_OMEGA * this.comVX;
    const az =
      -COM_OMEGA_Z * COM_OMEGA_Z * (this.comZ - this.goalZ) -
      2 * COM_ZETA_Z * COM_OMEGA_Z * this.comVZ;

    const leanGoal = this.airborne ? 0 : clamp(Math.atan2(ax, G) * 0.55, -0.34, 0.34);
    const pitchGoal = clamp(
      (this.airborne ? 0 : Math.atan2(az, G) * 0.5) + 0.03 * bop - 0.012,
      -0.28,
      0.4,
    );
    const yawGoal = this.airborne ? 0 : clamp(this.comVX * 0.0016, -0.28, 0.28);
    // Held contrapposto from the weight bias (posture, not the transient
    // accel-lean): support hip hikes / free hip drops, ribcage counters into an
    // S-curve, shoulders counter-twist. Bigger gains so weight COMMITMENT reads.
    const twistGoal = clamp(-this.sYaw * 0.6 - this.wbias * 0.16, -0.5, 0.5);
    const sideGoal = clamp(-this.wbias * 0.024, -0.09, 0.09);
    const listGoal = clamp(this.wbias * 0.09, -0.12, 0.12);

    // Gaze decays back to centre between steps.
    this.faceLook *= Math.pow(0.5, dt / 0.4);
    const hyawGoal = clamp(this.faceLook - this.sYaw * 0.3, -0.5, 0.5);
    const hpitGoal = clamp(0.05 * bop - 0.02 + (this.airborne ? -0.08 : 0), -0.4, 0.4);
    const hrollGoal = clamp(-this.sLean * 0.5, -0.4, 0.4);

    this.critStep(this.sLean, this.sLeanV, leanGoal, 0, HL_LEAN, dt);
    this.sLean = this.sp2[0];
    this.sLeanV = this.sp2[1];
    this.critStep(this.sPitch, this.sPitchV, pitchGoal, 0, HL_PITCH, dt);
    this.sPitch = this.sp2[0];
    this.sPitchV = this.sp2[1];
    this.critStep(this.sYaw, this.sYawV, yawGoal, 0, HL_YAW, dt);
    this.sYaw = this.sp2[0];
    this.sYawV = this.sp2[1];
    this.critStep(this.sTwist, this.sTwistV, twistGoal, 0, HL_TWIST, dt);
    this.sTwist = this.sp2[0];
    this.sTwistV = this.sp2[1];
    this.critStep(this.sSide, this.sSideV, sideGoal, 0, HL_SIDE, dt);
    this.sSide = this.sp2[0];
    this.sSideV = this.sp2[1];
    this.critStep(this.sList, this.sListV, listGoal, 0, HL_LIST, dt);
    this.sList = this.sp2[0];
    this.sListV = this.sp2[1];
    this.critStep(this.sHyaw, this.sHyawV, hyawGoal, 0, HL_HEAD, dt);
    this.sHyaw = this.sp2[0];
    this.sHyawV = this.sp2[1];
    this.critStep(this.sHpit, this.sHpitV, hpitGoal, 0, HL_HEAD, dt);
    this.sHpit = this.sp2[0];
    this.sHpitV = this.sp2[1];
    this.critStep(this.sHroll, this.sHrollV, hrollGoal, 0, HL_HEAD, dt);
    this.sHroll = this.sp2[0];
    this.sHrollV = this.sp2[1];
  }

  // ---- arms ------------------------------------------------------------------

  /** Per-arm goal = a between-steps groove orbit + a contralateral leg-phase
   *  counterswing (arm f swings with the OPPOSITE leg's swing) + the live accent
   *  set-point (blended by an envelope). A staggered shoulder→elbow→forearm
   *  spring chain then produces the weighted follow-through. */
  private stepArms(drv: number, dt: number, bop: number, lfo: number): void {
    // Accent envelope: rise to impact, then decay (follow-through lives in the
    // springs, not here).
    let e = 0;
    if (this.accActive) {
      if (drv < this.accBeat) {
        e = smooth01((drv - (this.accBeat - this.accWindup)) / Math.max(this.accWindup, 1e-3));
      } else {
        const dd = drv - this.accBeat;
        e = Math.exp(-2.6 * dd);
        if (dd > 1.6) this.accActive = false;
      }
    }
    for (let a = 0; a < 2; a++) {
      const sgn = a === 0 ? 1 : -1;
      // Groove orbit — she is never limp: elbows breathe into each count, the
      // whole arm rides the 2-beat weight LFO (out of phase L/R).
      // Groove arms move at the ELBOW, not the shoulder. Keep the shoulder LOW
      // and near-steady (arms hang at the sides) and make the elbow the primary
      // oscillator: it flexes hard ON each count — the forearm folds up and IN
      // toward the ribs (hand crosses inside the silhouette) — then extends back
      // down on the "and". A shoulder-only lever windshield-wipers; an elbow pump
      // reads as a real groove. The staggered spring chain (forearm halflife >
      // elbow > shoulder) drags the hand a beat behind for follow-through.
      const ebeat = sgn * lfo; // L/R arms pump a half-beat out of phase
      let gAbd = 0.22 + 0.04 * bop;
      let gFwd = 0.12 + ebeat * 0.05;
      let gElb = 0.55 + 0.55 * bop + ebeat * 0.12; // deep beat-driven elbow flex
      let gLof = 0.35 + 0.55 * bop; // forearm folds FORWARD as it flexes (hand → in front)
      // Contralateral counterswing: the OPPOSITE leg's swing pumps this arm
      // FORWARD/back (toward the camera) with a bent elbow, like a natural stride.
      const dl = 1 - a;
      if (this.footState[dl] === 1) {
        const span = Math.max(this.landBeatA[dl] - this.liftBeatA[dl], 1e-4);
        const s = halfSine(clamp((drv - this.liftBeatA[dl]) / span, 0, 1));
        gFwd += s * 0.42;
        gAbd += s * 0.08;
        gElb += s * 0.3;
      }
      // Accent set-point blended in over the groove.
      if (this.accActive && (this.accArm === a || this.accArm === 2) && e > 1e-3) {
        const o = this.accIdx * 4;
        gAbd = lerp(gAbd, ACCENTS[o], e);
        gFwd = lerp(gFwd, ACCENTS[o + 1], e);
        gElb = lerp(gElb, ACCENTS[o + 2], e);
        gLof = lerp(gLof, ACCENTS[o + 3], e);
      }
      // Staggered spring chain: shoulder stiff, elbow softer, forearm softest.
      this.critStep(this.armAbd[a], this.armAbdV[a], gAbd, 0, HL_ARM_SH, dt);
      this.armAbd[a] = this.sp2[0];
      this.armAbdV[a] = this.sp2[1];
      this.critStep(this.armFwd[a], this.armFwdV[a], gFwd, 0, HL_ARM_SH, dt);
      this.armFwd[a] = this.sp2[0];
      this.armFwdV[a] = this.sp2[1];
      this.critStep(this.armElb[a], this.armElbV[a], gElb, 0, HL_ARM_EL, dt);
      this.armElb[a] = this.sp2[0];
      this.armElbV[a] = this.sp2[1];
      this.critStep(this.armLof[a], this.armLofV[a], gLof, 0, HL_ARM_FA, dt);
      this.armLof[a] = this.sp2[0];
      this.armLofV[a] = this.sp2[1];
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

  /** Beats of wind-up a row needs before its note beat (swing window, or the
   *  jump load + airtime), clamped shorter by the gap so streams stay crisp. */
  private windupFor(st: Step, gap: number): number {
    if (this.isJump(st)) return Math.min(JUMP_LOAD_BEATS + JUMP_AIR_BEATS, gap * 0.9);
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

  /** Command one note row. Jumps are first-class (both feet + a ballistic
   *  parabola); single steps swing one foot to its panel. Also fires the arm
   *  accent and the gaze/weight-transfer context for the physics core. */
  private commitStep(st: Step, gap: number, beat: number): void {
    const lp = st.lCol !== undefined && Number.isFinite(st.lCol) ? Math.trunc(st.lCol) : -1;
    const rp = st.rCol !== undefined && Number.isFinite(st.rCol) ? Math.trunc(st.rCol) : -1;
    const lSteps = lp >= 0 && lp <= 3;
    const rSteps = rp >= 0 && rp <= 3;
    const w = this.windupFor(st, gap);
    this.curGapSec = clamp(gap / this.bps, 0.05, 4);

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
      this.jpJl = jl;
      this.jpJr = jr;
      this.jpLand = st.beat;
      const load = Math.min(JUMP_LOAD_BEATS, w * 0.4);
      this.jpTakeoff = st.beat - Math.min(JUMP_AIR_BEATS, w - load);
      this.jpPending = true;
      const up = jl === 2 || jr === 2;
      this.setAccent(2, up ? ACC_SKY : ACC_FLARE, st.beat, JUMP_AIR_BEATS);
      this.faceLook = 0;
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
    const cross = (foot === 0 && panel === 3) || (foot === 1 && panel === 0);
    this.assignFoot(foot, panel, beat, st.beat);

    // Arm accent: reach with the panel-side arm (crossover ⇒ opposite), Up/Down
    // drive both. Alternate two stylings so repeats don't loop one gesture.
    let arm = panel === 0 ? 0 : panel === 3 ? 1 : 2;
    if (cross) arm = foot === 0 ? 1 : 0;
    // Fire a big arm accent only SOME steps — a crossover (distinctive) always,
    // otherwise every other step. Between accents the arms ride the groove orbit
    // + contralateral counterswing, so they stay alive without a pose on every
    // beat (an accent on every beat reads as one repeated fling).
    if (cross || this.stepCount % 2 === 0) {
      const idx = this.accentIdx(panel, cross);
      this.setAccent(arm, idx, st.beat, w);
    }
    this.faceLook = clamp((this.pt[0] - CX) / (0.3 * BODY_H), -1, 1) * 0.22;
    this.stepAlt ^= 1;
    this.stepCount++;
    this.lastFoot = foot;
  }

  /** Pick an accent set-point by step context (alternates via stepAlt). */
  private accentIdx(panel: number, cross: boolean): number {
    if (cross) return ACC_CROSS;
    if (panel === 2) return this.stepAlt ? ACC_SKY : ACC_LEAD; // Up
    if (panel === 1) return this.stepAlt ? ACC_DRIVE : ACC_PUNCH; // Down
    return this.stepAlt ? ACC_SIDE : ACC_PUNCH; // Left / Right
  }

  private setAccent(arm: number, idx: number, beat: number, windup: number): void {
    this.accActive = true;
    this.accArm = arm;
    this.accIdx = clamp(idx, 0, N_ACC - 1) | 0;
    this.accBeat = beat;
    this.accWindup = Math.max(windup, 0.08);
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

  /** Enter the airborne regime: both feet swing to their panels + tuck, and the
   *  CoM is seeded with a ballistic parabola whose apex emerges from the airtime
   *  (vy = G·T/2). Position AND velocity are carried over from the spring. */
  private takeoff(): void {
    const B = BODY_H;
    this.assignFoot(0, this.jpJl, this.jpTakeoff, this.jpLand);
    this.assignFoot(1, this.jpJr, this.jpTakeoff, this.jpLand);
    this.liftHA[0] = JUMP_TUCK * B;
    this.liftHA[1] = JUMP_TUCK * B;
    this.airborne = true;
    this.jpPending = false;
    this.jT = Math.max((this.jpLand - this.jpTakeoff) / this.bps, 0.05);
    this.jY0 = this.comY;
    this.jVY0 = (-G * this.jT) / 2; // upward (y DOWN)
    this.jX0 = this.comX;
    this.jZ0 = this.comZ;
    this.jVX0 = this.comVX;
    this.jVZ0 = this.comVZ;
  }

  /** Leave the airborne regime: commit both plants and feed the impact velocity
   *  (G·T/2 downward) into the vertical spring as its initial velocity, so the
   *  landing squash depth EMERGES from the fall speed (C1 by construction). */
  private land(): void {
    this.airborne = false;
    for (let f = 0; f < 2; f++) {
      this.plantX[f] = this.toX[f];
      this.plantZ[f] = this.toZ[f];
      this.footState[f] = 0;
    }
    this.comY = this.jY0;
    this.comVY = (G * this.jT) / 2; // downward impact → squash
    this.comVX = this.jVX0;
    this.comVZ = this.jVZ0;
    this.curGapSec = 1; // settle centred between the panels
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

  /** FK the torso/head/arms from the pose springs, two-bone-IK the legs onto
   *  the animated ankle targets, project everything through the weak-perspective
   *  camera, then run the secondary hair/cloth springs on the projected joints.
   *  The pose scalars are already framerate-independent spring states; this just
   *  turns them into joint positions and pixels. */
  private solve3D(time: number, s30: number): void {
    const B = BODY_H;
    const s3 = this.skel3;

    // Clamped pose scalars (a spring is stable, but never trust math into IK).
    const yaw = clamp(this.sYaw, -0.7, 0.7);
    const lean = clamp(this.sLean, -0.5, 0.5);
    const pitch = clamp(this.sPitch, -0.5, 0.6);
    const twist = clamp(this.sTwist, -0.8, 0.8);
    const side = clamp(this.sSide, -0.08, 0.08);
    const hyaw = clamp(this.sHyaw, -0.8, 0.8);
    const hpit = clamp(this.sHpit, -0.6, 0.6);
    const hroll = clamp(this.sHroll, -0.6, 0.6);
    const list = clamp(this.sList, -0.08, 0.08);

    // Pelvis frame from yaw (the hip lateral axis; it yaws with the CoM travel).
    const latX = Math.cos(yaw);
    const latZ = -Math.sin(yaw);
    const fwdX = Math.sin(yaw);
    const fwdZ = Math.cos(yaw);

    // Pelvis = CoM, with a HARD reach clamp (not a spring, no ZMP): drop the
    // pelvis so the WORST planted leg stays inside its reach — the CoM is in the
    // support hull by construction, so overshoot-out is free, but a leg must
    // never over-extend and rubber-band.
    let pelX = this.comX;
    let pelY = this.comY;
    let pelZ = this.comZ;
    if (!this.airborne) {
      const maxR = (L_THIGH + L_SHIN) * B * 0.98;
      for (let f = 0; f < 2; f++) {
        if (this.footState[f] !== 0) continue; // planted legs only
        const hxx = pelX + (f === 0 ? -1 : 1) * latX * W_HIP * B;
        const hzz = pelZ + (f === 0 ? -1 : 1) * latZ * W_HIP * B;
        const dh = Math.hypot(this.footX[f] - hxx, this.footZ[f] - hzz);
        const vs = Math.sqrt(Math.max(0, maxR * maxR - dh * dh));
        const need = this.footYv[f] - vs; // hip must be at least this far down
        if (Number.isFinite(need) && need > pelY) pelY = need;
      }
    }
    if (!Number.isFinite(pelX)) pelX = CX;
    if (!Number.isFinite(pelY)) pelY = REST_COM_Y;
    if (!Number.isFinite(pelZ)) pelZ = 0;
    s3[PEL * 3] = pelX;
    s3[PEL * 3 + 1] = pelY;
    s3[PEL * 3 + 2] = pelZ;

    // Shoulder frame adds the twist (shoulders counter-rotate vs the pelvis).
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
    // Head offset from the neck base carries the nod/tilt so the aim retarget
    // (neck→head) reproduces it: pitch swings the head fwd+down, roll slides it
    // ear-to-shoulder. Displacements are generous — a still head reads as
    // lifeless. (Yaw/turn can't be shown by moving the head centre — it needs a
    // gaze target — so it stays a 2D-face cue via faceTurn.)
    const r = R_HEAD * B;
    const nod = Math.sin(hpit) * r * 0.85;
    const hX = nbX + ux * r * 0.9 + latSX * Math.sin(hroll) * r * 1.15 + fwdSX * nod;
    const hY = nbY + uy * r * 0.9 + Math.sin(hpit) * r * 0.5;
    const hZ = nbZ + uz * r * 0.9 + latSZ * Math.sin(hroll) * r * 1.15 + fwdSZ * nod;
    s3[HEAD * 3] = hX;
    s3[HEAD * 3 + 1] = hY;
    s3[HEAD * 3 + 2] = hZ;
    this.faceTurn = clamp(Math.sin(hyaw + yawS * 0.35) * r * 0.5, -r, r);

    // Shoulder sockets: on the twisted shoulder line, counter-tilted against
    // the pelvic list (weight-bearing hip up ⇒ same-side shoulder down). Kept
    // SMALL — the spine absorbs most of the list, so the shoulders barely tilt;
    // a big coupling raised one shoulder up to the neck base and read as a hunch
    // (and it drives the VRM chest's shoulder-plane pole, tilting the neck too).
    const shTilt = list * B * 0.22;
    s3[SHL * 3] = shX - latSX * W_SHOULDER * B;
    s3[SHL * 3 + 1] = shY - shTilt;
    s3[SHL * 3 + 2] = shZ - latSZ * W_SHOULDER * B;
    s3[SHR * 3] = shX + latSX * W_SHOULDER * B;
    s3[SHR * 3 + 1] = shY + shTilt;
    s3[SHR * 3 + 2] = shZ + latSZ * W_SHOULDER * B;

    // Waist corners (torso-plate geometry rides the frame so body yaw
    // foreshortens the plates through z).
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

    // Arms: FK from the spring-driven angles. Upper arm = down rotated outward
    // by abduction in the coronal plane, then toward the viewer by the fwd
    // channel; the forearm continues the arc (elbow bend) with its own forward
    // component. This produces an anatomically sensible elbow bend PLANE, which
    // is what the VRM aim-retarget reads (shoulder→elbow→hand + its normal).
    for (let f = 0; f < 2; f++) {
      const sgn = f === 0 ? -1 : 1;
      const abd = clamp(this.armAbd[f], -0.6, 3.3);
      const fw = clamp(this.armFwd[f], -1.2, 1.2);
      let elb = clamp(this.armElb[f], -0.5, 2.6);
      // Soft elbow — the anti-mannequin rule: a human arm never locks dead
      // straight, so blend a small residual bend into a near-straight arm (fades
      // out by |elb|=0.6). Kept modest: it exists only to avoid a hyperextended
      // ruler on a full reach, NOT to hold a bend at rest — the resting arms get
      // their natural soft bend from the pose itself.
      const straight = 1 - Math.min(Math.abs(elb) * (1 / 0.6), 1);
      elb += 0.22 * straight * straight;
      let lof = clamp(this.armLof[f], -1.2, 1.6);
      // Bend DIRECTION on a raised arm: +elb continues the coronal arc, which
      // on a reach (upper arm at/above horizontal) carries the forearm UPWARD
      // past the humerus line. An elbow only flexes one way — that upward bow
      // reads as hyperextension, a backward break at the joint. So redirect
      // small near-straight bends (residual floor included) on raised arms
      // into what a relaxed elbow actually does out there: a slight gravity
      // droop below the upper-arm line plus a forward (toward-viewer) fold.
      // Big authored curls (|elb| ≳ 1.2: fists, pumps) and inward flexes
      // (elb < 0) pass untouched, and the redirect fades smoothly on both the
      // bend and the elevation axes, so accent changes never pop.
      if (elb > 0) {
        const elev = smooth01((abd - 0.85) * (1 / 0.95)); // 0 low arm → 1 raised
        const soft = smooth01(1 - elb * (1 / 1.2)); // 1 near-straight → 0 big curl
        const w = elev * soft;
        lof += w * 0.7 * elb; // forward fold (f2 is clamped below)
        elb -= w * 1.9 * elb; // >1× ⇒ net droop below the humerus line
      }
      // Hard elbow floor: never let the forearm line up with the upper arm
      // (the locked-plank silhouette). Preserve the bend's sign (a droop stays a
      // droop) but guarantee at least ELBOW_FLOOR of visible flex.
      if (elb > -ELBOW_FLOOR && elb < ELBOW_FLOOR) elb = elb < 0 ? -ELBOW_FLOOR : ELBOW_FLOOR;
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
      // Soft knees: never lock the chain fully straight (keeps a natural bend
      // and kills the rubber-band pop at full reach). Clamp well below full
      // reach — a barely-bent knee vanishes on a smooth tights-clad VRoid leg
      // and reads as a stretched straight column, so keep a visible flex.
      const dc = clamp(d, Math.abs(l1 - l2) + 1, (l1 + l2) * 0.94);
      const ca = clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1);
      const sa = Math.sqrt(Math.max(0, 1 - ca * ca));
      // Knee pole: point the knees mostly FORWARD (over the toes) with only a
      // little outward splay. A strongly outward pole bowed the knees way past
      // the feet into a bow-legged "( )" — worse once the knees bend more — so
      // forward-dominant keeps a natural athletic track; a bit of outward still
      // gives 3D volume and never inverts the joint.
      let px = sgn * latX * 0.4 + fwdX * 0.78;
      let py = 0;
      let pz = sgn * latZ * 0.4 + fwdZ * 0.78;
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
      // Ankle re-derived on the (possibly reach-clamped) chain — exactly l2
      // from the knee, so hip→knee→ankle is one connected chain.
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

  /** The dance pad: four flat arrows on the floor at the panel targets. Each
   *  is a dim neon outline at rest; on the beat it is stepped it flashes bright
   *  (additive glow fill + hot outline) and fades over ~a beat. Drawn first so
   *  the dancer's body and feet layer over it — feet read as ON the panels. */
  private emitPad(beat: number): void {
    const pts = this.padPts;
    const pa = this.pal.accentA;
    const pb = this.pal.accentB;
    const wht = this.pal.white;
    for (let oi = 0; oi < 4; oi++) {
      const panel = PAD_ORDER[oi];
      const cx = PAD_CX[panel];
      const cz = PAD_CZ[panel];
      const pux = PAD_PUX[panel];
      const puz = PAD_PUZ[panel];
      // Perpendicular in the floor plane (rotate the pointing dir 90°).
      const pvx = -puz;
      const pvz = pux;
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

      // Lit fill (additive glow) — a fan from the centroid, only when flashing.
      if (flash > 0.02) {
        const fr = (lerp(pa[0], wht[0], 0.35) / 255) * flash * 0.85;
        const fg = (lerp(pa[1], wht[1], 0.35) / 255) * flash * 0.85;
        const fb = (lerp(pa[2], wht[2], 0.35) / 255) * flash * 0.85;
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
      }

      // Outline: dim cyan floor line at rest, ramping to hot white on flash.
      const baseI = 0.12 + 0.9 * flash;
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
