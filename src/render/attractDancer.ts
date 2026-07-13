/**
 * AttractDancer — the low-poly anime-girl dancer from attractBackground.ts,
 * rebuilt as a pure-CPU triangle-mesh generator for the GPU pipeline. It never
 * touches a canvas: build(time, beat) refills two reused vertex buffers
 * (x, y, r, g, b per vertex, triangle list, 960x540 design space, y down) —
 * `solid` holds the opaque flat-shaded body facets, `additive` holds the neon
 * silhouette edges, the scaled rim-glow silhouette behind her, and the
 * hand-burst spikes.
 *
 * The animation is layered instead of pose-lerped:
 *
 *  FEET (the point): each note row swings a foot onto the arrow's panel —
 *  Left plants the LEFT foot out left, Right the right foot right, Up throws
 *  a foot to the forward panel (with a hop), Down tucks a foot back into a
 *  dip; jumps split both feet across the lit panels. L/R own their natural
 *  foot, U/D alternate off whichever foot stepped last, so streams read as
 *  real DDR footwork. Swings start `dur` beats early (anticipation), travel
 *  on a back-ease that overshoots ~8% (snap) and LAND exactly on the beat,
 *  with a sine lift arc sized by step distance. The pelvis is a spring chasing
 *  a weight point biased onto the support foot, and the legs are solved by
 *  2-bone IK from the hips to the animated ankles — so weight visibly shifts
 *  and knees bend into every plant.
 *
 *  UPPER BODY: a separate 9-channel target (lean/head/arms/crouch/rise/shift)
 *  taken from the direction-pose vocabulary (STEP_L/R/U/D, JUMP) with the
 *  same anticipatory ease toward the next arrow, then run through an
 *  underdamped velocity spring — hits overshoot and settle, momentum carries
 *  across fast streams, sparse charts breathe. A continuous time-based groove
 *  (hip sway, head bob, forearm wobble) is added on top so she never freezes.
 *
 *  SECONDARY: the twin-tail velocity springs, ahoge and skirt lag points are
 *  carried over (dt-scaled so 240fps and 30fps behave identically), plus the
 *  beat bounce baked into the root and squash-and-stretch about the foot line.
 *
 * With no chart the feet dance a synthesized L/D/R/U pattern while the upper
 * body performs the classic 8-beat POSES loop; with no beat (NaN/negative
 * lead-in) she idles on a gentle neutral sway. Every emitted triangle is
 * guarded against non-finite coordinates.
 */

// ---- design space (matches attractBackground.ts) ---------------------------

const W = 960;
const H = 540;
const CX = W / 2;
const FOOT_Y = H * 0.86; // where the feet plant
const BODY_H = H * 0.55; // dancer height in px
const PI = Math.PI;

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

// ---- rig types --------------------------------------------------------------

/** A single keyframe of the dancer rig. Limb angles are ABSOLUTE, measured from
 *  straight-down: 0 = down, ±π = up, +π/2 = screen-right, -π/2 = screen-left.
 *  crouch/rise/shiftX are fractions of BODY_H. (Leg channels survive here for
 *  the copied POSES table, but the mesh dancer's legs are IK-driven.) */
interface Pose {
  crouch: number;
  rise: number;
  shiftX: number;
  lean: number;
  head: number;
  armLUp: number;
  armLLo: number;
  armRUp: number;
  armRLo: number;
  legLUp: number;
  legLLo: number;
  legRUp: number;
  legRLo: number;
}

/** One note row: beat + a 4-bit L/D/U/R column mask (bit0=L,1=D,2=U,3=R; a
 *  jump lights >1 bit). */
export interface Step {
  beat: number;
  cols: number;
}

/** The classic 8-beat loop (upper body only here — feet are IK'd). */
const POSES: readonly Pose[] = [
  // 1 — The Hit: right arm punched to the sky.
  // prettier-ignore
  { crouch: 0, rise: 0.05, shiftX: 0, lean: 0.05, head: -0.12,
    armLUp: 0.15, armLLo: -1.7, armRUp: PI, armRLo: PI,
    legLUp: 0.03, legLLo: 0.03, legRUp: 0.55, legRLo: 0.75 },
  // 2 — Pull-down: elbow-drive at the ribs, hips drop.
  // prettier-ignore
  { crouch: 0.06, rise: 0, shiftX: 0, lean: 0.02, head: 0.05,
    armLUp: -0.4, armLLo: 2.6, armRUp: 0.4, armRLo: -2.6,
    legLUp: 0.06, legLLo: 0.22, legRUp: -0.06, legRLo: -0.22 },
  // 3 — Roof ×1: both palms shove skyward.
  // prettier-ignore
  { crouch: 0, rise: 0.06, shiftX: 0, lean: 0, head: -0.1,
    armLUp: PI + 0.2, armLLo: PI + 0.2, armRUp: PI - 0.2, armRLo: PI - 0.2,
    legLUp: 0.02, legLLo: 0.02, legRUp: -0.02, legRLo: -0.02 },
  // 4 — Roof ×2 with hip: hips slide right, head bobs opposite.
  // prettier-ignore
  { crouch: 0, rise: 0.05, shiftX: 0.06, lean: -0.06, head: 0.12,
    armLUp: PI + 0.15, armLLo: PI + 0.15, armRUp: PI - 0.15, armRLo: PI - 0.15,
    legLUp: 0.05, legLLo: 0.05, legRUp: 0.02, legRLo: 0.05 },
  // 5 — Side-step & throw: left arm sweeps across, right trails.
  // prettier-ignore
  { crouch: 0.02, rise: 0, shiftX: 0.08, lean: -0.05, head: 0.05,
    armLUp: 1.4, armLLo: 1.4, armRUp: 0.6, armRLo: 0.95,
    legLUp: -0.18, legLLo: -0.2, legRUp: 0.28, legRLo: 0.32 },
  // 6 — The wave: arms level at shoulder height.
  // prettier-ignore
  { crouch: 0.02, rise: 0, shiftX: 0.03, lean: 0.04, head: -0.05,
    armLUp: -1.5, armLLo: -1.25, armRUp: 1.5, armRLo: 1.25,
    legLUp: -0.05, legLLo: -0.05, legRUp: 0.05, legRLo: 0.05 },
  // 7 — Spin prep: arms wind across the torso, hips coil.
  // prettier-ignore
  { crouch: 0.05, rise: 0, shiftX: 0, lean: -0.1, head: 0.1,
    armLUp: 0.8, armLLo: 2.0, armRUp: -0.8, armRLo: -2.0,
    legLUp: 0.1, legLLo: 0.15, legRUp: -0.1, legRLo: -0.15 },
  // 8 — Release: fling open into a big X.
  // prettier-ignore
  { crouch: 0, rise: 0.03, shiftX: 0, lean: 0.08, head: -0.15,
    armLUp: PI + 0.9, armLLo: PI + 0.9, armRUp: PI - 0.9, armRLo: PI - 0.9,
    legLUp: -0.4, legLLo: -0.5, legRUp: 0.3, legRLo: 0.45 },
];

// Direction "hit" poses the dancer strikes ON each note (upper-body vocabulary).
// prettier-ignore
const NEUTRAL: Pose = {
  crouch: 0.02, rise: 0, shiftX: 0, lean: 0, head: 0,
  armLUp: -0.35, armLLo: -0.55, armRUp: 0.35, armRLo: 0.55,
  legLUp: -0.06, legLLo: -0.06, legRUp: 0.06, legRLo: 0.06 };
// prettier-ignore
const STEP_L: Pose = {
  crouch: 0.02, rise: 0.02, shiftX: -0.05, lean: -0.06, head: -0.12,
  armLUp: -2.35, armLLo: -2.5, armRUp: 0.55, armRLo: 0.9,
  legLUp: -0.16, legLLo: -0.12, legRUp: 0.08, legRLo: 0.06 };
// prettier-ignore
const STEP_R: Pose = {
  crouch: 0.02, rise: 0.02, shiftX: 0.05, lean: 0.06, head: 0.12,
  armLUp: -0.55, armLLo: -0.9, armRUp: 2.35, armRLo: 2.5,
  legLUp: -0.08, legLLo: -0.06, legRUp: 0.16, legRLo: 0.12 };
// prettier-ignore
const STEP_U: Pose = {
  crouch: 0, rise: 0.06, shiftX: 0, lean: 0, head: -0.14,
  armLUp: -2.95, armLLo: -3.05, armRUp: 2.95, armRLo: 3.05,
  legLUp: -0.05, legLLo: -0.05, legRUp: 0.05, legRLo: 0.05 };
// prettier-ignore
const STEP_D: Pose = {
  crouch: 0.11, rise: 0, shiftX: 0, lean: 0.03, head: 0.06,
  armLUp: -0.25, armLLo: 0.5, armRUp: 0.25, armRLo: -0.5,
  legLUp: 0.1, legLLo: 0.28, legRUp: -0.1, legRLo: -0.28 };
// prettier-ignore
const JUMP: Pose = {
  crouch: 0, rise: 0.07, shiftX: 0, lean: 0, head: -0.08,
  armLUp: -2.25, armLLo: -2.25, armRUp: 2.25, armRLo: 2.25,
  legLUp: -0.3, legLLo: -0.28, legRUp: 0.3, legRLo: 0.28 };

function bitCount(cols: number): number {
  return (cols & 1) + ((cols >> 1) & 1) + ((cols >> 2) & 1) + ((cols >> 3) & 1);
}

/** The upper-body pose for a note row's column mask. */
function dirPose(cols: number): Pose {
  if (bitCount(cols) >= 2) return JUMP;
  if (cols & 1) return STEP_L;
  if (cols & 2) return STEP_D;
  if (cols & 4) return STEP_U;
  if (cols & 8) return STEP_R;
  return NEUTRAL;
}

/** True if a note row raises a hand skyward (→ hand-burst spikes). */
function raisesHand(cols: number): boolean {
  return bitCount(cols) >= 2 || (cols & 4) !== 0;
}

function easeSnap(p: number): number {
  // Back-ease-out: overshoots ~8% past the target then settles — moves "snap".
  const t = p - 1;
  const s = 1.7;
  return 1 + (s + 1) * t * t * t + s * t * t;
}

// ---- skeleton ----------------------------------------------------------------

// Joint indices into the flat [x,y,...] skeleton buffer (same rig as the
// Canvas-2D dancer): HAL/HAR wrists, FTL/FTR ankles, TAILL/TAILR twin-tail
// tips, AHOGE cowlick tip, SKIRT lagged hem anchor.
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
  SKIRT = 19;
const JOINTS = 20;

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

// ---- footwork constants -------------------------------------------------------

/** Half stance width (fraction of BODY_H). */
const STANCE = 0.085;
/** Chart-less synthesized pattern, one row per beat (bit0=L,1=D,2=U,3=R). */
const SYNTH: readonly number[] = [1, 2, 8, 4, 1, 8, 2, 9];

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
  private readonly hem = new Float64Array(14); // skirt hem points
  private readonly pt = new Float64Array(2); // panelTarget out
  private readonly jit = new Float32Array(24); // fixed burst jitter
  private readonly skel = new Float32Array(JOINTS * 2);

  // ---- timing ----
  private lastTime = NaN;
  private prevBeat = NaN;

  // ---- chart cursors ----
  private hitIdx = -1; // last step whose beat has passed
  private swungIdx = -1; // last step whose foot-swing has been launched
  private synthHit = -1e9; // chart-less mode bookkeeping
  private synthSwung = -1e9;

  // ---- feet (current pos + active swing per foot; 0 = left, 1 = right) ----
  private readonly footX = new Float64Array(2);
  private readonly footY = new Float64Array(2);
  private readonly swX0 = new Float64Array(2);
  private readonly swY0 = new Float64Array(2);
  private readonly swX1 = new Float64Array(2);
  private readonly swY1 = new Float64Array(2);
  private readonly swB0 = new Float64Array(2);
  private readonly swB1 = new Float64Array(2);
  private readonly swLift = new Float64Array(2);
  private lastFoot = 1; // which foot stepped last (alternation for U/D)

  // ---- accents fired by note hits ----
  private hitBeat = -1e9;
  private hitCols = 0;
  private dipBeat = -1e9;
  private dipAmt = 0;
  private hopBeat = -1e9;
  private hopAmt = 0;

  // ---- upper-body layered spring (9 channels:
  //      lean, head, armLUp, armLLo, armRUp, armRLo, crouch, rise, shiftX) ----
  private readonly upX = new Float32Array(9);
  private readonly upV = new Float32Array(9);
  private readonly upT = new Float32Array(9);

  // ---- pelvis sway spring ----
  private rootX = CX;
  private rootVX = 0;

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

  // ---- per-frame paint parameters ----
  private sx = 1; // squash-and-stretch about (CX, FOOT_Y)
  private sy = 1;
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

    // Dancer color zones, same recipe as the Canvas dancer: 3-step flat ramps
    // toward near-black ink. Eyes/blush are pre-composited over the lit face
    // (the mesh is opaque — no alpha channel).
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
    ramp(ZSKIN, skin, 0.26, 0.52, 0.8);
    ramp(ZHAIR, this.pal.accentA, 0.24, 0.5, 0.82);
    ramp(ZDRESS, this.pal.accentA, 0.12, 0.22, 0.34);
    ramp(ZSKIRT, this.pal.accentB, 0.22, 0.48, 0.75);
    ramp(ZTRIM, this.pal.accentC, 0.2, 0.4, 0.6);
    const faceLit = mix(ink, skin, 0.8);
    const eye = mix(faceLit, mix(ink, this.pal.accentA, 0.2), 0.9);
    const blush = mix(faceLit, mix(this.pal.accentA, [255, 118, 148], 0.5), 0.3);
    ramp(ZEYE, eye, 1, 1, 1);
    ramp(ZBLUSH, blush, 1, 1, 1);

    // Deterministic burst jitter (no Math.random so replays are stable).
    for (let i = 0; i < this.jit.length; i++) {
      const h = Math.sin((i + 1) * 12.9898) * 43758.5453;
      this.jit[i] = h - Math.floor(h) - 0.5;
    }

    // Feet start in a neutral stance.
    const stanceYv = FOOT_Y - L_SHOE * BODY_H;
    for (let f = 0; f < 2; f++) {
      const x = CX + (f === 0 ? -1 : 1) * STANCE * BODY_H;
      this.footX[f] = x;
      this.footY[f] = stanceYv;
      this.swX0[f] = x;
      this.swY0[f] = stanceYv;
      this.swX1[f] = x;
      this.swY1[f] = stanceYv;
      this.swB0[f] = 0;
      this.swB1[f] = -1e9;
      this.swLift[f] = 0;
    }

    // Upper-body spring rests on NEUTRAL.
    this.setTarget(NEUTRAL, NEUTRAL, 0, false);
    this.upX.set(this.upT);

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
    this.swungIdx = -1;
    this.synthHit = -1e9;
    this.synthSwung = -1e9;
    this.hitBeat = -1e9;
    this.dipBeat = -1e9;
    this.hopBeat = -1e9;
    // Cancel active swings in place (feet keep their current position).
    for (let f = 0; f < 2; f++) {
      if (Number.isFinite(this.footX[f]) && Number.isFinite(this.footY[f])) {
        this.swX1[f] = this.footX[f];
        this.swY1[f] = this.footY[f];
      }
      this.swB0[f] = 0;
      this.swB1[f] = -1e9;
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
    const s60 = Math.min(dt * 60, 3); // spring step scale vs a 60fps frame
    const s30 = Math.min(dt * 30, 2.5); // vs the 30fps canvas springs

    const valid = Number.isFinite(beat) && beat >= 0;
    const chart = valid && this.steps.length > 0;
    if (valid && Number.isFinite(this.prevBeat) && beat < this.prevBeat - 0.5) this.rewind();
    this.prevBeat = valid ? beat : NaN;

    const B = BODY_H;
    const phase = valid ? beat - Math.floor(beat) : (time * 1.4) % 1;
    const kick = valid ? Math.exp(-6 * phase) : 0;
    const bob = valid
      ? 0.02 * B * (1 - Math.abs(Math.sin(PI * phase)))
      : 0.015 * B * (0.5 + 0.5 * Math.sin(time * 2.4));

    // ---- 1. chart triggering: fire hits that just passed, launch upcoming
    //         foot swings early enough to LAND on their beat -----------------
    if (chart) {
      const steps = this.steps;
      let guard = 0;
      while (this.hitIdx + 1 < steps.length && steps[this.hitIdx + 1].beat <= beat) {
        this.hitIdx++;
        if (++guard <= 32) this.onHit(steps[this.hitIdx].cols, steps[this.hitIdx].beat);
      }
      guard = 0;
      while (this.swungIdx + 1 < steps.length && guard++ < 32) {
        const i = this.swungIdx + 1;
        const st = steps[i];
        const gap = i > 0 ? st.beat - steps[i - 1].beat : 0.5;
        const dur = clamp(gap * 0.7, 0.12, 0.38);
        if (st.beat - beat > dur) break; // not yet in the anticipation window
        this.startSwing(st.cols, st.beat, dur);
        this.swungIdx = i;
      }
    } else if (valid) {
      // Chart-less: synthesize a DDR pattern so the feet still dance.
      const ib = Math.floor(beat);
      if (ib > this.synthHit) {
        this.synthHit = ib;
        this.onHit(SYNTH[((ib % 8) + 8) % 8], ib);
      }
      const nb = ib + 1;
      if (this.synthSwung < nb && nb - beat <= 0.3) {
        this.synthSwung = nb;
        this.startSwing(SYNTH[((nb % 8) + 8) % 8], nb, 0.3);
      }
    }

    // ---- 2. evaluate the feet ----------------------------------------------
    const stanceYv = FOOT_Y - L_SHOE * B;
    let swinging0 = false;
    let swinging1 = false;
    if (valid) {
      for (let f = 0; f < 2; f++) {
        const b0 = this.swB0[f];
        const b1 = this.swB1[f];
        let x: number;
        let y: number;
        if (!(b1 > b0) || beat >= b1) {
          x = this.swX1[f];
          y = this.swY1[f];
        } else if (beat <= b0) {
          x = this.swX0[f];
          y = this.swY0[f];
        } else {
          const p = (beat - b0) / (b1 - b0);
          const e = easeSnap(p);
          x = this.swX0[f] + (this.swX1[f] - this.swX0[f]) * e;
          y = this.swY0[f] + (this.swY1[f] - this.swY0[f]) * e - this.swLift[f] * Math.sin(PI * p);
          if (f === 0) swinging0 = true;
          else swinging1 = true;
        }
        if (Number.isFinite(x) && Number.isFinite(y)) {
          this.footX[f] = x;
          this.footY[f] = y;
        } else {
          this.footX[f] = CX + (f === 0 ? -1 : 1) * STANCE * B;
          this.footY[f] = stanceYv;
        }
      }
    } else {
      // Idle: feet relax back to the stance with a tiny alternating shuffle.
      const k = 1 - Math.exp(-dt * 6);
      for (let f = 0; f < 2; f++) {
        const s = f === 0 ? -1 : 1;
        const txv = CX + s * STANCE * B + 0.012 * B * Math.sin(time * 1.5 + f * 2.4);
        const tyv = stanceYv - Math.max(0, 0.006 * B * Math.sin(time * 2.4 + f * PI));
        if (!Number.isFinite(this.footX[f]) || !Number.isFinite(this.footY[f])) {
          this.footX[f] = txv;
          this.footY[f] = tyv;
        }
        this.footX[f] += (txv - this.footX[f]) * k;
        this.footY[f] += (tyv - this.footY[f]) * k;
      }
    }

    // ---- 3. hit accents: crouch dips, hops, hand-burst ----------------------
    const dd = beat - this.dipBeat;
    const dip = valid && dd >= 0 && dd < 4 ? this.dipAmt * Math.exp(-5 * dd) : 0;
    const hd = beat - this.hopBeat;
    const hop = valid && hd >= 0 && hd < 4 ? this.hopAmt * Math.exp(-5 * hd) : 0;
    const bd = beat - this.hitBeat;
    const burstLife = valid && bd >= 0 && bd < 0.22 && raisesHand(this.hitCols) ? 1 - bd / 0.22 : 0;

    // ---- 4. upper-body layer: pose target with anticipation, then a
    //         momentum spring so hits overshoot and settle ------------------
    if (chart) {
      const steps = this.steps;
      const cur = this.hitIdx >= 0 ? steps[this.hitIdx] : undefined;
      const next = this.hitIdx + 1 < steps.length ? steps[this.hitIdx + 1] : undefined;
      const a = cur ? dirPose(cur.cols) : NEUTRAL;
      let b = a;
      let e = 0;
      if (next) {
        const curBeat = cur ? cur.beat : next.beat - 1;
        const approach = Math.min(next.beat - curBeat, 0.55);
        const toNext = next.beat - beat;
        if (approach > 0 && toNext <= approach) {
          e = Math.min(1.05, easeSnap(1 - toNext / approach));
          b = dirPose(next.cols);
        }
      }
      this.setTarget(a, b, e, false);
    } else if (valid) {
      // Chart-less: the classic 8-beat POSES groove for the upper body,
      // mirrored every 4 measures so it doesn't hypnotize.
      const idx = ((Math.floor(beat) % 8) + 8) % 8;
      const e = clamp(easeSnap(phase), 0, 1.05);
      const mir = (Math.floor(beat / 16) & 1) === 1;
      this.setTarget(POSES[idx], POSES[(idx + 1) % 8], e, mir);
    } else {
      this.setIdleTarget(time);
    }
    {
      const K = 0.2;
      const dpow = Math.pow(0.72, s60);
      for (let i = 0; i < 9; i++) {
        let x = this.upX[i];
        let v = this.upV[i];
        const t = this.upT[i];
        if (!Number.isFinite(x) || !Number.isFinite(v)) {
          x = t;
          v = 0;
        }
        v = (v + (t - x) * K * s60) * dpow;
        x += v * s60;
        this.upX[i] = x;
        this.upV[i] = v;
      }
    }

    // Continuous groove layered on top so she never freezes between notes.
    const grooveOn = valid ? 1 : 0.6;
    const g = Math.sin(time * 3);
    const lean = this.upX[0] + 0.03 * Math.sin(time * 2.2) * grooveOn;
    const head = this.upX[1] + 0.05 * Math.sin(time * 2.2 + 0.4) * grooveOn;
    const aLU = this.upX[2];
    const aLL = this.upX[3] + 0.06 * g * grooveOn;
    const aRU = this.upX[4];
    const aRL = this.upX[5] - 0.06 * g * grooveOn;
    const crouch = clamp(0.015 + this.upX[6] * 0.8 + dip, -0.03, 0.24);
    const rise = Math.max(0, this.upX[7] * 0.8 + hop);

    // ---- 5. pelvis: weight shifts onto the support foot --------------------
    const midX = (this.footX[0] + this.footX[1]) / 2;
    let bias: number;
    if (swinging0 && !swinging1) bias = (this.footX[1] - midX) * 0.5;
    else if (swinging1 && !swinging0) bias = (this.footX[0] - midX) * 0.5;
    else bias = (this.footX[this.lastFoot] - midX) * 0.35;
    const rt = clamp(midX + bias + this.upX[8] * 0.5 * B, CX - 0.3 * B, CX + 0.3 * B);
    if (!Number.isFinite(this.rootX) || !Number.isFinite(this.rootVX)) {
      this.rootX = rt;
      this.rootVX = 0;
    }
    this.rootVX = (this.rootVX + (rt - this.rootX) * 0.12 * s60) * Math.pow(0.8, s60);
    this.rootX += this.rootVX * s60;

    const rootY = FOOT_Y - (L_THIGH + L_SHIN + L_SHOE) * B + crouch * B - rise * B - bob;

    // ---- 6. solve the skeleton (FK torso/arms, IK legs, spring hair) -------
    this.solve(this.rootX, rootY, lean, head, aLU, aLL, aRU, aRL, time, s30);

    // ---- 7. squash-and-stretch + paint params -------------------------------
    const sq = Math.sin(PI * phase) * (valid ? 1 : 0.4);
    this.sy = 1 + 0.03 * sq;
    this.sx = 1 - 0.02 * sq;
    const pa = this.pal.accentA;
    const eI = (0.55 + 0.45 * kick) / 255;
    this.edgeR = pa[0] * eI;
    this.edgeG = pa[1] * eI;
    this.edgeB = pa[2] * eI;
    const sI = 0.16 / 255;
    this.softR = pa[0] * sI;
    this.softG = pa[1] * sI;
    this.softB = pa[2] * sI;
    const gI = (0.07 + 0.11 * kick) / 255;
    this.glowR = pa[0] * gI;
    this.glowG = pa[1] * gI;
    this.glowB = pa[2] * gI;
    this.glowS = 1.045 + 0.02 * kick;

    // ---- 8. emit geometry ---------------------------------------------------
    this.solidPos = 0;
    this.addPos = 0;
    this.emitBody();
    if (burstLife > 0) this.emitBurst(burstLife, bitCount(this.hitCols) >= 2);

    this.out.solidCount = (this.solidPos / 5) | 0;
    this.out.additiveCount = (this.addPos / 5) | 0;
    return this.out;
  }

  // ---- footwork internals ---------------------------------------------------

  /** A note row's beat just passed: record it and fire the body accents. */
  private onHit(cols: number, hitBeat: number): void {
    this.hitBeat = hitBeat;
    this.hitCols = cols;
    if (bitCount(cols) >= 2) {
      this.hopBeat = hitBeat;
      this.hopAmt = 0.055;
      this.dipBeat = hitBeat + 0.25; // landing dip after the jump apex
      this.dipAmt = 0.05;
    } else if (cols & 4) {
      this.hopBeat = hitBeat;
      this.hopAmt = 0.04;
    } else if (cols & 2) {
      this.dipBeat = hitBeat;
      this.dipAmt = 0.06;
    } else {
      this.dipBeat = hitBeat;
      this.dipAmt = 0.02; // small weight drop on every plant
    }
  }

  /** Launch the foot swing(s) for a note row so they land ON `hitBeat`.
   *  L/R own their natural foot; U/D alternate off the last stepping foot;
   *  jumps split both feet across the lit panels (leftmost→left foot). */
  private startSwing(cols: number, hitBeat: number, dur: number): void {
    const b0 = hitBeat - dur;
    if (bitCount(cols) >= 2) {
      let lp = -1;
      let rp = -1;
      for (let p = 0; p < 4; p++) {
        if (cols & (1 << p)) {
          if (lp < 0) lp = p;
          rp = p;
        }
      }
      this.assignSwing(0, lp, b0, hitBeat);
      this.assignSwing(1, rp, b0, hitBeat);
      this.lastFoot = 1;
    } else {
      let foot: number;
      let panel: number;
      if (cols & 1) {
        foot = 0;
        panel = 0;
      } else if (cols & 8) {
        foot = 1;
        panel = 3;
      } else {
        foot = 1 - this.lastFoot;
        panel = cols & 4 ? 2 : 1;
      }
      this.assignSwing(foot, panel, b0, hitBeat);
      this.lastFoot = foot;
    }
  }

  /** Ankle target for a panel (0=L,1=D,2=U,3=R), per foot. */
  private panelTarget(panel: number, foot: number): void {
    const B = BODY_H;
    const y = FOOT_Y - L_SHOE * B;
    const s = foot === 0 ? -1 : 1;
    if (panel === 0) {
      this.pt[0] = CX - 0.24 * B;
      this.pt[1] = y;
    } else if (panel === 3) {
      this.pt[0] = CX + 0.24 * B;
      this.pt[1] = y;
    } else if (panel === 2) {
      // Up: forward panel — up-screen a touch, reads as a forward step/hop.
      this.pt[0] = CX + s * 0.07 * B;
      this.pt[1] = y - 0.05 * B;
    } else {
      // Down: tucked back toward the viewer, pairs with the crouch dip.
      this.pt[0] = CX + s * 0.09 * B;
      this.pt[1] = y + 0.04 * B;
    }
  }

  private assignSwing(foot: number, panel: number, b0: number, b1: number): void {
    this.panelTarget(panel, foot);
    const B = BODY_H;
    let x0 = this.footX[foot];
    let y0 = this.footY[foot];
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) {
      x0 = this.pt[0];
      y0 = this.pt[1];
    }
    this.swX0[foot] = x0;
    this.swY0[foot] = y0;
    this.swX1[foot] = this.pt[0];
    this.swY1[foot] = this.pt[1];
    this.swB0[foot] = b0;
    this.swB1[foot] = Math.max(b1, b0 + 1e-4);
    const d = Math.hypot(this.pt[0] - x0, this.pt[1] - y0);
    // Lift scales with travel distance; Up-panel steps kick a little higher.
    this.swLift[foot] = clamp(d * 0.35, 0.018 * B, 0.065 * B) + (panel === 2 ? 0.018 * B : 0);
  }

  // ---- upper-body target helpers ---------------------------------------------

  /** upT ← lerp(a,b,e), optionally mirrored L↔R, without allocating a Pose. */
  private setTarget(a: Pose, b: Pose, e: number, mir: boolean): void {
    const t = this.upT;
    if (!mir) {
      t[0] = lerp(a.lean, b.lean, e);
      t[1] = lerp(a.head, b.head, e);
      t[2] = lerp(a.armLUp, b.armLUp, e);
      t[3] = lerp(a.armLLo, b.armLLo, e);
      t[4] = lerp(a.armRUp, b.armRUp, e);
      t[5] = lerp(a.armRLo, b.armRLo, e);
      t[6] = lerp(a.crouch, b.crouch, e);
      t[7] = lerp(a.rise, b.rise, e);
      t[8] = lerp(a.shiftX, b.shiftX, e);
    } else {
      t[0] = -lerp(a.lean, b.lean, e);
      t[1] = -lerp(a.head, b.head, e);
      t[2] = -lerp(a.armRUp, b.armRUp, e);
      t[3] = -lerp(a.armRLo, b.armRLo, e);
      t[4] = -lerp(a.armLUp, b.armLUp, e);
      t[5] = -lerp(a.armLLo, b.armLLo, e);
      t[6] = lerp(a.crouch, b.crouch, e);
      t[7] = lerp(a.rise, b.rise, e);
      t[8] = -lerp(a.shiftX, b.shiftX, e);
    }
  }

  /** Lead-in idle: a calm neutral sway that never freezes (or NaNs). */
  private setIdleTarget(time: number): void {
    const t = this.upT;
    const sw = Math.sin(time * 1.5);
    t[0] = 0.05 * Math.sin(time * 1.2);
    t[1] = 0.1 * Math.sin(time * 1.2 + 0.5);
    t[2] = -0.28 + 0.08 * sw;
    t[3] = -0.34 + 0.1 * sw;
    t[4] = 0.28 - 0.08 * sw;
    t[5] = 0.34 - 0.1 * sw;
    t[6] = 0.01 + 0.01 * Math.sin(time * 2.4);
    t[7] = 0;
    t[8] = 0.02 * sw;
  }

  // ---- skeleton solve ---------------------------------------------------------

  private readonly sp4 = new Float64Array(4); // springTail out: px, py, vx, vy

  /** FK torso/head/arms from the layered channels, 2-bone IK legs down to the
   *  animated ankles, then the spring-lagged twin-tails / ahoge / skirt. */
  private solve(
    rootX: number,
    rootY: number,
    lean: number,
    head: number,
    aLU: number,
    aLL: number,
    aRU: number,
    aRL: number,
    time: number,
    s30: number,
  ): void {
    const s = this.skel;
    const B = BODY_H;
    s[PEL * 2] = rootX;
    s[PEL * 2 + 1] = rootY;

    // Torso points up, tilted by lean (angles: 0 = down, sin→x, cos→y).
    const shx = rootX + Math.sin(PI + lean) * L_TORSO * B;
    const shy = rootY + Math.cos(PI + lean) * L_TORSO * B;
    s[SH * 2] = shx;
    s[SH * 2 + 1] = shy;
    const nbx = shx + Math.sin(PI + lean) * L_NECK * B;
    const nby = shy + Math.cos(PI + lean) * L_NECK * B;
    s[HEADB * 2] = nbx;
    s[HEADB * 2 + 1] = nby;
    const hx = nbx + Math.sin(head) * R_HEAD * B;
    const hy = nby - R_HEAD * B * 0.9;
    s[HEAD * 2] = hx;
    s[HEAD * 2 + 1] = hy;

    // Arms: FK off the shoulder line.
    const slx = shx - W_SHOULDER * B;
    const srx = shx + W_SHOULDER * B;
    s[SHL * 2] = slx;
    s[SHL * 2 + 1] = shy;
    s[SHR * 2] = srx;
    s[SHR * 2 + 1] = shy;
    const ellx = slx + Math.sin(aLU) * L_UARM * B;
    const elly = shy + Math.cos(aLU) * L_UARM * B;
    s[ELL * 2] = ellx;
    s[ELL * 2 + 1] = elly;
    s[HAL * 2] = ellx + Math.sin(aLL) * L_FARM * B;
    s[HAL * 2 + 1] = elly + Math.cos(aLL) * L_FARM * B;
    const elrx = srx + Math.sin(aRU) * L_UARM * B;
    const elry = shy + Math.cos(aRU) * L_UARM * B;
    s[ELR * 2] = elrx;
    s[ELR * 2 + 1] = elry;
    s[HAR * 2] = elrx + Math.sin(aRL) * L_FARM * B;
    s[HAR * 2 + 1] = elry + Math.cos(aRL) * L_FARM * B;

    // Legs: 2-bone IK from each hip to its animated ankle. The knee bends
    // toward the side the foot is planted on (outward in neutral stance).
    const l1 = L_THIGH * B;
    const l2 = L_SHIN * B;
    for (let f = 0; f < 2; f++) {
      const hipx = rootX + (f === 0 ? -1 : 1) * W_HIP * B;
      const hipy = rootY;
      const hipI = f === 0 ? HIPL : HIPR;
      const knI = f === 0 ? KNL : KNR;
      const ftI = f === 0 ? FTL : FTR;
      s[hipI * 2] = hipx;
      s[hipI * 2 + 1] = hipy;
      let fx = this.footX[f];
      let fy = this.footY[f];
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
        fx = hipx;
        fy = FOOT_Y - L_SHOE * B;
      }
      let dx = fx - hipx;
      let dy = fy - hipy;
      let d = Math.hypot(dx, dy);
      if (!(d > 1e-4)) {
        dx = 0;
        dy = 1;
        d = 1;
      }
      const nx = dx / d;
      const ny = dy / d;
      const dc = clamp(d, Math.abs(l1 - l2) + 1, (l1 + l2) * 0.999);
      const a0 = Math.atan2(nx, ny);
      const ca = clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1);
      const al = Math.acos(ca);
      let ks = f === 0 ? -1 : 1;
      if (fx - hipx > 0.02 * B) ks = 1;
      else if (fx - hipx < -0.02 * B) ks = -1;
      const th = a0 + ks * al;
      s[knI * 2] = hipx + Math.sin(th) * l1;
      s[knI * 2 + 1] = hipy + Math.cos(th) * l1;
      // Re-derive the ankle on the (possibly reach-clamped) chain.
      s[ftI * 2] = hipx + nx * dc;
      s[ftI * 2 + 1] = hipy + ny * dc;
    }

    // ---- secondary motion: twin-tails, ahoge, skirt (dt-scaled springs) ----
    const r = R_HEAD * B;
    const swing = Math.sin(head) * r * 3;
    this.springTail(
      -1,
      this.tailLX,
      this.tailLY,
      this.tailLVX,
      this.tailLVY,
      hx,
      hy,
      r,
      swing,
      s30,
    );
    this.tailLX = this.sp4[0];
    this.tailLY = this.sp4[1];
    this.tailLVX = this.sp4[2];
    this.tailLVY = this.sp4[3];
    s[TAILL * 2] = this.tailLX;
    s[TAILL * 2 + 1] = this.tailLY;
    this.springTail(1, this.tailRX, this.tailRY, this.tailRVX, this.tailRVY, hx, hy, r, swing, s30);
    this.tailRX = this.sp4[0];
    this.tailRY = this.sp4[1];
    this.tailRVX = this.sp4[2];
    this.tailRVY = this.sp4[3];
    s[TAILR * 2] = this.tailRX;
    s[TAILR * 2 + 1] = this.tailRY;

    // Ahoge tip: a lagged point above the crown with a slow idle wobble.
    const ahRX = hx + Math.sin(head) * r * 0.6 + Math.sin(time * 2.1) * 0.012 * B;
    const ahRY = hy - r * 1.9 + Math.cos(time * 1.7) * 0.005 * B;
    if (!Number.isFinite(this.ahogeX) || !Number.isFinite(this.ahogeY)) {
      this.ahogeX = ahRX;
      this.ahogeY = ahRY;
    }
    this.ahogeX += (ahRX - this.ahogeX) * (1 - Math.pow(0.78, s30));
    this.ahogeY += (ahRY - this.ahogeY) * (1 - Math.pow(0.7, s30));
    s[AHOGE * 2] = this.ahogeX;
    s[AHOGE * 2 + 1] = this.ahogeY;

    // Skirt anchor: a lagged point under the pelvis; the hem sways off it.
    const skRX = rootX;
    const skRY = rootY + 0.1 * B;
    if (!Number.isFinite(this.skirtX) || !Number.isFinite(this.skirtY)) {
      this.skirtX = skRX;
      this.skirtY = skRY;
    }
    this.skirtX += (skRX - this.skirtX) * (1 - Math.pow(0.84, s30));
    this.skirtY += (skRY - this.skirtY) * (1 - Math.pow(0.78, s30));
    s[SKIRT * 2] = this.skirtX;
    s[SKIRT * 2 + 1] = this.skirtY;

    // Center the rim-glow silhouette scaling on the torso.
    this.bcx = rootX;
    this.bcy = (rootY + shy) * 0.5;
  }

  /** Underdamped velocity spring for one twin-tail tip (result in sp4).
   *  K/DAMP match the canvas dancer at 30fps; s30 rescales for any fps. */
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
    const damp = Math.pow(0.8, s30);
    vx = (vx + (rx - px) * 0.055 * s30) * damp;
    vy = (vy + (ry - py) * 0.055 * s30) * damp;
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
    const hw = soft ? 0.55 : 0.8;
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

  /** Push one triangle (design-space coords) into the solid stream, applying
   *  the squash-and-stretch transform. Non-finite triangles are dropped. */
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
    const sx = this.sx;
    const sy = this.sy;
    buf[p++] = CX + (x1 - CX) * sx;
    buf[p++] = FOOT_Y + (y1 - FOOT_Y) * sy;
    buf[p++] = r;
    buf[p++] = g;
    buf[p++] = b;
    buf[p++] = CX + (x2 - CX) * sx;
    buf[p++] = FOOT_Y + (y2 - FOOT_Y) * sy;
    buf[p++] = r;
    buf[p++] = g;
    buf[p++] = b;
    buf[p++] = CX + (x3 - CX) * sx;
    buf[p++] = FOOT_Y + (y3 - FOOT_Y) * sy;
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
    const sx = this.sx;
    const sy = this.sy;
    buf[p++] = CX + (x1 - CX) * sx;
    buf[p++] = FOOT_Y + (y1 - FOOT_Y) * sy;
    buf[p++] = r;
    buf[p++] = g;
    buf[p++] = b;
    buf[p++] = CX + (x2 - CX) * sx;
    buf[p++] = FOOT_Y + (y2 - FOOT_Y) * sy;
    buf[p++] = r;
    buf[p++] = g;
    buf[p++] = b;
    buf[p++] = CX + (x3 - CX) * sx;
    buf[p++] = FOOT_Y + (y3 - FOOT_Y) * sy;
    buf[p++] = r;
    buf[p++] = g;
    buf[p++] = b;
    this.addPos = p;
  }

  // ---- body geometry (port of the Canvas drawBody, facets + neon edges) -----

  private jx(i: number): number {
    return this.skel[i * 2];
  }
  private jy(i: number): number {
    return this.skel[i * 2 + 1];
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

    // Torso frame (shared by the torso plates, shoulder caps and skirt fan).
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

    // Twin-tails first: behind everything.
    this.emitTail(-1, TAILL);
    this.emitTail(1, TAILR);

    // Legs: bare skin thighs, knee-high boot shins, cuff band, shoe.
    this.emitLimb(HIPL, KNL, 0.054, 0.037, ZSKIN, true);
    this.emitLimb(KNL, FTL, 0.035, 0.016, ZTRIM, true);
    this.emitCuff(KNL, FTL);
    this.emitShoe(KNL, FTL, -1);
    this.emitLimb(HIPR, KNR, 0.054, 0.037, ZSKIN, true);
    this.emitLimb(KNR, FTR, 0.035, 0.016, ZTRIM, true);
    this.emitCuff(KNR, FTR);
    this.emitShoe(KNR, FTR, 1);

    // Torso: dark fitted top, chest split at the sternum into lit/shadow
    // planes, waist plate, pelvis wedge — an angular hourglass.
    const shW = 0.096 * B;
    const waistW = 0.05 * B;
    const hipW = 0.098 * B;
    const lsx = this.atX(1.02, -shW);
    const lsy = this.atY(1.02, -shW);
    const rsx = this.atX(1.02, shW);
    const rsy = this.atY(1.02, shW);
    const cpx = this.atX(1.08, 0); // collar point
    const cpy = this.atY(1.08, 0);
    const wlx = this.atX(0.42, -waistW);
    const wly = this.atY(0.42, -waistW);
    const wrx = this.atX(0.42, waistW);
    const wry = this.atY(0.42, waistW);
    const sbx = this.atX(0.42, 0); // sternum bottom
    const sby = this.atY(0.42, 0);
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
    const hlx = this.atX(0.04, -hipW);
    const hly = this.atY(0.04, -hipW);
    const hrx = this.atX(0.04, hipW);
    const hry = this.atY(0.04, hipW);
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

    // Pleated skirt: a short triangle fan with a zigzag handkerchief hem that
    // chases the lagged SKIRT point (sways opposite lateral moves, flares a
    // touch on drops and bounces).
    {
      const skm = 0.05 * B;
      const hemOff = clamp(this.jx(SKIRT) - plx, -skm, skm);
      const vLag = this.jy(SKIRT) - (ply + 0.1 * B);
      const lift = Math.min(0.045 * B, Math.abs(hemOff) * 0.8 + Math.abs(vLag) * 0.7);
      const hemW = 0.16 * B + lift;
      const drop = 0.12 * B - lift * 0.6;
      const fx = this.atX(0.2, 0); // fan origin, just above the pelvis
      const fy = this.atY(0.2, 0);
      const hem = this.hem;
      for (let k = 0; k <= 6; k++) {
        let x: number;
        let y: number;
        if (k === 0 || k === 6) {
          const side = k === 0 ? -1 : 1;
          const w = side * (hipW + 0.02 * B) + hemOff * 0.3;
          x = this.atX(0.06, w);
          y = this.atY(0.06, w);
        } else {
          const d2 = drop + (k % 2 === 1 ? 0.022 * B : 0);
          const w = hemW * ((k - 3) / 2) + hemOff;
          x = this.atX(-d2 / ul, w);
          y = this.atY(-d2 / ul, w);
        }
        hem[k * 2] = x;
        hem[k * 2 + 1] = y;
      }
      for (let k = 0; k < 6; k++) {
        this.beginPoly();
        this.v(fx, fy);
        this.v(hem[k * 2], hem[k * 2 + 1]);
        this.v(hem[k * 2 + 2], hem[k * 2 + 3]);
        this.facet(ZSKIRT, k % 2 === 0 ? 2 : 0);
      }
      // Hem silhouette + soft pleat creases partway up the fan.
      this.beginPoly();
      for (let k = 0; k <= 6; k++) this.v(hem[k * 2], hem[k * 2 + 1]);
      this.edge(false, false);
      for (let k = 1; k < 6; k++) {
        this.beginPoly();
        this.v(fx + (hem[k * 2] - fx) * 0.42, fy + (hem[k * 2 + 1] - fy) * 0.42);
        this.v(hem[k * 2], hem[k * 2 + 1]);
        this.edge(true, false);
      }
    }

    // Arms: slim bare-skin prisms + hand diamonds.
    this.emitLimb(SHL, ELL, 0.03, 0.021, ZSKIN, true);
    this.emitLimb(ELL, HAL, 0.02, 0.014, ZSKIN, true);
    this.emitHand(ELL, HAL);
    this.emitLimb(SHR, ELR, 0.03, 0.021, ZSKIN, true);
    this.emitLimb(ELR, HAR, 0.02, 0.014, ZSKIN, true);
    this.emitHand(ELR, HAR);

    // Neck (fill only, no line) + the head stack.
    this.emitLimb(SH, HEADB, 0.022, 0.018, ZSKIN, false);
    this.emitHead();
  }

  /** Angular tapered limb as a two-facet prism with a mid-edge knot; which
   *  face is lit is decided by the fixed key light. The silhouette is one
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
    const wA = wa * B;
    const wB = wb * B;
    const wM = Math.max(wA, wB) * 1.12;
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
    const B = BODY_H;
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
    const B = BODY_H;
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
    const B = BODY_H;
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
    const w = 0.042 * B;
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
    const B = BODY_H;
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
    const B = BODY_H;
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
   *  sliver, swept bangs plate, parting crease, eyes, blush, ahoge. */
  private emitHead(): void {
    const B = BODY_H;
    const hx = this.jx(HEAD);
    const hy = this.jy(HEAD);
    const r = R_HEAD * B;
    const tilt = hx - this.jx(HEADB);
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
