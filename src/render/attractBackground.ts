/**
 * "COMMON MOVIE" — a procedurally-animated attract-mode background for songs
 * with no BGA of their own. It recreates the DDRMAX/Extreme-era "common movie"
 * vibe, low-poly edition: the dancer is a faceted low-poly anime girl — every
 * body part is a few flat straight-edged facets in a small character palette
 * (soft skin, bright hair, dark top, accent skirt, boot trim), each plane
 * stepped lit-vs-shadow against a fixed upper-left key light so the form
 * reads as shaded 3D. Lines are a secondary accent: one crisp neon silhouette
 * outline per part plus a few soft intentional creases (waist seam, skirt
 * pleats, hair parting) — the internal triangulation is never stroked. Slim
 * hourglass figure, long spring-lagged twin-tails, an ahoge wisp, a
 * triangle-fan pleated skirt — throwing shapes inside a neon hexagon tunnel,
 * over a scrolling perspective checkerboard, everything pulsing to the beat.
 * Pure Canvas 2D so the GPU renderer can sample it as a live texture.
 *
 * Rendering budget: this runs on the main thread next to the WebGPU loop, so
 * there is deliberately NO per-pixel work — the plasma "lava lamp" is faked
 * with a few large moving radial gradients + additive compositing, and static
 * art (scanlines, sunburst rays, sparkle sprites) is baked once in the ctor.
 *
 * Motion splits two ways: `performance.now()` drives free-running continuous
 * motion (plasma drift, rotations, twinkle) so the scene never freezes even
 * with no song; `beat()` drives everything beat-locked (dancer poses, tunnel
 * pump, kick flashes). During the pre-song lead-in `beat()` may be negative or
 * NaN — the scene stays alive and the dancer idles to a gentle neutral bob.
 */

const W = 960;
const H = 540;
const CX = W / 2;
const VANISH_Y = H * 0.42; // tunnel + sunburst focal point
const HORIZON_Y = H * 0.6; // checkerboard horizon
const FOOT_Y = H * 0.86; // where the dancer's feet plant
const BODY_H = H * 0.55; // dancer height in px

type RGB = readonly [number, number, number];

/** One mood/variant's full color set (parsed to RGB for fast rgba() strings). */
interface Palette {
  gradTop: RGB;
  gradMid: RGB;
  gradBot: RGB;
  accentA: RGB; // hero: tunnel rings, dancer rim
  accentB: RGB; // secondary: floor lines, ghost trail
  accentC: RGB; // sparkles / beat flash
  accentD: RGB; // sunburst rays
  white: RGB; // on-beat flash core
  floorWire: boolean; // Healing Vision: pure wireframe floor, no filled cells
  sunHero: boolean; // Butterfly Sunrise: sunburst becomes the dominant layer
  petals: boolean; // Sakura Rush: sparkles are 5-petal blossoms
}

/** #rrggbb → [r,g,b]. */
function hex(s: string): RGB {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(c: RGB, a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** The 4 variants from the brief, keyed by the `variant` ctor arg (0..3). */
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
    floorWire: false,
    sunHero: false,
    petals: false,
  },
  {
    // 1 — Butterfly Sunrise: eurobeat stadium at golden hour, sunburst hero.
    gradTop: hex('#6A1A00'),
    gradMid: hex('#4A1200'),
    gradBot: hex('#1A0500'),
    accentA: hex('#FF0066'),
    accentB: hex('#FFC400'),
    accentC: hex('#FF3D2E'),
    accentD: hex('#FFC400'),
    white: hex('#FFF7F0'),
    floorWire: false,
    sunHero: true,
    petals: false,
  },
  {
    // 2 — Sakura Rush: dreamy J-pop random-movie, blossom sparkles.
    gradTop: hex('#3A0A3F'),
    gradMid: hex('#240433'),
    gradBot: hex('#14001F'),
    accentA: hex('#FF8AD8'),
    accentB: hex('#00FFC8'),
    accentC: hex('#FFFFFF'),
    accentD: hex('#FF8AD8'),
    white: hex('#FFFFFF'),
    floorWire: false,
    sunHero: false,
    petals: true,
  },
  {
    // 3 — Healing Vision: terminal-green cyber-rave, wireframe floor.
    gradTop: hex('#003318'),
    gradMid: hex('#001F0E'),
    gradBot: hex('#001406'),
    accentA: hex('#A8FF00'),
    accentB: hex('#00FFB2'),
    accentC: hex('#CFFF66'),
    accentD: hex('#00FFB2'),
    white: hex('#EAFFEA'),
    floorWire: true,
    sunHero: false,
    petals: false,
  },
];

/** A single keyframe of the dancer rig. Limb angles are ABSOLUTE, measured from
 *  straight-down: 0 = down, ±π = up, +π/2 = screen-right, -π/2 = screen-left.
 *  crouch/rise/shiftX are fractions of BODY_H. */
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

const PI = Math.PI;

/** The 8-beat loop. Each pose LANDS on its beat; see the brief's beat-by-beat. */
const POSES: readonly Pose[] = [
  // 1 — The Hit: right arm punched to the sky, right leg kicked to a toe-point.
  {
    crouch: 0,
    rise: 0.05,
    shiftX: 0,
    lean: 0.05,
    head: -0.12,
    armLUp: 0.15,
    armLLo: -1.7,
    armRUp: PI,
    armRLo: PI,
    legLUp: 0.03,
    legLLo: 0.03,
    legRUp: 0.55,
    legRLo: 0.75,
  },
  // 2 — Pull-down: elbow-drive at the ribs, knees bend, hips drop.
  {
    crouch: 0.06,
    rise: 0,
    shiftX: 0,
    lean: 0.02,
    head: 0.05,
    armLUp: -0.4,
    armLLo: 2.6,
    armRUp: 0.4,
    armRLo: -2.6,
    legLUp: 0.06,
    legLLo: 0.22,
    legRUp: -0.06,
    legRLo: -0.22,
  },
  // 3 — Roof ×1: both palms shove skyward, heels lift.
  {
    crouch: 0,
    rise: 0.06,
    shiftX: 0,
    lean: 0,
    head: -0.1,
    armLUp: PI + 0.2,
    armLLo: PI + 0.2,
    armRUp: PI - 0.2,
    armRLo: PI - 0.2,
    legLUp: 0.02,
    legLLo: 0.02,
    legRUp: -0.02,
    legRLo: -0.02,
  },
  // 4 — Roof ×2 with hip: same reach, hips slide right, head bobs opposite.
  {
    crouch: 0,
    rise: 0.05,
    shiftX: 0.06,
    lean: -0.06,
    head: 0.12,
    armLUp: PI + 0.15,
    armLLo: PI + 0.15,
    armRUp: PI - 0.15,
    armRLo: PI - 0.15,
    legLUp: 0.05,
    legLLo: 0.05,
    legRUp: 0.02,
    legRLo: 0.05,
  },
  // 5 — Side-step & throw: big step right, left arm sweeps across, right trails.
  {
    crouch: 0.02,
    rise: 0,
    shiftX: 0.08,
    lean: -0.05,
    head: 0.05,
    armLUp: 1.4,
    armLLo: 1.4,
    armRUp: 0.6,
    armRLo: 0.95,
    legLUp: -0.18,
    legLLo: -0.2,
    legRUp: 0.28,
    legRLo: 0.32,
  },
  // 6 — The wave: arms level at shoulder height, a body wave runs through.
  {
    crouch: 0.02,
    rise: 0,
    shiftX: 0.03,
    lean: 0.04,
    head: -0.05,
    armLUp: -1.5,
    armLLo: -1.25,
    armRUp: 1.5,
    armRLo: 1.25,
    legLUp: -0.05,
    legLLo: -0.05,
    legRUp: 0.05,
    legRLo: 0.05,
  },
  // 7 — Step back & spin prep: arms wind across the torso, hips coil.
  {
    crouch: 0.05,
    rise: 0,
    shiftX: 0,
    lean: -0.1,
    head: 0.1,
    armLUp: 0.8,
    armLLo: 2.0,
    armRUp: -0.8,
    armRLo: -2.0,
    legLUp: 0.1,
    legLLo: 0.15,
    legRUp: -0.1,
    legRLo: -0.15,
  },
  // 8 — Release: fling open wide into a big X, one leg back in a lunge.
  {
    crouch: 0,
    rise: 0.03,
    shiftX: 0,
    lean: 0.08,
    head: -0.15,
    armLUp: PI + 0.9,
    armLLo: PI + 0.9,
    armRUp: PI - 0.9,
    armRLo: PI - 0.9,
    legLUp: -0.4,
    legLLo: -0.5,
    legRUp: 0.3,
    legRLo: 0.45,
  },
];

// Joint indices into the flat [x,y,...] skeleton buffer. HAL/HAR are wrists
// (the hand diamond is drawn just beyond them) and FTL/FTR are ankles (the
// shoe wedge plants below them). TAILL/TAILR are the twin-tail tips, AHOGE is
// the cowlick tip, and SKIRT is a lagged point under the pelvis the hem sways
// off — all stateful (spring-lagged in solve()) so they live in the buffer
// and ride the ghost trails.
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

// Color zones for the low-poly fills. Each zone resolves to a 3-step ramp
// (0 shadow / 1 mid / 2 lit) built per-variant in the ctor, so the dancer
// reads as a colored character (skin, hair, outfit) instead of a monochrome
// wireframe while staying cohesive with the scene palette.
const ZSKIN = 0,
  ZHAIR = 1,
  ZDRESS = 2,
  ZSKIRT = 3,
  ZTRIM = 4,
  ZEYE = 5,
  ZBLUSH = 6;

// Bone lengths / widths as fractions of BODY_H — cute anime proportions:
// shorter torso, narrow shoulders, wider hips, long slim legs, short neck
// and a slightly oversized head (a bigger head reads cuter).
const L_TORSO = 0.3,
  L_NECK = 0.045,
  R_HEAD = 0.08,
  W_SHOULDER = 0.1,
  W_HIP = 0.082;
const L_UARM = 0.155,
  L_FARM = 0.125, // to the wrist — the hand extends ~0.05 beyond, matching old reach
  L_THIGH = 0.25,
  L_SHIN = 0.24,
  L_SHOE = 0.025; // ankle sits this far above the sole; the shoe wedge fills it

function easeSnap(p: number): number {
  // Back-ease-out: overshoots ~8% past the target then settles — moves "snap".
  const t = p - 1;
  const s = 1.7;
  return 1 + (s + 1) * t * t * t + s * t * t;
}
function lerpPose(a: Pose, b: Pose, e: number): Pose {
  const m = (x: number, y: number): number => x + (y - x) * e;
  return {
    crouch: m(a.crouch, b.crouch),
    rise: m(a.rise, b.rise),
    shiftX: m(a.shiftX, b.shiftX),
    lean: m(a.lean, b.lean),
    head: m(a.head, b.head),
    armLUp: m(a.armLUp, b.armLUp),
    armLLo: m(a.armLLo, b.armLLo),
    armRUp: m(a.armRUp, b.armRUp),
    armRLo: m(a.armRLo, b.armRLo),
    legLUp: m(a.legLUp, b.legLUp),
    legLLo: m(a.legLLo, b.legLLo),
    legRUp: m(a.legRUp, b.legRUp),
    legRLo: m(a.legRLo, b.legRLo),
  };
}

interface Sparkle {
  x: number;
  y: number;
  phase: number;
  speed: number;
  scale: number;
}

export class AttractBackground {
  /** Detached 960×540 canvas the GPU samples as the background. NOT in the DOM. */
  readonly canvas: HTMLCanvasElement;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly beat: () => number;
  private readonly pal: Palette;
  // Per-variant dancer fill ramps: [zone][0 shadow | 1 mid | 2 lit] strings.
  private readonly zoneFills: readonly (readonly string[])[];

  private readonly startMs = performance.now();
  private raf = 0;
  private running = false;
  private lastDraw = 0;

  // Baked-once assets.
  private readonly scanlines: CanvasPattern;
  private readonly sunburst: HTMLCanvasElement;
  private readonly sparkleSprite: HTMLCanvasElement;
  private readonly sparkles: Sparkle[] = [];
  private readonly burstJitter: number[] = []; // fixed offsets for hand-bursts

  // Dancer trail history (flat skeleton buffers, newest last).
  private readonly history: Float32Array[] = [];
  private readonly skel = new Float32Array(JOINTS * 2);
  // Secondary-motion state, smoothed across frames so hair/cloth lag the body.
  // The twin-tail tips are full velocity springs (they overshoot, so fast
  // poses make them whip); the ahoge and skirt points are simple lags.
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

  constructor(opts: { beat: () => number; variant?: number }) {
    this.beat = opts.beat;
    this.pal =
      PALETTES[(((opts.variant ?? 0) % PALETTES.length) + PALETTES.length) % PALETTES.length];

    // Dancer color zones, derived from this variant's palette: bright hair
    // (accentA), accent skirt (accentB), trim boots/scrunchies (accentC), a
    // dark top, and a soft skin tone. Each is a 3-step flat-shading ramp
    // toward near-black ink — kept moderate so the character reads in color
    // without competing with the neon arrows drawn in front of her.
    const ink: RGB = [6, 7, 14];
    const ramp = (c: RGB, sh: number, md: number, lt: number): readonly string[] => [
      rgba(mix(ink, c, sh), 1),
      rgba(mix(ink, c, md), 1),
      rgba(mix(ink, c, lt), 1),
    ];
    const skin = mix([255, 213, 190], this.pal.white, 0.2);
    const eye = rgba(mix(ink, this.pal.accentA, 0.2), 0.9);
    const blush = rgba(mix(this.pal.accentA, [255, 118, 148], 0.5), 0.3);
    this.zoneFills = [
      ramp(skin, 0.26, 0.52, 0.8), // ZSKIN — face, arms, thighs
      ramp(this.pal.accentA, 0.24, 0.5, 0.82), // ZHAIR — bangs, tails, back-mass
      ramp(this.pal.accentA, 0.12, 0.22, 0.34), // ZDRESS — dark fitted top
      ramp(this.pal.accentB, 0.22, 0.48, 0.75), // ZSKIRT — pleat fan
      ramp(this.pal.accentC, 0.2, 0.4, 0.6), // ZTRIM — boots, cuffs, scrunchies
      [eye, eye, eye], // ZEYE — flat, shade-independent
      [blush, blush, blush], // ZBLUSH — translucent over the face
    ];

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('AttractBackground: 2D context unavailable');
    this.ctx = ctx;

    this.scanlines = this.makeScanlines();
    this.sunburst = this.makeSunburst();
    this.sparkleSprite = this.makeSparkleSprite();

    // Seed a fixed sparkle field in the upper 2/3 (kept off dead-center so the
    // outer thirds stay alive behind the note field).
    for (let i = 0; i < 50; i++) {
      this.sparkles.push({
        x: Math.random() * W,
        y: Math.random() * H * 0.7,
        phase: Math.random() * PI * 2,
        speed: 1.5 + Math.random() * 3,
        scale: 0.4 + Math.random() * 0.9,
      });
    }
    for (let i = 0; i < 12; i++) this.burstJitter.push((Math.random() - 0.5) * 60);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastDraw = 0;
    // Cap at ~30fps. It's a background — 30fps is imperceptible here, halves the
    // draw + per-frame GPU-upload cost (which otherwise scales with the display's
    // refresh rate, up to 240Hz), and matches the 30fps motion-JPEG loops the
    // real DDR "common movies" ran at. It also keeps the two-page versus render
    // from starving.
    const FRAME_MS = 1000 / 30;
    const tick = (now: number): void => {
      if (!this.running) return;
      if (now - this.lastDraw >= FRAME_MS - 1) {
        this.lastDraw = now;
        this.draw();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // ---- baked assets -------------------------------------------------------

  /** A 1×3px pattern: one faint dark row, two transparent — cheap CRT scanlines. */
  private makeScanlines(): CanvasPattern {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 3;
    const g = c.getContext('2d');
    if (!g) throw new Error('scanline ctx');
    g.fillStyle = 'rgba(0,0,0,0.26)';
    g.fillRect(0, 0, 1, 1);
    const p = this.ctx.createPattern(c, 'repeat');
    if (!p) throw new Error('scanline pattern');
    return p;
  }

  /** 16 alternating radial wedges faded at the rim — the rotating sunburst. */
  private makeSunburst(): HTMLCanvasElement {
    const size = 1100;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    if (!g) throw new Error('sunburst ctx');
    const mid = size / 2;
    const r = mid;
    g.translate(mid, mid);
    g.fillStyle = rgba(this.pal.accentD, 1);
    for (let i = 0; i < 16; i += 2) {
      const a0 = (i / 16) * PI * 2;
      const a1 = ((i + 1) / 16) * PI * 2;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(Math.cos(a0) * r, Math.sin(a0) * r);
      g.lineTo(Math.cos(a1) * r, Math.sin(a1) * r);
      g.closePath();
      g.fill();
    }
    // Fade the rim (and slightly hollow the core) with a radial alpha mask.
    g.globalCompositeOperation = 'destination-in';
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.35)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.9)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(-mid, -mid, size, size);
    return c;
  }

  /** A soft 4-point spark (or 5-petal blossom for Sakura), tinted per-variant. */
  private makeSparkleSprite(): HTMLCanvasElement {
    const size = 48;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    if (!g) throw new Error('sparkle ctx');
    const mid = size / 2;
    g.translate(mid, mid);

    if (this.pal.petals) {
      // Five blossom petals + a bright core.
      g.fillStyle = rgba(this.pal.accentA, 0.9);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * PI * 2 - PI / 2;
        g.save();
        g.rotate(a);
        g.beginPath();
        g.ellipse(0, -7, 4, 8, 0, 0, PI * 2);
        g.fill();
        g.restore();
      }
      g.fillStyle = rgba(this.pal.white, 1);
      g.beginPath();
      g.arc(0, 0, 3.5, 0, PI * 2);
      g.fill();
      return c;
    }

    // Soft glowing core.
    const glow = g.createRadialGradient(0, 0, 0, 0, 0, mid);
    glow.addColorStop(0, rgba(this.pal.white, 1));
    glow.addColorStop(0.25, rgba(this.pal.accentC, 0.8));
    glow.addColorStop(1, rgba(this.pal.accentC, 0));
    g.fillStyle = glow;
    g.beginPath();
    g.arc(0, 0, mid, 0, PI * 2);
    g.fill();
    // Four sharp spikes.
    g.strokeStyle = rgba(this.pal.white, 0.9);
    g.lineCap = 'round';
    g.lineWidth = 1.4;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * PI * 2;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(Math.cos(a) * mid, Math.sin(a) * mid);
      g.stroke();
    }
    return c;
  }

  // ---- frame --------------------------------------------------------------

  private draw(): void {
    const ctx = this.ctx;
    const time = (performance.now() - this.startMs) / 1000;
    const rawBeat = this.beat();
    const valid = Number.isFinite(rawBeat) && rawBeat >= 0;

    // Beat-locked drivers. When there's no song, synthesize a slow ~84bpm beat
    // so the tunnel/floor keep drifting, but suppress the hard kick flashes.
    const beat = valid ? rawBeat : time * 1.4;
    const phase = beat - Math.floor(beat);
    const kick = valid ? Math.exp(-6 * phase) : 0;
    const mBeat = beat - 4 * Math.floor(beat / 4); // 0..4 within the measure
    const downKick = valid ? Math.exp(-3 * mBeat) : 0;

    // Base vertical gradient (drawn un-zoomed so corners always stay filled).
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, rgba(this.pal.gradTop, 1));
    bg.addColorStop(0.55, rgba(this.pal.gradMid, 1));
    bg.addColorStop(1, rgba(this.pal.gradBot, 1));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Everything below breathes with a subtle on-beat "camera kick" zoom about
    // the vanishing point.
    ctx.save();
    const z = 1 + 0.015 * kick;
    ctx.translate(CX, VANISH_Y);
    ctx.scale(z, z);
    ctx.translate(-CX, -VANISH_Y);

    this.drawPlasma(time);
    this.drawSunburst(time, downKick);
    this.drawTunnel(time, beat, kick);
    this.drawFloor(beat, kick, downKick);
    this.drawSparkles(time, beat);
    this.drawDancer(time, beat, valid, kick);

    ctx.restore();

    this.drawPost(downKick);
  }

  /** Lava-lamp underlayment: a few big drifting radial gradients, kept dark and
   *  additive so it only ever glows the void, never washes it out. */
  private drawPlasma(time: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const blobs: readonly [number, number, RGB][] = [
      [0.3, 0.35, this.pal.gradMid],
      [0.72, 0.55, this.pal.accentA],
      [0.5, 0.75, this.pal.gradTop],
    ];
    for (let i = 0; i < blobs.length; i++) {
      const [bx, by, col] = blobs[i];
      const px = (bx + 0.12 * Math.sin(time * 0.23 + i * 2)) * W;
      const py = (by + 0.12 * Math.cos(time * 0.19 + i * 3)) * H;
      const r = W * 0.42;
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, rgba(col, 0.13));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  /** Rotating god-rays from the vanishing point; barely there until the beat. */
  private drawSunburst(time: number, downKick: number): void {
    const ctx = this.ctx;
    const base = 0.1 * (this.pal.sunHero ? 2.6 : 1);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = base + 0.16 * downKick;
    ctx.translate(CX, VANISH_Y);
    ctx.rotate(time * 0.12);
    const s = 1.5;
    ctx.drawImage(
      this.sunburst,
      (-this.sunburst.width * s) / 2,
      (-this.sunburst.height * s) / 2,
      this.sunburst.width * s,
      this.sunburst.height * s,
    );
    ctx.restore();
  }

  /** The hero: concentric hexagon outlines rushing outward, pumping 1 band /
   *  2 beats, hue-cycling per ring, newest ring flashing white on the beat. */
  private drawTunnel(time: number, beat: number, kick: number): void {
    const ctx = this.ctx;
    const N = 12;
    const maxR = 820;
    const rot = 0.35 * Math.sin(time * 0.18); // slow ± sway, self-reversing
    const pump = beat * 0.5;
    const frac = pump - Math.floor(pump);
    const ringBase = Math.floor(pump);
    const hues: readonly RGB[] = [this.pal.accentA, this.pal.accentB, this.pal.accentD];

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    for (let i = 0; i < N; i++) {
      const p = (i + frac) / N; // 0 (center) .. 1 (edge)
      const radius = maxR * p * p; // quadratic → strong perspective foreshortening
      if (radius < 2) continue;
      let col = hues[(i + ringBase) % hues.length];
      // Innermost freshly-spawned ring blooms toward white on each beat.
      if (i === 0) col = mix(col, this.pal.white, kick);
      const alpha = (1 - p * 0.7) * (0.85 - 0.3 * p);
      ctx.strokeStyle = rgba(col, Math.max(0, alpha));
      ctx.lineWidth = 2 + p * 7;
      ctx.beginPath();
      for (let k = 0; k <= 6; k++) {
        const a = rot + (k / 6) * PI * 2;
        const x = CX + Math.cos(a) * radius;
        const y = VANISH_Y + Math.sin(a) * radius;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Perspective checkerboard treadmill scrolling toward the viewer at 2 cells /
   *  beat, cyan grid lines, fogged out to black at the horizon. */
  private drawFloor(beat: number, kick: number, downKick: number): void {
    const ctx = this.ctx;
    const rows = 14;
    const cols = 7; // columns each side of centre
    const spread = W * 0.62; // half-width of the floor at the near edge
    const scroll = beat * 2;
    const sFrac = scroll - Math.floor(scroll);
    const sInt = Math.floor(scroll);
    const cellCol = mix(this.pal.gradMid, this.pal.accentB, 0.15 * kick);

    // Vertical position + horizontal spread at floor-param t (0 horizon, 1 near).
    const rowY = (t: number): number => HORIZON_Y + (H - HORIZON_Y) * t * t;
    const colX = (c: number, t: number): number => CX + c * (spread / cols) * t;

    ctx.save();
    // Filled checker cells (skipped entirely for the wireframe variant).
    if (!this.pal.floorWire) {
      for (let r = 0; r < rows; r++) {
        const t0 = (r + sFrac) / rows;
        const t1 = (r + 1 + sFrac) / rows;
        if (t1 > 1) continue;
        const y0 = rowY(t0);
        const y1 = rowY(t1);
        const fog = Math.min(1, t0 * 1.6); // fade rows out toward the horizon
        for (let c = -cols; c < cols; c++) {
          if (((r + c + sInt) & 1) === 0) continue; // checker parity
          ctx.fillStyle = rgba(cellCol, 0.5 * fog);
          ctx.beginPath();
          ctx.moveTo(colX(c, t0), y0);
          ctx.lineTo(colX(c + 1, t0), y0);
          ctx.lineTo(colX(c + 1, t1), y1);
          ctx.lineTo(colX(c, t1), y1);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // Neon grid lines over the top.
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1.2;
    // Horizontal rows.
    for (let r = 0; r <= rows; r++) {
      const t = (r + sFrac) / rows;
      if (t > 1) continue;
      const y = rowY(t);
      const fog = Math.min(1, t * 1.6);
      const flash = ((r + sInt) & 3) === 0 ? downKick : 0; // downbeat line pops
      ctx.strokeStyle = rgba(mix(this.pal.accentB, this.pal.white, flash), 0.5 * fog);
      ctx.beginPath();
      ctx.moveTo(colX(-cols, t), y);
      ctx.lineTo(colX(cols, t), y);
      ctx.stroke();
    }
    // Converging verticals (horizon → near edge).
    for (let c = -cols; c <= cols; c++) {
      ctx.strokeStyle = rgba(this.pal.accentB, 0.35);
      ctx.beginPath();
      ctx.moveTo(colX(c, 0), rowY(0));
      ctx.lineTo(colX(c, 1), rowY(1));
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Twinkling star/blossom field; each spark snaps on with pow(sin,8). A few
   *  re-roll their position every measure so the field stays alive. */
  private drawSparkles(time: number, beat: number): void {
    const ctx = this.ctx;
    const measure = Math.floor(beat);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.sparkles.length; i++) {
      const s = this.sparkles[i];
      // Re-seed one sparkle per integer beat for gentle churn.
      if (i === measure % this.sparkles.length && beat - measure < 0.05) {
        s.x = Math.random() * W;
        s.y = Math.random() * H * 0.7;
      }
      const tw = Math.sin(s.phase + time * s.speed);
      if (tw <= 0) continue;
      const b = tw * tw * tw * tw * tw * tw * tw * tw; // pow(...,8): sharp snap
      const size = 46 * s.scale * b;
      if (size < 1) continue;
      ctx.globalAlpha = Math.min(1, b + 0.2);
      ctx.drawImage(this.sparkleSprite, s.x - size / 2, s.y - size / 2, size, size);
    }
    ctx.restore();
  }

  // ---- dancer -------------------------------------------------------------

  /** Solve the rig forward-kinematically into `this.skel` (flat x,y pairs).
   *  `bob` (the beat bounce, px) is baked into the root here — instead of
   *  being added after the fact — so the hair/skirt springs feel it and react.
   *  `time` only drives the ahoge's slow idle wobble. */
  private solve(pose: Pose, time: number, bob: number): void {
    const s = this.skel;
    const rootX = CX + pose.shiftX * BODY_H;
    const rootY =
      FOOT_Y -
      (L_THIGH + L_SHIN + L_SHOE) * BODY_H +
      pose.crouch * BODY_H -
      pose.rise * BODY_H -
      bob;

    const set = (idx: number, x: number, y: number): void => {
      s[idx * 2] = x;
      s[idx * 2 + 1] = y;
    };
    // Absolute-angle limb step: 0 = down, ±π = up, +π/2 = right.
    const tip = (x: number, y: number, ang: number, len: number): [number, number] => [
      x + Math.sin(ang) * len * BODY_H,
      y + Math.cos(ang) * len * BODY_H,
    ];

    set(PEL, rootX, rootY);
    // Torso points up, tilted by lean.
    const [shx, shy] = tip(rootX, rootY, PI + pose.lean, L_TORSO);
    set(SH, shx, shy);
    const [nbx, nby] = tip(shx, shy, PI + pose.lean, L_NECK);
    set(HEADB, nbx, nby);
    set(HEAD, nbx + Math.sin(pose.head) * R_HEAD * BODY_H, nby - R_HEAD * BODY_H * 0.9);

    set(SHL, shx - W_SHOULDER * BODY_H, shy);
    set(SHR, shx + W_SHOULDER * BODY_H, shy);
    const [ellx, elly] = tip(s[SHL * 2], s[SHL * 2 + 1], pose.armLUp, L_UARM);
    set(ELL, ellx, elly);
    set(HAL, ...tip(ellx, elly, pose.armLLo, L_FARM));
    const [elrx, elry] = tip(s[SHR * 2], s[SHR * 2 + 1], pose.armRUp, L_UARM);
    set(ELR, elrx, elry);
    set(HAR, ...tip(elrx, elry, pose.armRLo, L_FARM));

    set(HIPL, rootX - W_HIP * BODY_H, rootY);
    set(HIPR, rootX + W_HIP * BODY_H, rootY);
    const [knlx, knly] = tip(s[HIPL * 2], s[HIPL * 2 + 1], pose.legLUp, L_THIGH);
    set(KNL, knlx, knly);
    set(FTL, ...tip(knlx, knly, pose.legLLo, L_SHIN));
    const [knrx, knry] = tip(s[HIPR * 2], s[HIPR * 2 + 1], pose.legRUp, L_THIGH);
    set(KNR, knrx, knry);
    set(FTR, ...tip(knrx, knry, pose.legRLo, L_SHIN));

    // ---- secondary motion: twin-tails, ahoge, skirt --------------------
    const B = BODY_H;
    const hx = s[HEAD * 2];
    const hy = s[HEAD * 2 + 1];
    const r = R_HEAD * B;
    // Head tilt whips both tails toward the trailing side.
    const swing = Math.sin(pose.head) * r * 3;

    // Twin-tail tips: velocity springs chasing a rest point that hangs
    // down-and-out from each side of the head. Underdamped on purpose — fast
    // pose snaps overshoot the rest point and the tails whip. Stretch is
    // clamped so a teleport/NaN recovery frame can't tear a tail off. The
    // rest point hangs LOW: full long tails past the shoulder line.
    const K = 0.055;
    const DAMP = 0.8;
    const MAXLEN = 0.56 * B;
    const spring = (
      side: number,
      px: number,
      py: number,
      vx: number,
      vy: number,
    ): [number, number, number, number] => {
      const bx = hx + side * r * 0.85;
      const by = hy - r * 0.1;
      const rx = bx + side * 0.09 * B - swing;
      const ry = by + 0.4 * B;
      if (!Number.isFinite(rx) || !Number.isFinite(ry)) return [px, py, 0, 0];
      if (
        !Number.isFinite(px) ||
        !Number.isFinite(py) ||
        !Number.isFinite(vx) ||
        !Number.isFinite(vy)
      ) {
        return [rx, ry, 0, 0];
      }
      vx = (vx + (rx - px) * K) * DAMP;
      vy = (vy + (ry - py) * K) * DAMP;
      px += vx;
      py += vy;
      const dx = px - bx;
      const dy = py - by;
      const d = Math.hypot(dx, dy);
      if (d > MAXLEN) {
        px = bx + (dx / d) * MAXLEN;
        py = by + (dy / d) * MAXLEN;
      }
      return [px, py, vx, vy];
    };
    [this.tailLX, this.tailLY, this.tailLVX, this.tailLVY] = spring(
      -1,
      this.tailLX,
      this.tailLY,
      this.tailLVX,
      this.tailLVY,
    );
    [this.tailRX, this.tailRY, this.tailRVX, this.tailRVY] = spring(
      1,
      this.tailRX,
      this.tailRY,
      this.tailRVX,
      this.tailRVY,
    );
    set(TAILL, this.tailLX, this.tailLY);
    set(TAILR, this.tailRX, this.tailRY);

    // Ahoge tip: a lagged point above the crown with a slow idle wobble so
    // the cowlick is never perfectly still even in the NaN-beat idle.
    const ahRX = hx + Math.sin(pose.head) * r * 0.6 + Math.sin(time * 2.1) * 0.012 * B;
    const ahRY = hy - r * 1.9 + Math.cos(time * 1.7) * 0.005 * B;
    if (!Number.isFinite(this.ahogeX) || !Number.isFinite(this.ahogeY)) {
      this.ahogeX = ahRX;
      this.ahogeY = ahRY;
    }
    this.ahogeX += (ahRX - this.ahogeX) * 0.22;
    this.ahogeY += (ahRY - this.ahogeY) * 0.3;
    set(AHOGE, this.ahogeX, this.ahogeY);

    // Skirt anchor: a lagged point under the pelvis. drawBody() reads the
    // offset between it and the pelvis to sway/flare the hem, so the skirt
    // trails lateral hip moves and floats a touch on drops and bounces.
    const skRX = rootX;
    const skRY = rootY + 0.1 * B;
    if (!Number.isFinite(this.skirtX) || !Number.isFinite(this.skirtY)) {
      this.skirtX = skRX;
      this.skirtY = skRY;
    }
    this.skirtX += (skRX - this.skirtX) * 0.16;
    this.skirtY += (skRY - this.skirtY) * 0.22;
    set(SKIRT, this.skirtX, this.skirtY);
  }

  /** Paint the dancer from a flat joint buffer as a shaded low-poly model.
   *  Form comes from the FILLS: every part is a handful of flat straight-edged
   *  facets colored from a small per-variant character palette (skin / hair /
   *  dark top / skirt / trim), each plane stepped lit-vs-shadow against a
   *  fixed upper-left key light so the model reads as 3D. Lines are a
   *  secondary accent: one crisp neon SILHOUETTE per part plus a few soft
   *  intentional creases (waist seam, skirt pleats, hair parting) — internal
   *  facet edges are never stroked. `mode` picks the pass — 'glow' strokes a
   *  fat additive rim along the silhouette, 'body' paints the colored fills
   *  then the lines, 'trail' strokes only the silhouette as a faint ghost.
   *  All geometry derives from the buffer alone so trails replay old frames. */
  private drawBody(
    j: Float32Array,
    mode: 'glow' | 'body' | 'trail',
    color: RGB,
    alpha: number,
    rim: number,
  ): void {
    const ctx = this.ctx;
    const B = BODY_H;
    const X = (i: number): number => j[i * 2];
    const Y = (i: number): number => j[i * 2 + 1];

    // Fixed key light (upper-left): facets whose outward normal points toward
    // it take the lit step of their zone's ramp, the rest fall to shadow.
    const LX = -0.62;
    const LY = -0.78;

    // Facets: flat [x,y,...] polygons resolved to a zone-ramp fill, painted
    // in insertion order (later facets cover earlier ones). Fills only exist
    // in the 'body' pass — glow/trail are pure line passes.
    const fills = this.zoneFills;
    const facets: { p: number[]; f: string }[] = [];
    const F = (z: number, s: number, p: number[]): void => {
      if (mode === 'body') facets.push({ p, f: fills[z][s] });
    };
    // Edges: the few deliberate lines. `soft` creases render only in 'body';
    // bright edges are the per-part silhouettes that every pass strokes.
    const edges: { p: number[]; closed: boolean; soft: boolean }[] = [];
    const E = (soft: boolean, closed: boolean, p: number[]): void => {
      edges.push({ p, closed, soft });
    };

    // Angular tapered limb segment as a two-facet prism: the ridge line runs
    // off-axis so the two faces are unequal, and a mid-edge knot vertex keeps
    // the outline faceted instead of smooth. Which face is lit is decided by
    // the key light, not by the caller. The silhouette is ONE open polyline —
    // open at joint `a` so no cap line crosses the parent joint (the `b`-end
    // cap reads as the elbow/knee crease). Both ends overshoot the joints a
    // touch so bent elbows/knees don't gap.
    const limb = (a: number, b: number, wa: number, wb: number, z: number, line: boolean): void => {
      let ax = X(a),
        ay = Y(a),
        bx = X(b),
        by = Y(b);
      let dx = bx - ax,
        dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const o = 0.012 * B;
      ax -= dx * o;
      ay -= dy * o;
      bx += dx * o;
      by += dy * o;
      const px = -dy,
        py = dx;
      const wA = wa * B,
        wB = wb * B,
        wM = Math.max(wA, wB) * 1.12;
      const mx = ax + dx * (len + 2 * o) * 0.45,
        my = ay + dy * (len + 2 * o) * 0.45;
      const ro = -0.2; // ridge offset → asymmetric lit/shadow faces
      const arx = ax + px * wA * ro,
        ary = ay + py * wA * ro;
      const brx = bx + px * wB * ro,
        bry = by + py * wB * ro;
      const minusLit = px * LX + py * LY < 0; // the -p face points at the light
      // prettier-ignore
      F(z, minusLit ? 2 : 1, [
        arx, ary, brx, bry,
        bx - px * wB, by - py * wB,
        mx - px * wM, my - py * wM,
        ax - px * wA, ay - py * wA]);
      // prettier-ignore
      F(z, minusLit ? 1 : 2, [
        arx, ary, brx, bry,
        bx + px * wB, by + py * wB,
        mx + px * wM, my + py * wM,
        ax + px * wA, ay + py * wA]);
      if (line) {
        // prettier-ignore
        E(false, false, [
          ax - px * wA, ay - py * wA,
          mx - px * wM, my - py * wM,
          bx - px * wB, by - py * wB,
          bx + px * wB, by + py * wB,
          mx + px * wM, my + py * wM,
          ax + px * wA, ay + py * wA]);
      }
    };

    // Hand: a small skin diamond just beyond the wrist, along the forearm.
    const hand = (elb: number, wri: number): void => {
      const wx = X(wri),
        wy = Y(wri);
      let dx = wx - X(elb),
        dy = wy - Y(elb);
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const px = -dy,
        py = dx;
      const cx = wx + dx * 0.022 * B,
        cy = wy + dy * 0.022 * B;
      // prettier-ignore
      const p = [
        wx - dx * 0.012 * B, wy - dy * 0.012 * B,
        cx + px * 0.026 * B, cy + py * 0.026 * B,
        wx + dx * 0.06 * B, wy + dy * 0.06 * B,
        cx - px * 0.026 * B, cy - py * 0.026 * B];
      F(ZSKIN, 2, p);
      E(false, true, p);
    };

    // Dainty flat off the ankle: one angular wedge. When the shin hangs
    // straight the toe points outward and the sole sits on the floor line; as
    // the leg kicks the toe blends toward the shin direction (a toe-point).
    const shoe = (kne: number, ank: number, side: number): void => {
      const ax = X(ank),
        ay = Y(ank);
      const shinAng = Math.atan2(ax - X(kne), ay - Y(kne)); // 0 = down (Pose convention)
      const blend = Math.min(1, Math.abs(shinAng));
      const toeAng = side * 1.25 * (1 - blend) + shinAng * blend;
      const dx = Math.sin(toeAng),
        dy = Math.cos(toeAng);
      let px = Math.cos(toeAng),
        py = -Math.sin(toeAng);
      if (py < 0) {
        px = -px;
        py = -py; // perp points toward the sole
      }
      const tl = 0.07 * B;
      const tx = ax + dx * tl,
        ty = ay + dy * tl;
      // ankle line → instep knot → toe tip → toe under → heel
      // prettier-ignore
      const p = [
        ax - dx * 0.018 * B - px * 0.018 * B, ay - dy * 0.018 * B - py * 0.018 * B,
        ax + dx * 0.03 * B - px * 0.02 * B, ay + dy * 0.03 * B - py * 0.02 * B,
        tx - px * 0.004 * B, ty - py * 0.004 * B,
        tx + px * 0.013 * B, ty + py * 0.013 * B,
        ax - dx * 0.035 * B + px * 0.02 * B, ay - dy * 0.035 * B + py * 0.02 * B];
      F(ZTRIM, 1, p);
      E(false, true, p);
    };

    // Knee-boot cuff: an angular band just below the knee, a hair wider than
    // the shin so it notches the silhouette like a boot/thigh-high top.
    const cuff = (kne: number, ank: number): void => {
      const kx = X(kne),
        ky = Y(kne);
      let dx = X(ank) - kx,
        dy = Y(ank) - ky;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const px = -dy,
        py = dx;
      const cx = kx + dx * 0.055 * B,
        cy = ky + dy * 0.055 * B;
      const w = 0.042 * B,
        h = 0.013 * B;
      // prettier-ignore
      F(ZTRIM, 2, [
        cx - px * w - dx * h, cy - py * w - dy * h,
        cx + px * w - dx * h, cy + py * w - dy * h,
        cx + px * w + dx * h, cy + py * w + dy * h,
        cx - px * w + dx * h, cy - py * w + dy * h]);
    };

    // ---- torso frame (shared by torso plates and skirt fan) ---------------
    const plx = X(PEL),
      ply = Y(PEL),
      scx = X(SH),
      scy = Y(SH);
    let ux = scx - plx,
      uy = scy - ply;
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul;
    uy /= ul; // unit pelvis→shoulder axis
    const vx = -uy,
      vy = ux; // unit "screen right" of the torso axis
    const at = (t: number, w: number): [number, number] => [
      plx + ux * ul * t + vx * w,
      ply + uy * ul * t + vy * w,
    ];

    const hx = X(HEAD),
      hy = Y(HEAD),
      r = R_HEAD * B;
    const tilt = hx - X(HEADB); // signed head-tilt offset, drives the hair back

    // ---- twin-tails (first: behind everything): full tapered strips from a
    // side-of-head base out to the spring-lagged tip — a slight mid-bulge
    // then a long taper to the point. Each tail is ONE flat hair fill (lit on
    // the key-light side) with a darker tip step and a single open silhouette
    // line; the internal segment edges are never stroked. A bright scrunchie
    // diamond sits at the base.
    const tail = (side: number, tipI: number): void => {
      const bx = hx + side * r * 0.85,
        by = hy - r * 0.1;
      const tx = X(tipI),
        ty = Y(tipI);
      let dx = tx - bx,
        dy = ty - by;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const px = -dy,
        py = dx;
      const zig = side * 0.02 * B; // gentle spine zigzag → angular S-curve
      const p1x = bx + dx * len * 0.4 + px * zig,
        p1y = by + dy * len * 0.4 + py * zig;
      const p2x = bx + dx * len * 0.74 - px * zig * 0.6,
        p2y = by + dy * len * 0.74 - py * zig * 0.6;
      const w0 = 0.042 * B,
        w1 = 0.05 * B,
        w2 = 0.026 * B;
      // prettier-ignore
      const strip = [
        bx - px * w0, by - py * w0,
        p1x - px * w1, p1y - py * w1,
        p2x - px * w2, p2y - py * w2,
        tx, ty,
        p2x + px * w2, p2y + py * w2,
        p1x + px * w1, p1y + py * w1,
        bx + px * w0, by + py * w0];
      F(ZHAIR, side < 0 ? 2 : 1, strip);
      // prettier-ignore
      F(ZHAIR, side < 0 ? 1 : 0, [
        p2x - px * w2, p2y - py * w2, tx, ty, p2x + px * w2, p2y + py * w2]);
      E(false, false, strip);
      // prettier-ignore
      F(ZTRIM, 2, [
        bx, by - 0.028 * B, bx + 0.022 * B, by, bx, by + 0.028 * B, bx - 0.022 * B, by]);
    };
    tail(-1, TAILL);
    tail(1, TAILR);

    // ---- legs: bare skin thighs, knee-high boot shins, cuff band, shoe.
    limb(HIPL, KNL, 0.054, 0.037, ZSKIN, true);
    limb(KNL, FTL, 0.035, 0.016, ZTRIM, true);
    cuff(KNL, FTL);
    shoe(KNL, FTL, -1);
    limb(HIPR, KNR, 0.054, 0.037, ZSKIN, true);
    limb(KNR, FTR, 0.035, 0.016, ZTRIM, true);
    cuff(KNR, FTR);
    shoe(KNR, FTR, 1);

    // ---- torso: a dark fitted top. Chest split at the sternum into lit and
    // shadow planes (key light hits the left plane), a waist plate and a
    // pelvis wedge — an angular hourglass (narrow shoulders, pinched waist,
    // wider hips). The silhouette line is open at the bottom where the skirt
    // takes over; the waist seam is a deliberate soft crease.
    const shW = 0.096 * B,
      waistW = 0.05 * B,
      hipW = 0.098 * B;
    const [lsx, lsy] = at(1.02, -shW);
    const [rsx, rsy] = at(1.02, shW);
    const [cpx, cpy] = at(1.08, 0); // collar point
    const [wlx, wly] = at(0.42, -waistW);
    const [wrx, wry] = at(0.42, waistW);
    const [sbx, sby] = at(0.42, 0); // sternum bottom
    F(ZDRESS, 2, [cpx, cpy, lsx, lsy, wlx, wly, sbx, sby]); // chest, lit plane
    F(ZDRESS, 0, [cpx, cpy, rsx, rsy, wrx, wry, sbx, sby]); // chest, shadow plane
    const [hlx, hly] = at(0.04, -hipW);
    const [hrx, hry] = at(0.04, hipW);
    F(ZDRESS, 1, [wlx, wly, wrx, wry, hrx, hry, hlx, hly]); // waist plate
    const [pbx, pby] = at(-0.12, 0);
    F(ZDRESS, 0, [hlx, hly, hrx, hry, pbx, pby]); // pelvis wedge
    const [tLx, tLy] = at(0.18, -0.08 * B);
    const [tRx, tRy] = at(0.18, 0.08 * B);
    E(false, false, [tLx, tLy, wlx, wly, lsx, lsy, cpx, cpy, rsx, rsy, wrx, wry, tRx, tRy]);
    E(true, false, [wlx, wly, wrx, wry]); // waist seam crease
    // shoulder caps: small diamonds over the arm sockets
    const cap = (i: number, s: number): void => {
      const x = X(i),
        y = Y(i);
      // prettier-ignore
      F(ZDRESS, s, [
        x + ux * 0.032 * B, y + uy * 0.032 * B,
        x + vx * 0.05 * B, y + vy * 0.05 * B,
        x - ux * 0.032 * B, y - uy * 0.032 * B,
        x - vx * 0.05 * B, y - vy * 0.05 * B]);
    };
    cap(SHL, 2);
    cap(SHR, 0);

    // ---- pleated skirt: a SHORT triangle fan off the hip line — each pleat
    // is one hard-edged triangle, alternating lit/shadow shades, ending in a
    // zigzag handkerchief hem. The hem chases the lagged SKIRT point so it
    // sways opposite lateral moves and flares/lifts a touch on drops,
    // bounces and big poses — while staying well above the knee so the leg
    // pose still reads.
    {
      const skm = 0.05 * B;
      const hemOff = Math.max(-skm, Math.min(skm, X(SKIRT) - plx));
      const vLag = Y(SKIRT) - (ply + 0.1 * B);
      const lift = Math.min(0.045 * B, Math.abs(hemOff) * 0.8 + Math.abs(vLag) * 0.7);
      const hemW = 0.16 * B + lift;
      const drop = 0.12 * B - lift * 0.6;
      const [fx, fy] = at(0.2, 0); // fan origin, just above the pelvis
      const pts: number[] = [];
      for (let k = 0; k <= 6; k++) {
        let x: number, y: number;
        if (k === 0 || k === 6) {
          // hem corners ride up to the hip line so the fan roots at the hips
          const side = k === 0 ? -1 : 1;
          [x, y] = at(0.06, side * (hipW + 0.02 * B) + hemOff * 0.3);
        } else {
          const d2 = drop + (k % 2 === 1 ? 0.022 * B : 0); // pleat points dip
          [x, y] = at(-d2 / ul, hemW * ((k - 3) / 2) + hemOff);
        }
        pts.push(x, y);
      }
      for (let k = 0; k < 6; k++) {
        F(ZSKIRT, k % 2 === 0 ? 2 : 0, [
          fx,
          fy,
          pts[k * 2],
          pts[k * 2 + 1],
          pts[k * 2 + 2],
          pts[k * 2 + 3],
        ]);
      }
      // hem silhouette across the pleat points (open — the top edge is the
      // waist), plus soft pleat creases running partway up the fan.
      E(false, false, pts);
      for (let k = 1; k < 6; k++) {
        E(true, false, [
          fx + (pts[k * 2] - fx) * 0.42,
          fy + (pts[k * 2 + 1] - fy) * 0.42,
          pts[k * 2],
          pts[k * 2 + 1],
        ]);
      }
    }

    // ---- arms: slim bare-skin prisms + hand diamonds.
    limb(SHL, ELL, 0.03, 0.021, ZSKIN, true);
    limb(ELL, HAL, 0.02, 0.014, ZSKIN, true);
    hand(ELL, HAL);
    limb(SHR, ELR, 0.03, 0.021, ZSKIN, true);
    limb(ELR, HAR, 0.02, 0.014, ZSKIN, true);
    hand(ELR, HAR);

    // ---- neck + head. The head is the waifu focal point, kept CLEAN: one
    // crisp silhouette around hair + face, a smooth lit skin plane with a
    // single narrow off-light shadow sliver (no lines ever cross the face),
    // a tidy swept-bangs plate whose zigzag hem is a pure fill boundary, a
    // soft parting crease, and a tiny eye + blush suggestion.
    limb(SH, HEADB, 0.022, 0.018, ZSKIN, false); // neck: fill only, no line
    const chX = hx + tilt * 0.3,
      chY = hy + r * 1.04; // chin
    const crX = hx - tilt * 0.5,
      crY = hy - r * 1.28; // crown peak (hair volume above the skull)
    // prettier-ignore
    const sil = [
      hx - r * 1.12, hy - r * 0.15,
      hx - r * 0.85 - tilt * 0.5, hy - r * 0.95,
      crX, crY,
      hx + r * 0.85 - tilt * 0.5, hy - r * 0.92,
      hx + r * 1.12, hy - r * 0.1,
      hx + r * 0.95, hy + r * 0.5,
      hx + r * 0.52, hy + r * 0.9,
      chX, chY,
      hx - r * 0.52, hy + r * 0.92,
      hx - r * 0.95, hy + r * 0.55];
    F(ZHAIR, 0, sil); // hair back-mass base — the face and bangs carve into it
    E(false, true, sil);
    // face: one smooth lit plane; the dark base peeks out as a hair rim
    // prettier-ignore
    F(ZSKIN, 2, [
      hx - r * 0.9, hy - r * 0.4,
      hx + r * 0.9, hy - r * 0.4,
      hx + r * 0.92, hy + r * 0.42,
      hx + r * 0.5, hy + r * 0.85,
      hx + tilt * 0.3, hy + r,
      hx - r * 0.5, hy + r * 0.87,
      hx - r * 0.92, hy + r * 0.47]);
    // narrow face shadow sliver on the off-light side, clear of the features
    // prettier-ignore
    F(ZSKIN, 1, [
      hx + r * 0.52, hy - r * 0.4,
      hx + r * 0.9, hy - r * 0.4,
      hx + r * 0.92, hy + r * 0.42,
      hx + r * 0.5, hy + r * 0.85]);
    // bangs: a tidy swept plate from temple to temple with a 3-notch hem
    // prettier-ignore
    F(ZHAIR, 2, [
      hx - r * 0.95, hy - r * 0.25,
      hx - r * 0.52, hy + r * 0.18,
      hx - r * 0.08 + tilt * 0.2, hy - r * 0.12,
      hx + r * 0.42, hy + r * 0.2,
      hx + r * 0.92, hy - r * 0.28,
      hx + r * 0.8 - tilt * 0.4, hy - r * 0.9,
      crX, crY,
      hx - r * 0.82 - tilt * 0.4, hy - r * 0.88]);
    // bangs shadow wedge on the off-light side for hair volume
    // prettier-ignore
    F(ZHAIR, 1, [
      hx + r * 0.42, hy + r * 0.2,
      hx + r * 0.92, hy - r * 0.28,
      hx + r * 0.8 - tilt * 0.4, hy - r * 0.9]);
    // soft hair-parting crease from the hem notch up toward the crown
    // prettier-ignore
    E(true, false, [
      hx - r * 0.08 + tilt * 0.2, hy - r * 0.12,
      hx - r * 0.16 - tilt * 0.4, hy - r * 1.18]);
    // tiny features: two eye diamonds + a soft blush diamond under each
    const eyeY = hy + r * 0.32;
    const eye = (s: number): void => {
      const ex = hx + s * r * 0.4 + tilt * 0.25;
      // prettier-ignore
      F(ZEYE, 0, [
        ex, eyeY - r * 0.22, ex + r * 0.11, eyeY, ex, eyeY + r * 0.22, ex - r * 0.11, eyeY]);
      const bx = hx + s * r * 0.6 + tilt * 0.2,
        by = hy + r * 0.62;
      // prettier-ignore
      F(ZBLUSH, 0, [
        bx, by - r * 0.07, bx + r * 0.16, by, bx, by + r * 0.07, bx - r * 0.16, by]);
    };
    eye(-1);
    eye(1);
    // ahoge: one thin triangle wisp from the crown to its wobbling tip
    const ah = [crX - 0.009 * B, crY + 0.004 * B, X(AHOGE), Y(AHOGE), crX + 0.009 * B, crY];
    F(ZHAIR, 2, ah);
    E(false, false, ah);

    // ---- paint --------------------------------------------------------------
    ctx.save();
    // Skips (never draws) any path with a non-finite vertex — NaN guard for
    // the idle/lead-in cases and half-initialized spring state.
    const trace = (p: number[], closed: boolean): boolean => {
      for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) return false;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
      if (closed) ctx.closePath();
      return true;
    };
    if (mode === 'body') {
      // The colored flat facets ARE the form: lit vs shadow planes per zone.
      for (const f of facets) {
        if (!trace(f.p, true)) continue;
        ctx.fillStyle = f.f;
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      // Soft intentional creases first (very low alpha)...
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(color, Math.min(1, alpha) * 0.22);
      for (const e of edges) if (e.soft && trace(e.p, e.closed)) ctx.stroke();
      // ...then the crisp bright silhouette, pulsing with the beat.
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = rgba(color, Math.min(1, alpha));
      for (const e of edges) if (!e.soft && trace(e.p, e.closed)) ctx.stroke();
    } else {
      // 'glow': fat additive rim along the silhouette (its interior half gets
      // covered by the body pass). 'trail': the silhouette, thin and faint.
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = rgba(color, alpha);
      ctx.lineWidth = mode === 'glow' ? Math.max(1, rim) : 1;
      for (const e of edges) if (!e.soft && trace(e.p, e.closed)) ctx.stroke();
    }
    ctx.restore();
  }

  private drawDancer(time: number, beat: number, valid: boolean, kick: number): void {
    const ctx = this.ctx;

    // Resolve the current pose + vertical groove.
    let pose: Pose;
    let phase: number;
    let bob: number;
    if (valid) {
      const idx = ((Math.floor(beat) % 8) + 8) % 8;
      phase = beat - Math.floor(beat);
      const e = Math.max(0, Math.min(1.05, easeSnap(phase)));
      pose = lerpPose(POSES[idx], POSES[(idx + 1) % 8], e);
      // Mirror the whole loop every 4 measures so it doesn't hypnotize.
      if ((Math.floor(beat / 16) & 1) === 1) pose = this.mirror(pose);
      bob = 0.02 * BODY_H * (1 - Math.abs(Math.sin(PI * phase)));
    } else {
      // Idle: a calm neutral sway that never freezes to a dead pose.
      const sw = Math.sin(time * 1.5);
      pose = {
        crouch: 0.01 + 0.01 * Math.sin(time * 2.4),
        rise: 0,
        shiftX: 0.02 * sw,
        lean: 0.05 * Math.sin(time * 1.2),
        head: 0.1 * Math.sin(time * 1.2 + 0.5),
        armLUp: -0.28 + 0.08 * sw,
        armLLo: -0.34 + 0.1 * sw,
        armRUp: 0.28 - 0.08 * sw,
        armRLo: 0.34 - 0.1 * sw,
        legLUp: -0.03,
        legLLo: -0.03,
        legRUp: 0.03,
        legRLo: 0.03,
      };
      phase = 0;
      bob = 0.015 * BODY_H * (0.5 + 0.5 * Math.sin(time * 2.4));
    }

    // The beat bounce is baked into the root inside solve() so the hair and
    // skirt springs react to it.
    this.solve(pose, time, bob);

    // Squash-and-stretch about the foot line (hips lead, so it reads as groove).
    const sy = 1 + 0.03 * Math.sin(PI * phase);
    const sx = 1 - 0.02 * Math.sin(PI * phase);
    ctx.save();
    ctx.translate(CX, FOOT_Y);
    ctx.scale(sx, sy);
    ctx.translate(-CX, -FOOT_Y);

    // Ghost-trail afterimages behind the body (older = fainter, offset) —
    // faint silhouette replays of old skeleton frames.
    const n = this.history.length;
    if (n > 11) this.drawTrail(this.history[n - 11], this.pal.accentA, 0.18, -3);
    if (n > 6) this.drawTrail(this.history[n - 6], this.pal.accentB, 0.3, 3);

    // Rim glow, then the shaded low-poly body (colored facet fills + a crisp
    // neon silhouette that pulses on the beat) on top.
    this.drawBody(
      this.skel,
      'glow',
      this.pal.accentA,
      0.35 * (1 + 1.5 * kick),
      0.024 * BODY_H * (1 + 0.8 * kick),
    );
    this.drawBody(this.skel, 'body', this.pal.accentA, 0.5 + 0.4 * kick, 0);
    ctx.restore();

    // Hand-burst sparkles on the sky-punch beats (1 & 3).
    if (valid) {
      const idx = ((Math.floor(beat) % 8) + 8) % 8;
      if ((idx === 0 || idx === 2) && phase < 0.22) {
        const hx = this.skel[HAR * 2];
        const hy = this.skel[HAR * 2 + 1]; // bob is already baked into the skeleton
        const life = 1 - phase / 0.22;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 5; i++) {
          const sz = 30 * life;
          const jx = this.burstJitter[(i * 2) % this.burstJitter.length];
          const jy = this.burstJitter[(i * 2 + 1) % this.burstJitter.length];
          ctx.globalAlpha = life;
          ctx.drawImage(this.sparkleSprite, hx + jx - sz / 2, hy + jy - sz / 2, sz, sz);
        }
        ctx.restore();
      }
    }

    // Record this frame's pose for future trails (fixed-length ring buffer).
    this.history.push(this.skel.slice());
    if (this.history.length > 14) this.history.shift();
  }

  private drawTrail(j: Float32Array, color: RGB, alpha: number, dx: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(dx, 0);
    this.drawBody(j, 'trail', color, alpha, 0);
    ctx.restore();
  }

  /** Mirror a pose left↔right (swap arms/legs, negate lateral angles). */
  private mirror(p: Pose): Pose {
    return {
      crouch: p.crouch,
      rise: p.rise,
      shiftX: -p.shiftX,
      lean: -p.lean,
      head: -p.head,
      armLUp: -p.armRUp,
      armLLo: -p.armRLo,
      armRUp: -p.armLUp,
      armRLo: -p.armLLo,
      legLUp: -p.legRUp,
      legLLo: -p.legRLo,
      legRUp: -p.legLUp,
      legRLo: -p.legLLo,
    };
  }

  // ---- post ---------------------------------------------------------------

  /** CRT garnish: scanlines, corner vignette, and a single-frame exposure lift
   *  on the downbeat. */
  private drawPost(downKick: number): void {
    const ctx = this.ctx;
    ctx.save();

    // Scanlines.
    ctx.fillStyle = this.scanlines;
    ctx.fillRect(0, 0, W, H);

    // Vignette.
    const v = ctx.createRadialGradient(CX, H * 0.5, H * 0.25, CX, H * 0.5, H * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);

    // Downbeat exposure lift.
    if (downKick > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = rgba(this.pal.white, 0.08 * downKick);
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }
}
