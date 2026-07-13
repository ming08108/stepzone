/**
 * "COMMON MOVIE" — a procedurally-animated attract-mode background for songs
 * with no BGA of their own. It recreates the DDRMAX/Extreme-era "common movie"
 * vibe: a jet-black silhouette dancer (tapered torso, muscled limbs, sneakers,
 * a swinging ponytail — all filled shapes, iPod-ad style) throwing shapes
 * inside a neon hexagon tunnel, over a scrolling perspective checkerboard,
 * everything pulsing to the beat. Pure Canvas 2D so the GPU renderer can
 * sample it as a live texture.
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
// (the mitt hand is drawn just beyond them) and FTL/FTR are ankles (the
// sneaker wedge plants below them). PONY is the ponytail tip — it's stateful
// (spring-lagged in solve()) so it lives in the buffer and rides the trails.
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
  PONY = 16;
const JOINTS = 17;

// Bone lengths / widths as fractions of BODY_H.
const L_TORSO = 0.32,
  L_NECK = 0.06,
  R_HEAD = 0.07,
  W_SHOULDER = 0.13,
  W_HIP = 0.075;
const L_UARM = 0.16,
  L_FARM = 0.13, // to the wrist — the hand extends ~0.05 beyond, matching old reach
  L_THIGH = 0.23,
  L_SHIN = 0.22,
  L_SHOE = 0.025; // ankle sits this far above the sole; the sneaker fills it

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

  private readonly startMs = performance.now();
  private raf = 0;
  private running = false;

  // Baked-once assets.
  private readonly scanlines: CanvasPattern;
  private readonly sunburst: HTMLCanvasElement;
  private readonly sparkleSprite: HTMLCanvasElement;
  private readonly sparkles: Sparkle[] = [];
  private readonly burstJitter: number[] = []; // fixed offsets for hand-bursts

  // Dancer trail history (flat skeleton buffers, newest last).
  private readonly history: Float32Array[] = [];
  private readonly skel = new Float32Array(JOINTS * 2);
  // Ponytail tip, smoothed across frames so it lags/swings behind the head.
  private ponyX = NaN;
  private ponyY = NaN;

  constructor(opts: { beat: () => number; variant?: number }) {
    this.beat = opts.beat;
    this.pal =
      PALETTES[(((opts.variant ?? 0) % PALETTES.length) + PALETTES.length) % PALETTES.length];

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
    const tick = (): void => {
      if (!this.running) return;
      this.draw();
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

  /** Solve the rig forward-kinematically into `this.skel` (flat x,y pairs). */
  private solve(pose: Pose): void {
    const s = this.skel;
    const rootX = CX + pose.shiftX * BODY_H;
    const rootY =
      FOOT_Y - (L_THIGH + L_SHIN + L_SHOE) * BODY_H + pose.crouch * BODY_H - pose.rise * BODY_H;

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

    // Ponytail tip: hangs down-back off the head and chases its rest point
    // with a lag, so head bobs and lateral shifts read as a swishing tail.
    // A constant sideways bias keeps it peeking out of the silhouette even
    // when the head is level (a dead-centre tail would hide behind the body).
    const hx = s[HEAD * 2];
    const hy = s[HEAD * 2 + 1];
    const restX = hx - 0.05 * BODY_H - Math.sin(pose.head) * R_HEAD * BODY_H * 4;
    const restY = hy + R_HEAD * BODY_H * 2.6;
    if (!Number.isFinite(this.ponyX) || !Number.isFinite(this.ponyY)) {
      this.ponyX = restX;
      this.ponyY = restY;
    }
    this.ponyX += (restX - this.ponyX) * 0.14;
    this.ponyY += (restY - this.ponyY) * 0.24;
    set(PONY, this.ponyX, this.ponyY);
  }

  /** Paint the dancer from a flat joint buffer as a set of filled silhouette
   *  shapes: a tapered torso, bulged limbs, mitt hands, sneaker wedges, and a
   *  ponytail. `mode` picks the pass — 'glow' strokes an additive neon rim
   *  around every piece (its interior half gets covered by the black pass),
   *  'black' fills the solid body, 'trail' fills a faint additive ghost. All
   *  geometry derives from the buffer alone so trails replay old frames. */
  private drawBody(
    j: Float32Array,
    mode: 'glow' | 'black' | 'trail',
    color: RGB,
    alpha: number,
    rim: number,
  ): void {
    const ctx = this.ctx;
    const B = BODY_H;
    const X = (i: number): number => j[i * 2];
    const Y = (i: number): number => j[i * 2 + 1];

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const stroking = mode === 'glow';
    if (mode === 'black') {
      ctx.fillStyle = '#000';
    } else {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = rgba(color, alpha);
      ctx.strokeStyle = rgba(color, alpha);
      ctx.lineWidth = Math.max(1, rim);
    }
    const paint = (): void => {
      if (stroking) ctx.stroke();
      else ctx.fill();
    };
    const disc = (x: number, y: number, r: number): void => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, PI * 2);
      paint();
    };

    // Tapered limb: a quad with quadratic sides (mid bulge = muscle swell) and
    // rounded tips. Widths are half-widths as fractions of BODY_H.
    const limb = (a: number, b: number, wa: number, wb: number, bulge: number): void => {
      const ax = X(a),
        ay = Y(a),
        bx = X(b),
        by = Y(b);
      let dx = bx - ax,
        dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const px = -dy,
        py = dx;
      const wA = wa * B,
        wB = wb * B,
        wM = ((wa + wb) / 2 + bulge) * B;
      const mx = (ax + bx) / 2,
        my = (ay + by) / 2;
      ctx.beginPath();
      ctx.moveTo(ax + px * wA, ay + py * wA);
      ctx.quadraticCurveTo(mx + px * wM, my + py * wM, bx + px * wB, by + py * wB);
      ctx.quadraticCurveTo(bx + dx * wB * 1.4, by + dy * wB * 1.4, bx - px * wB, by - py * wB);
      ctx.quadraticCurveTo(mx - px * wM, my - py * wM, ax - px * wA, ay - py * wA);
      ctx.quadraticCurveTo(ax - dx * wA * 1.4, ay - dy * wA * 1.4, ax + px * wA, ay + py * wA);
      ctx.closePath();
      paint();
    };

    // Mitt hand: an ellipse just beyond the wrist, aligned with the forearm.
    const hand = (elb: number, wri: number): void => {
      const wx = X(wri),
        wy = Y(wri);
      let dx = wx - X(elb),
        dy = wy - Y(elb);
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      ctx.beginPath();
      ctx.ellipse(
        wx + dx * 0.03 * B,
        wy + dy * 0.03 * B,
        0.04 * B,
        0.027 * B,
        Math.atan2(dy, dx),
        0,
        PI * 2,
      );
      paint();
    };

    // Sneaker wedge off the ankle. When the shin hangs straight the toe points
    // outward and the sole sits flat on the floor; as the leg kicks/points the
    // toe blends toward the shin direction so extensions read as a toe-point.
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
      const tl = 0.085 * B;
      const tx = ax + dx * tl,
        ty = ay + dy * tl;
      ctx.beginPath();
      // ankle collar → arched instep → thin toe cap → flat sole → heel bump
      ctx.moveTo(ax - dx * 0.02 * B - px * 0.02 * B, ay - dy * 0.02 * B - py * 0.02 * B);
      ctx.quadraticCurveTo(
        ax + dx * tl * 0.45 - px * 0.034 * B,
        ay + dy * tl * 0.45 - py * 0.034 * B,
        tx - px * 0.008 * B,
        ty - py * 0.008 * B,
      );
      ctx.quadraticCurveTo(
        tx + dx * 0.022 * B,
        ty + dy * 0.022 * B,
        tx + px * 0.018 * B,
        ty + py * 0.018 * B,
      );
      ctx.lineTo(ax - dx * 0.045 * B + px * 0.028 * B, ay - dy * 0.045 * B + py * 0.028 * B);
      ctx.closePath();
      paint();
    };

    // ---- torso: broad shoulders → pinched waist → flared hips → rounded seat.
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
    const shW = 0.126 * B, // half-width at the shoulder line
      waistW = 0.06 * B,
      hipW = 0.092 * B;
    const [lsx, lsy] = at(1, -shW);
    const [rsx, rsy] = at(1, shW);
    ctx.beginPath();
    ctx.moveTo(lsx, lsy);
    // trapezius line, bowed slightly above the shoulder centre
    ctx.quadraticCurveTo(scx + ux * 0.035 * B, scy + uy * 0.035 * B, rsx, rsy);
    let [cx1, cy1] = at(0.66, 0.085 * B);
    let [wx1, wy1] = at(0.42, waistW);
    ctx.quadraticCurveTo(cx1, cy1, wx1, wy1); // ribcage tapering into the waist
    [cx1, cy1] = at(0.16, 0.098 * B);
    [wx1, wy1] = at(0, hipW);
    ctx.quadraticCurveTo(cx1, cy1, wx1, wy1); // waist flaring over the hip
    // rounded seat under the pelvis
    [cx1, cy1] = at(0, -hipW);
    ctx.quadraticCurveTo(plx - ux * 0.07 * B, ply - uy * 0.07 * B, cx1, cy1);
    [cx1, cy1] = at(0.16, -0.098 * B);
    [wx1, wy1] = at(0.42, -waistW);
    ctx.quadraticCurveTo(cx1, cy1, wx1, wy1);
    [cx1, cy1] = at(0.66, -0.085 * B);
    ctx.quadraticCurveTo(cx1, cy1, lsx, lsy);
    ctx.closePath();
    paint();
    // deltoid caps over the shoulder joints
    disc(X(SHL), Y(SHL), 0.047 * B);
    disc(X(SHR), Y(SHR), 0.047 * B);

    // ---- neck + head + hair.
    limb(SH, HEADB, 0.03, 0.026, 0);
    const hx = X(HEAD),
      hy = Y(HEAD);
    const tilt = hx - X(HEADB); // signed head-tilt offset, drives the hair back
    disc(hx, hy, R_HEAD * B);
    // occipital hair volume: a slightly offset second disc breaks the circle
    disc(hx - tilt * 0.4, hy - R_HEAD * B * 0.18, R_HEAD * B * 0.92);
    // ponytail: scrunchie puff at the crown-back, tapered swish to the lagged tip
    const pax = hx - tilt * 0.8,
      pay = hy - R_HEAD * B * 0.55;
    disc(pax, pay, 0.028 * B);
    const ptx = X(PONY),
      pty = Y(PONY);
    let pdx = ptx - pax,
      pdy = pty - pay;
    const plen = Math.hypot(pdx, pdy) || 1;
    pdx /= plen;
    pdy /= plen;
    const ppx = -pdy,
      ppy = pdx;
    const pcx = pax + (ptx - pax) * 0.2,
      pcy = pay + (pty - pay) * 0.62;
    const pwB = 0.032 * B,
      pwM = 0.03 * B;
    ctx.beginPath();
    ctx.moveTo(pax + ppx * pwB, pay + ppy * pwB);
    ctx.quadraticCurveTo(pcx + ppx * pwM, pcy + ppy * pwM, ptx, pty);
    ctx.quadraticCurveTo(pcx - ppx * pwM, pcy - ppy * pwM, pax - ppx * pwB, pay - ppy * pwB);
    ctx.closePath();
    paint();

    // ---- arms: upper (bicep swell) → forearm → mitt hand.
    limb(SHL, ELL, 0.042, 0.03, 0.007);
    limb(ELL, HAL, 0.028, 0.018, 0.006);
    hand(ELL, HAL);
    limb(SHR, ELR, 0.042, 0.03, 0.007);
    limb(ELR, HAR, 0.028, 0.018, 0.006);
    hand(ELR, HAR);

    // ---- legs: thigh → calf (swell) → sneaker.
    limb(HIPL, KNL, 0.06, 0.04, 0.008);
    limb(KNL, FTL, 0.038, 0.018, 0.011);
    shoe(KNL, FTL, -1);
    limb(HIPR, KNR, 0.06, 0.04, 0.008);
    limb(KNR, FTR, 0.038, 0.018, 0.011);
    shoe(KNR, FTR, 1);

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

    this.solve(pose);
    // Bake the beat bounce into every joint's y.
    for (let i = 0; i < JOINTS; i++) this.skel[i * 2 + 1] -= bob;

    // Squash-and-stretch about the foot line (hips lead, so it reads as groove).
    const sy = 1 + 0.03 * Math.sin(PI * phase);
    const sx = 1 - 0.02 * Math.sin(PI * phase);
    ctx.save();
    ctx.translate(CX, FOOT_Y);
    ctx.scale(sx, sy);
    ctx.translate(-CX, -FOOT_Y);

    // Ghost-trail afterimages behind the body (older = fainter, offset).
    const n = this.history.length;
    if (n > 11) this.drawTrail(this.history[n - 11], this.pal.accentA, 0.12, -3);
    if (n > 6) this.drawTrail(this.history[n - 6], this.pal.accentB, 0.25, 3);

    // Rim glow, then the pure-black silhouette on top.
    this.drawBody(
      this.skel,
      'glow',
      this.pal.accentA,
      0.5 * (1 + 1.5 * kick),
      0.024 * BODY_H * (1 + 0.8 * kick),
    );
    this.drawBody(this.skel, 'black', this.pal.accentA, 1, 0);
    ctx.restore();

    // Hand-burst sparkles on the sky-punch beats (1 & 3).
    if (valid) {
      const idx = ((Math.floor(beat) % 8) + 8) % 8;
      if ((idx === 0 || idx === 2) && phase < 0.22) {
        const hx = this.skel[HAR * 2];
        const hy = this.skel[HAR * 2 + 1] - bob;
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
