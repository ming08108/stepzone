/**
 * GPU-native attract background: the DDR-era "common movie" (a neon hexagon
 * tunnel over a scrolling checkerboard, plasma void, etc.) rendered as a single
 * fullscreen WGSL fragment shader — no Canvas 2D, no per-frame texture upload.
 * Drawn first in the note-field's render pass when a song ships no BGA.
 *
 * The whole scene is procedural math driven by uniforms (time, beat, palette),
 * so "millions of pixels" cost the GPU almost nothing and it runs at the field's
 * full framerate. The dancer (a real triangle mesh, built CPU-side per frame) is
 * a separate pass layered on top — added in a later phase.
 *
 * This is the GPU counterpart to the (being-retired) Canvas-2D AttractBackground;
 * the palettes and layer design mirror it 1:1.
 */

import { ThreeVrmDancer, type DancerStep } from '../threeDancer';
import { dancerModelUrl } from '../dancerModels';
import { loadSettings } from '../../app/settings';

// Composite pass: draw the three.js VRM dancer's offscreen render (a real 3D
// character that dances the chart) over the background as a full-canvas quad.
const MODEL_WGSL = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex
fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
  return o;
}
@fragment
fn fs(v: VO) -> @location(0) vec4f {
  return textureSample(tex, samp, v.uv);
}
`;

/** One mood/variant's colors, as 0..1 float RGB ready for the uniform buffer. */
interface GpuPalette {
  gradTop: [number, number, number];
  gradMid: [number, number, number];
  gradBot: [number, number, number];
  accentA: [number, number, number];
  accentB: [number, number, number];
  accentC: [number, number, number];
  accentD: [number, number, number];
  white: [number, number, number];
  floorWire: number; // 1 = wireframe floor (Healing Vision)
  sunHero: number; // 1 = sunburst is the dominant layer (Butterfly)
  petals: number; // 1 = blossom sparkles (Sakura)
}

const hex = (s: string): [number, number, number] => {
  const n = parseInt(s.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** The 4 variants, keyed by index (mirrors the Canvas-2D PALETTES). */
const PALETTES: readonly GpuPalette[] = [
  {
    gradTop: hex('#5B18A8'),
    gradMid: hex('#2B0B54'),
    gradBot: hex('#0A0118'),
    accentA: hex('#FF2E9A'),
    accentB: hex('#00E5FF'),
    accentC: hex('#A8FF00'),
    accentD: hex('#FF7A00'),
    white: hex('#FFF7FF'),
    floorWire: 0,
    sunHero: 0,
    petals: 0,
  },
  {
    gradTop: hex('#6A1A00'),
    gradMid: hex('#4A1200'),
    gradBot: hex('#1A0500'),
    accentA: hex('#FF0066'),
    accentB: hex('#FFC400'),
    accentC: hex('#FF3D2E'),
    accentD: hex('#FFC400'),
    white: hex('#FFF7F0'),
    floorWire: 0,
    sunHero: 1,
    petals: 0,
  },
  {
    gradTop: hex('#3A0A3F'),
    gradMid: hex('#240433'),
    gradBot: hex('#14001F'),
    accentA: hex('#FF8AD8'),
    accentB: hex('#00FFC8'),
    accentC: hex('#FFFFFF'),
    accentD: hex('#FF8AD8'),
    white: hex('#FFFFFF'),
    floorWire: 0,
    sunHero: 0,
    petals: 1,
  },
  {
    gradTop: hex('#003318'),
    gradMid: hex('#001F0E'),
    gradBot: hex('#001406'),
    accentA: hex('#A8FF00'),
    accentB: hex('#00FFB2'),
    accentC: hex('#CFFF66'),
    accentD: hex('#00FFB2'),
    white: hex('#EAFFEA'),
    floorWire: 1,
    sunHero: 0,
    petals: 0,
  },
];

const WGSL = /* wgsl */ `
struct U {
  res: vec4f,      // w, h, aspect(w/h), dim
  tb: vec4f,       // time, beat, kick, downKick
  gradTop: vec4f, gradMid: vec4f, gradBot: vec4f,
  accentA: vec4f, accentB: vec4f, accentC: vec4f, accentD: vec4f, white: vec4f,
  flags: vec4f,    // floorWire, sunHero, petals, variant
  cam: vec4f,      // panX, panY, zoomMul, _ (dynamic camera sway)
  pad: vec4f,      // dance-pad arrow flash 0..1 per panel: L, D, U, R
};
@group(0) @binding(0) var<uniform> u: U;

const PI = 3.14159265;
const TAU = 6.28318531;
const VANISH = vec2f(0.5, 0.42);
const HORIZON = 0.6;
// Canvas-2D reference sizes, converted from px on the 960x540 canvas to
// "screen heights" so the look is resolution-independent.
const TUNNEL_R = 1.5185;   // tunnel max radius (820px / 540)
const RINGS = 12.0;        // concentric hex rings
const SUN_R = 1.53;        // sunburst rim (1100px sprite * 1.5 scale / 2 / 540)
const CELL = 0.12;         // sparkle-field hash cell size

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // One oversized triangle covering the whole clip space.
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

// Pointy-top hexagon distance from the origin (unit-gradient norm, so a delta
// in this value is also the screen-space distance to the hexagon's edge).
fn hexDist(p: vec2f) -> f32 {
  let q = abs(p);
  return max(q.x * 0.8660254 + q.y * 0.5, q.y);
}

fn rot2(p: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(p.x * c - p.y * s, p.x * s + p.y * c);
}

// Filled arrowhead pointing +x, for the dance-pad panels. Returns ~1 inside the
// triangle, 0 outside, with an anti-aliased edge. Input in ~unit cell space.
fn arrowMask(q: vec2f) -> f32 {
  let ax = 0.62;
  let bx = -0.5;
  let hw = 0.62;
  let tx = clamp((q.x - bx) / (ax - bx), 0.0, 1.0);
  let edge = hw * (1.0 - tx);
  let d = min(edge - abs(q.y), min(q.x - bx, ax - q.x));
  return smoothstep(0.0, 0.06, d);
}

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

// Positive modulo (WGSL % truncates toward zero; this floors).
fn modN(x: f32, n: f32) -> f32 {
  return x - n * floor(x / n);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  // Dev flat-background (?dancerFlat): skip the whole tunnel and paint a flat
  // neutral field so the dancer's silhouette/geometry is easy to inspect.
  if (u.cam.w > 0.5) { return vec4f(0.32, 0.32, 0.37, 1.0); }
  let res = u.res.xy;
  let uv = frag.xy / res;            // 0..1, y down (matches Canvas2D)
  let asp = u.res.z;
  let time = u.tb.x;
  let beat = u.tb.y;
  let kick = u.tb.z;
  let downKick = u.tb.w;

  // On-beat "camera kick": everything except the base gradient and the post
  // zooms slightly about the vanishing point (zoom >= 1: no divide hazard).
  let zoom = (1.0 + 0.015 * kick) * max(u.cam.z, 0.1);
  let uvk = VANISH + u.cam.xy + (uv - VANISH - u.cam.xy) / zoom;
  // Aspect-corrected zoomed coords centered on the vanish point, in heights.
  let pk = vec2f((uvk.x - VANISH.x) * asp, uvk.y - VANISH.y);

  // --- base vertical gradient (3-stop, drawn un-zoomed) ---
  var col: vec3f;
  if (uv.y < 0.55) {
    col = mix(u.gradTop.rgb, u.gradMid.rgb, uv.y / 0.55);
  } else {
    col = mix(u.gradMid.rgb, u.gradBot.rgb, (uv.y - 0.55) / 0.45);
  }

  // --- plasma void: 3 big drifting radial glows, additive but kept dark ---
  {
    var centers = array<vec2f, 3>(vec2f(0.3, 0.35), vec2f(0.72, 0.55), vec2f(0.5, 0.75));
    var tints = array<vec3f, 3>(u.gradMid.rgb, u.accentA.rgb, u.gradTop.rgb);
    let blobR = 0.42 * asp;          // canvas: W * 0.42, linear falloff to 0
    for (var i = 0; i < 3; i = i + 1) {
      let fi = f32(i);
      let c = centers[i] + 0.12 * vec2f(sin(time * 0.23 + fi * 2.0), cos(time * 0.19 + fi * 3.0));
      let d = length(vec2f((uvk.x - c.x) * asp, uvk.y - c.y));
      col = col + tints[i] * (0.13 * max(0.0, 1.0 - d / blobR));
    }
  }

  // --- rotating sunburst: 16 alternating god-ray wedges from the vanish point,
  //     barely there until the downbeat; the hero layer for Butterfly ---
  {
    let ang = atan2(pk.y, pk.x + 1e-6) - time * 0.12;
    let sect = fract(ang / TAU * 8.0);           // 8 lit/dark wedge pairs
    let wedge = smoothstep(0.0, 0.02, sect) * (1.0 - smoothstep(0.48, 0.5, sect));
    let rr = clamp(length(pk) / SUN_R, 0.0, 1.0);
    // Radial alpha that was baked into the sprite: hollow core, bright mid, faded rim.
    var radMask = mix(0.9, 0.0, (rr - 0.5) / 0.5);
    if (rr < 0.5) { radMask = mix(0.35, 0.9, rr / 0.5); }
    let sunA = 0.1 * mix(1.0, 2.6, u.flags.y) + 0.16 * downKick;
    col = col + u.accentD.rgb * (wedge * radMask * sunA);
  }

  // --- hexagon tunnel (the hero): thin bright neon hex ring OUTLINES rushing
  //     outward from the vanish point, pumping 1 ring / 2 beats ---
  {
    let sway = 0.35 * sin(time * 0.18);          // slow self-reversing rotation
    let hd = hexDist(rot2(pk, sway));
    let pump = beat * 0.5;
    let fracP = fract(pump);
    let base = floor(pump);
    // Rings sit at radius = R*((i + fracP)/N)^2 — invert for the nearest index.
    let ringF = sqrt(max(hd, 0.0) / TUNNEL_R) * RINGS - fracP;
    let idx = round(ringF);
    if (idx >= 0.0 && idx < RINGS) {
      let pp = (idx + fracP) / RINGS;            // 0 center .. 1 screen edge
      let radius = TUNNEL_R * pp * pp;           // quadratic = perspective rush
      if (radius > 0.004) {                      // canvas skips radius < 2px
        let dist = abs(hd - radius);
        // Canvas lineWidth 2 + 7p px -> half-width, floored at ~1 device px.
        let hw = max((1.0 + 3.5 * pp) / 540.0, 1.0 / res.y);
        let core = 1.0 - smoothstep(hw * 0.4, hw, dist);
        let glow = exp(-dist * dist / (hw * hw * 9.0));
        let fade = max(0.0, (1.0 - pp * 0.7) * (0.85 - 0.3 * pp));
        // Hue cycles per ring through accentA / accentB / accentD.
        let sel = modN(idx + base, 3.0);
        var ringCol = u.accentA.rgb;
        if (sel >= 0.5 && sel < 1.5) { ringCol = u.accentB.rgb; }
        if (sel >= 1.5) { ringCol = u.accentD.rgb; }
        // The freshly-spawned innermost ring blooms to white on each beat.
        if (idx < 0.5) { ringCol = mix(ringCol, u.white.rgb, kick); }
        col = col + ringCol * ((core + glow * 0.45) * fade);
      }
    }
  }

  // --- perspective checkerboard floor, scrolling toward the viewer ---
  if (uvk.y > HORIZON) {
    // Canvas rowY(t) = horizon + 0.4*t*t (t: 0 horizon .. 1 near) — inverted.
    let t = sqrt((uvk.y - HORIZON) / 0.4);
    let tc = max(t, 0.02);
    let cf = (uvk.x - 0.5) * 7.0 / (0.62 * tc);  // column coord, 7 per side
    let rowPos = t * 14.0 - beat * 2.0;          // 2 cells / beat treadmill
    let fog = min(1.0, t * 1.6);                 // fade out toward the horizon
    let inSpread = step(abs(cf), 7.0);

    // Filled checker cells (skipped entirely for the wireframe variant).
    if (u.flags.x < 0.5) {
      let checker = modN(floor(rowPos) + floor(cf), 2.0);
      let cellCol = mix(u.gradMid.rgb, u.accentB.rgb, 0.15 * kick);
      col = mix(col, cellCol, 0.5 * fog * checker * inSpread);
    }

    // Horizontal grid rows; every 4th pops toward white on the downbeat.
    let pxr = 14.0 / (0.8 * tc * res.y);         // row units per device pixel
    let dr = abs(rowPos - round(rowPos));
    let rowLine = (1.0 - smoothstep(0.5 * pxr, 1.5 * pxr, dr)) * inSpread;
    let flash = downKick * step(modN(round(rowPos), 4.0), 0.5);
    col = col + mix(u.accentB.rgb, u.white.rgb, flash) * (0.5 * fog * rowLine);

    // Converging verticals (horizon -> near edge).
    let pxc = 7.0 / (0.62 * tc * res.x);         // col units per device pixel
    let dc = abs(cf - round(cf));
    let colLine = (1.0 - smoothstep(0.5 * pxc, 1.5 * pxc, dc)) * step(abs(round(cf)), 7.0);
    col = col + u.accentB.rgb * (0.35 * colLine * min(1.0, t * 3.0));

    // --- dance pad: DISABLED here. The arrows now live on the physical 3D
    //     dancepad rendered in worldspace by AttractDancer.emitPad (see
    //     attractDancer.ts), so the background floor no longer draws them. The
    //     loop is kept but its contribution is zeroed to avoid touching the
    //     surrounding floor math / unused bindings. ---
    let rc = t * 14.0;
    let padRC = 9.6;                             // centre of the pad, at her feet
    // The four panels in a DDR '+' cross, where the feet actually land: Left and
    // Right out to the sides, Down toward the viewer, Up away — each arrow points
    // its own direction. (cf, rc) = (column, depth) floor coords per panel.
    var pcf = array<f32, 4>(-3.4, 0.0, 0.0, 3.4);        // L, D, U, R
    var prc = array<f32, 4>(0.0, 2.6, -2.6, 0.0);        // D nearer, U farther
    var pangs = array<f32, 4>(PI, PI * 0.5, -PI * 0.5, 0.0);
    for (var i = 0; i < 4; i = i + 1) {
      let q = rot2(vec2f(cf - pcf[i], rc - padRC - prc[i]), -pangs[i]) / 1.7;
      let m = arrowMask(q);
      if (m > 0.001) {
        let fl = u.pad[i];
        // Neon arrow: teal outline at rest, ramping to hot white on the step.
        let acol = mix(u.accentB.rgb, u.white.rgb, fl);
        col = mix(col, acol, m * (0.32 + 0.85 * fl) * fog * inSpread * 0.0);
      }
    }
  }

  // --- sparkles: hash-seeded twinkle field in the upper 2/3; 4-point stars,
  //     or 5-petal blossoms for Sakura ---
  {
    let su = vec2f(uvk.x * asp, uvk.y);          // square units for round stars
    let cid = floor(su / CELL);
    let h0 = hash21(cid);
    if (h0 < 0.55) {                             // ~half the cells host a star
      let jx = 0.3 + 0.4 * hash21(cid + vec2f(11.3, 7.7));
      let jy = 0.3 + 0.4 * hash21(cid + vec2f(2.7, 19.1));
      let sp = (cid + vec2f(jx, jy)) * CELL;
      if (sp.y < 0.7) {
        let phase = hash21(cid + vec2f(31.9, 5.3)) * TAU;
        let speed = 1.5 + 3.0 * hash21(cid + vec2f(23.1, 13.7));
        let scale = 0.4 + 0.9 * hash21(cid + vec2f(3.3, 41.7));
        let tw = sin(phase + time * speed);
        let b = pow(max(tw, 0.0), 8.0);          // pow(sin,8): sharp snap on
        // Star radius (canvas: 23px * scale * twinkle), kept inside its cell.
        let margin = min(min(jx, 1.0 - jx), min(jy, 1.0 - jy)) * CELL;
        let r = min(0.0426 * scale * b, margin * 0.95);
        if (r > 0.0012) {
          let a = min(1.0, b + 0.2);
          let q = su - sp;
          let d = length(q);
          if (u.flags.z > 0.5) {
            // 5-petal blossom with a bright core, randomly oriented.
            let angp = atan2(q.y, q.x + 1e-6) + h0 * TAU;
            let petR = r * (0.62 + 0.38 * cos(5.0 * angp));
            let petal = 1.0 - smoothstep(petR * 0.7, petR + 1e-5, d);
            let corec = 1.0 - smoothstep(r * 0.13, r * 0.22, d);
            col = col + (u.accentA.rgb * (petal * 0.9) + u.white.rgb * corec) * a;
          } else {
            // Soft glowing core + 4 sharp axis spikes.
            let glowS = exp(-d * d / (r * r * 0.28));
            let armW = max(r * 0.1, 0.0012);
            let armX = (1.0 - smoothstep(0.0, r, abs(q.x))) * (1.0 - smoothstep(0.0, armW, abs(q.y)));
            let armY = (1.0 - smoothstep(0.0, r, abs(q.y))) * (1.0 - smoothstep(0.0, armW, abs(q.x)));
            let arms = max(armX, armY);
            col = col + (u.accentC.rgb * (glowS * 0.8) + u.white.rgb * (glowS * glowS * 0.6 + arms * 0.9)) * a;
          }
        }
      }
    }
  }

  // --- post: CRT scanlines (1 dark row in 3), corner vignette, and a 1-frame
  //     exposure lift on the downbeat ---
  col = col * select(1.0, 0.74, fract(frag.y / 3.0) < 0.3334);
  let vd = length(vec2f((uv.x - 0.5) * asp, uv.y - 0.5));
  col = col * (1.0 - 0.55 * clamp((vd - 0.25) / 0.5, 0.0, 1.0));
  col = col + u.white.rgb * (0.08 * downKick);

  col = col * (1.0 - u.res.w);       // background dim, folded in like the media pass
  return vec4f(col, 1.0);
}
`;

/** Config for the current song's attract loop. */
export interface AttractConfig {
  variant: number;
  /** Chart step timeline (beats + L/D/U/R column masks) the dancer steps to.
   *  lCol/rCol (0..3, or -1) are the StepParity foot placement — which panel
   *  each foot steps to — so the dancer foots the chart as a player would. */
  steps?: readonly { beat: number; cols: number; lCol?: number; rCol?: number }[];
  /** Use the 3D dancer (default true). Set false in 2-player so two three.js
   *  renderers don't starve the field — attract then shows just the background. */
  model?: boolean;
  /** Force a specific dancer model id (else the user's settings.dancerModel).
   *  Used by the benchmark for a deterministic, committed model. */
  modelId?: string;
}

export class AttractGpu {
  private readonly pipeline: GPURenderPipeline;
  private readonly uniform: GPUBuffer;
  private readonly bind: GPUBindGroup;
  private readonly data = new Float32Array(52); // 13 vec4
  private pal: GpuPalette = PALETTES[0];

  // Composite pipeline: samples the dancer's offscreen render, alpha over the scene.
  private readonly modelPipe: GPURenderPipeline;
  private readonly modelSampler: GPUSampler;
  private usingModel = false; // set per frame by renderModel()
  private flatBg = false; // ?dancerFlat dev aid: flat neutral bg for inspecting the dancer
  private camAz: number | null = null; // ?dancerCam=<rad> dev aid: lock the camera azimuth
  private modelLoadStarted = false; // the (single-player-only) heavy load kicked off
  // The three.js VRM dancer (loaded async, single-player only). Renders offscreen; its
  // colorView is composited over the neon background. Null until the model loads.
  private dancer: ThreeVrmDancer | null = null;
  private steps: readonly DancerStep[] = [];
  private modelId = ''; // the settings model id the current dancer was loaded for
  private forcedModelId: string | undefined; // AttractConfig.modelId override (bench)
  private lastW = 0;
  private lastH = 0;
  private lastDancerUpdate = -1; // last time (s) the dancer's heavy work ran (throttled)

  constructor(
    private readonly device: GPUDevice,
    format: GPUTextureFormat,
  ) {
    const module = device.createShaderModule({ code: WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.uniform = device.createBuffer({
      size: this.data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bind = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniform } }],
    });

    // Composite pipeline (samples the dancer's offscreen render, alpha over the
    // scene) + a linear sampler.
    const mm = device.createShaderModule({ code: MODEL_WGSL });
    this.modelPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mm, entryPoint: 'vs' },
      fragment: {
        module: mm,
        entryPoint: 'fs',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.modelSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  /** Kick off the heavy 3D model load once (single-player only). The procedural
   *  dancer covers until it's ready, and stays in 2-player (model === false).
   *  One of the redistributable VRoid sample avatars is picked at random per
   *  session for variety; `?dancerModel=B` (etc.) forces one for testing. */
  /** True once the dancer has loaded AND three has produced its first frame (its
   *  offscreen texture is available) — the benchmark waits on this before measuring. */
  get dancerRendered(): boolean {
    return !!this.dancer?.ready && this.dancer.colorView != null;
  }

  private loadModel(): void {
    const id = this.forcedModelId ?? loadSettings().dancerModel;
    if (this.modelLoadStarted && id === this.modelId) return; // already loaded for this model
    if (this.dancer) {
      this.dancer.dispose();
      this.dancer = null;
    }
    this.modelLoadStarted = true;
    this.modelId = id;
    const d = new ThreeVrmDancer({
      modelUrl: dancerModelUrl(id),
      device: this.device,
      width: this.lastW || 512,
      height: this.lastH || 768,
    });
    void d
      .init()
      .then(() => {
        if (this.modelId !== id) {
          d.dispose(); // a newer model was selected while this one loaded
          return;
        }
        d.setSteps(this.steps);
        this.dancer = d;
      })
      .catch(() => {
        // Load/decode failed (e.g. 404) — attract shows just the neon background.
      });
  }

  setConfig(cfg: AttractConfig): void {
    const n = PALETTES.length;
    const v = (((cfg.variant | 0) % n) + n) % n;
    this.pal = PALETTES[v];
    // The chart's StepParity foot stream — which foot steps which arrow (+ jumps).
    this.steps = cfg.steps ?? [];
    this.dancer?.setSteps(this.steps);
    this.forcedModelId = cfg.modelId;
    // `?dancerFlat` renders a flat neutral background instead of the neon tunnel —
    // a dev aid for inspecting the dancer's silhouette without the busy scene.
    const q = new URLSearchParams(location.search);
    this.flatBg = q.has('dancerFlat');
    // `?dancerCam=<radians>` locks the camera azimuth + stills the crane/dolly/pan.
    const camQ = q.get('dancerCam');
    this.camAz =
      camQ !== null && camQ !== '' && Number.isFinite(parseFloat(camQ)) ? parseFloat(camQ) : null;
    // The 3D dancer is single-player only (two starve the field in 2-player).
    if (cfg.model !== false) this.loadModel();
  }

  /** Live-inject a dance step — no-op now the dancer runs off the chart's step stream
   *  (was used by the removed keyboard DancerTest harness). */
  pushStep(_atBeat: number, _cols: number, _lCol: number, _rCol: number): void {
    void _atBeat;
  }

  /** Encode the fullscreen background (call first in the pass; it overwrites). */
  /** Encode the model's offscreen render BEFORE the main pass: solve our
   *  animation's skeleton, retarget it onto the real model, render it (with its
   *  own depth). draw() then composites the result. No-op until the model
   *  loads (the procedural dancer covers meanwhile). */
  renderModel(
    enc: GPUCommandEncoder,
    viewW: number,
    viewH: number,
    now: number,
    beat: number,
    dim = 0,
  ): void {
    void enc; // three renders onto the shared device queue itself, not the game's encoder
    void dim; // the dancer stays vivid regardless of the field's bg dim
    this.lastW = viewW;
    this.lastH = viewH;
    const d = this.dancer;
    if (!d || !d.ready || viewW <= 0 || viewH <= 0) {
      this.usingModel = false;
      return;
    }
    this.usingModel = true; // the composite (draw) samples her last render every frame
    // Throttle her HEAVY per-frame work (three render + spring bones + foot-IK) to
    // ~60fps: she's a background element, so at 144/240Hz the composite reuses the last
    // render for the in-between frames — the note field itself stays at full refresh.
    // Throttle + physics dt use a MONOTONIC wall clock, NOT the song `now` (which seeks/
    // loops/resets between songs — a backward `now` would freeze her forever).
    const wall = performance.now() * 0.001;
    if (d.colorView && wall - this.lastDancerUpdate < 1 / 62) return;
    const dt = Math.min(Math.max(wall - this.lastDancerUpdate, 0), 1 / 30);
    this.lastDancerUpdate = wall;
    try {
      d.setSize(viewW, viewH);
      const b = Number.isFinite(beat) ? beat : now * 1.4;
      d.build(now, b, dt); // animation + chart footwork + foot-IK + spring bones

      // Keep her vivid and lit BY the tunnel: a slight over-bright tint + a rim that
      // cycles the same neon the hexagon rings sweep (accentA→B→D on the beat pump).
      d.setTint(1.22, 1.19, 1.26);
      const acc = [this.pal.accentA, this.pal.accentB, this.pal.accentD];
      const cyc = (((b * 0.5) % 3) + 3) % 3;
      const seg = Math.floor(cyc);
      const f = cyc - seg;
      const c0 = acc[seg % 3];
      const c1 = acc[(seg + 1) % 3];
      d.setEnv(
        c0[0] + (c1[0] - c0[0]) * f,
        c0[1] + (c1[1] - c0[1]) * f,
        c0[2] + (c1[2] - c0[2]) * f,
        0.7,
      );

      // ---- Dynamic camera: beat-synced CUTS + in-shot drift ----
      // Hold a composed shot for a couple of beats, then hard-CUT to a fresh angle on the
      // beat (a music-video cut). Each shot's azimuth / height / zoom come from a hash of the
      // shot index — varied but rock-steady within the shot — and a slow drift + push-in keep
      // it alive. The pad is IN the three scene, so the feet stay on the arrows at any angle.
      const c = d.center;
      const r = d.radius;
      const fovY = 0.62;
      const phase = b - Math.floor(b);
      const kick = Number.isFinite(beat) ? Math.exp(-6 * phase) : 0;
      const fixed = this.camAz !== null;
      const hash = (n: number) => {
        const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
        return s - Math.floor(s);
      };
      // Cut cadence: mostly every 4 beats (a bar), but some shots hold only 2 for punch.
      const bar = Math.floor(b / 4);
      const cutBeats = hash(bar + 0.5) < 0.4 ? 2 : 4;
      const shot = Math.floor(b / cutBeats);
      const tShot = b / cutBeats - shot; // 0..1 through the current shot
      // Azimuth spread ±~68° around the front; drift eases out and back (0 at the cut).
      const shotAz = (hash(shot) - 0.5) * 2.4;
      const drift = 0.16 * Math.sin(tShot * Math.PI) * (hash(shot + 1.9) - 0.5) * 2;
      const orbit = fixed ? (this.camAz as number) : shotAz + drift;
      // Eye height: low (looking up, dramatic) → high (looking down).
      const heightMul = fixed ? 0.22 : -0.1 + hash(shot + 4.7) * 0.68;
      // Distance: close-up → wide, with a slow push-in through the shot + a beat dolly punch.
      const zoomMul = fixed ? 1 : 0.8 + hash(shot + 8.3) * 0.55;
      const dolly = fixed ? 1 : zoomMul * (1 - 0.07 * tShot) * (1 - 0.05 * kick);
      const dist = (r / Math.sin(fovY / 2)) * 1.02 * dolly;
      // On low shots, tilt the look-at up so her head isn't cropped.
      const lowTilt = !fixed && heightMul < 0.12 ? 0.1 * r : 0;
      d.render({
        fovY,
        eye: [
          c[0] + Math.sin(orbit) * dist,
          c[1] + heightMul * r + 0.04 * r,
          c[2] + Math.cos(orbit) * dist,
        ],
        target: [c[0], c[1] + 0.06 * r + lowTilt, c[2]],
      });
    } catch {
      // A three.js hiccup (device loss, a bad resource, a transient NaN) must NEVER
      // crash the game's render loop — swallow it and keep compositing her last good
      // frame; she resumes on the next update. usingModel is already set above.
      void 0;
    }
  }

  draw(
    pass: GPURenderPassEncoder,
    viewW: number,
    viewH: number,
    now: number,
    beat: number,
    dim = 0,
  ): void {
    const d = this.data;
    const phase = beat - Math.floor(beat);
    const mBeat = beat - 4 * Math.floor(beat / 4);
    const valid = Number.isFinite(beat);
    const b = valid ? beat : now * 1.4;
    d[0] = viewW;
    d[1] = viewH;
    d[2] = viewW / Math.max(1, viewH);
    d[3] = Math.max(0, Math.min(1, dim));
    d[4] = now;
    d[5] = b;
    d[6] = valid ? Math.exp(-6 * phase) : 0;
    d[7] = valid ? Math.exp(-3 * mBeat) : 0;
    const p = this.pal;
    const set = (off: number, c: [number, number, number]): void => {
      d[off] = c[0];
      d[off + 1] = c[1];
      d[off + 2] = c[2];
      d[off + 3] = 0;
    };
    set(8, p.gradTop);
    set(12, p.gradMid);
    set(16, p.gradBot);
    set(20, p.accentA);
    set(24, p.accentB);
    set(28, p.accentC);
    set(32, p.accentD);
    set(36, p.white);
    d[40] = p.floorWire;
    d[41] = p.sunHero;
    d[42] = p.petals;
    d[43] = 0;
    // Dynamic camera sway on the background — drifts + breathes with the model's
    // orbit so the whole scene reads as one moving camera.
    const kick = valid ? Math.exp(-6 * phase) : 0;
    // Track the model's wider two-frequency orbit + beat push so the tunnel
    // reads as the same moving camera.
    d[44] = 0.05 * Math.sin(now * 0.16) + 0.018 * Math.sin(now * 0.37 + 1.0); // panX
    d[45] = 0.02 * Math.sin(now * 0.13 + 0.5); // panY (tracks the crane)
    d[46] = 1 + 0.06 * Math.sin(now * 0.11) + 0.05 * kick; // zoom breathe + beat push
    d[47] = this.flatBg ? 1 : 0; // dev flat-background flag (see setConfig / bg shader)
    // The 3D dancer carries its own dancepad (in its offscreen render), so the
    // shader floor no longer flashes arrows.
    d.fill(0, 48, 52);
    this.device.queue.writeBuffer(this.uniform, 0, d);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.draw(3);

    // Composite the three.js dancer's offscreen render (pad + avatar) over the
    // background. Its colorView is null for the first frames while three compiles its
    // pipelines — then the neon background simply shows on its own until she appears.
    if (this.usingModel && this.dancer) {
      const view = this.dancer.colorView;
      if (view) {
        // Rebuild the bind group only when the texture view changes (on resize) —
        // not every frame.
        if (view !== this.compositeView) {
          this.compositeView = view;
          this.compositeBind = this.device.createBindGroup({
            layout: this.modelPipe.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: this.modelSampler },
              { binding: 1, resource: view },
            ],
          });
        }
        pass.setPipeline(this.modelPipe);
        pass.setBindGroup(0, this.compositeBind!);
        pass.draw(3);
      }
    }
  }

  private compositeView: GPUTextureView | null = null;
  private compositeBind: GPUBindGroup | null = null;

  destroy(): void {
    this.dancer?.dispose();
    this.dancer = null;
    try {
      this.uniform.destroy();
    } catch {
      // device already lost
    }
  }
}
