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

import { AttractDancer, DANCER_SKELETON } from '../attractDancer';
import { SkinnedModel } from './skinnedModel';

// Composite pass: draw the skinned model's offscreen render (a real 3D
// character our animation drives) over the background as a full-canvas quad.
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

/** A dancer avatar: a model URL and an optional hair recolor (see skinnedModel
 *  — replaces HAIR-material hue, keeps luminance). */
interface DancerModel {
  url: string;
  hair?: readonly [number, number, number];
  texCap?: number; // cap texture size (retro/PS2 low-res look, kills aliasing)
}

/** The dancer avatars — redistributable VRoid CC-usage sample models (see
 *  public/models/README.md). One is chosen at random per session for variety.
 *  "Miku" is avatar B recolored teal — real Hatsune Miku is license-locked, but
 *  a teal-haired sailor-top sample reads close enough to ship. */
const MODEL_POOL: Record<string, DancerModel> = {
  A: { url: '/models/AvatarSample_A.vrm' },
  B: { url: '/models/AvatarSample_B.vrm' },
  C: { url: '/models/AvatarSample_C.vrm' },
  Miku: { url: '/models/AvatarSample_B.vrm', hair: [0.05, 0.78, 0.72] },
  // A hand-crafted, PS1-style Miku — ORIGINAL low-poly geometry + a painted face
  // texture (scripts/genPs1Miku.mjs), so unlike `Real` it ships freely. Rigid
  // segmented limbs + flat shading = peak PlayStation-era character. Tiny (~80KB).
  PS1: { url: '/models/PS1Miku.vrm' },
  // `Real` = an actual Hatsune Miku VRM. NOT shipped (Crypton's Piapro Character
  // License restricts redistribution) — Miku*.vrm is gitignored, so drop your own
  // licensed copy in public/models/ to use it. Forced-only (never in the random
  // rotation), so it's inert for anyone without the file (loadModel falls back to
  // the procedural dancer if the fetch 404s).
  Real: { url: '/models/Miku4_low.vrm', texCap: 256 },
};

/** Avatars in the random rotation (redistributable only — excludes `Real`). */
const RANDOM_KEYS = ['A', 'B', 'C', 'Miku', 'PS1'] as const;

/** Pick a dancer: `?dancerModel=Real` forces any pool entry, else random. */
function pickModel(): DancerModel {
  const forced = new URLSearchParams(location.search).get('dancerModel');
  if (forced && MODEL_POOL[forced]) return MODEL_POOL[forced];
  return MODEL_POOL[RANDOM_KEYS[Math.floor(Math.random() * RANDOM_KEYS.length)]];
}

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

    // --- dance pad: four arrows on the floor (L, D, U, R), flashing on the
    //     step that lands on each panel. Drawn here so the pad shows under EVERY
    //     dancer (the 2D procedural one and every 3D avatar). Stationary in the
    //     floor's (column cf, row rc) frame so it doesn't ride the treadmill. ---
    let rc = t * 14.0;
    let padRC = 10.2;                            // pad row depth (just at her feet)
    var pcols = array<f32, 4>(-3.6, -1.2, 1.2, 3.6);
    var pangs = array<f32, 4>(PI, PI * 0.5, -PI * 0.5, 0.0); // L,D(toward),U(away),R
    for (var i = 0; i < 4; i = i + 1) {
      let q = rot2(vec2f(cf - pcols[i], rc - padRC), -pangs[i]) / 1.75;
      let m = arrowMask(q);
      if (m > 0.001) {
        let fl = u.pad[i];
        // Neon arrow: teal outline at rest, ramping to hot white on the step.
        let acol = mix(u.accentB.rgb, u.white.rgb, fl);
        col = mix(col, acol, m * (0.32 + 0.85 * fl) * fog * inSpread);
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

// The dancer mesh: real triangles built CPU-side (AttractDancer) in a fixed
// 960x540 design space (y down), cover-fit to the viewport here, per-vertex
// colored. Drawn over the background — solid facets, then additive edges/glow.
const DANCER_WGSL = /* wgsl */ `
struct DU { p: vec4f };   // viewW, viewH, dim, _
@group(0) @binding(0) var<uniform> du: DU;
struct VO { @builtin(position) pos: vec4f, @location(0) col: vec3f };
@vertex
fn vs(@location(0) xy: vec2f, @location(1) col: vec3f) -> VO {
  let vw = du.p.x;
  let vh = du.p.y;
  let sc = max(vw / 960.0, vh / 540.0);   // cover-fit the design space
  let px = (vw - 960.0 * sc) * 0.5 + xy.x * sc;
  let py = (vh - 540.0 * sc) * 0.5 + xy.y * sc;
  var o: VO;
  o.pos = vec4f(px / vw * 2.0 - 1.0, 1.0 - py / vh * 2.0, 0.0, 1.0);
  o.col = col;
  return o;
}
@fragment
fn fs(v: VO) -> @location(0) vec4f {
  return vec4f(v.col * (1.0 - du.p.z), 1.0);   // dim folded in, like the bg
}
`;

/** Config for the current song's attract loop. */
export interface AttractConfig {
  variant: number;
  /** Chart step timeline (beats + L/D/U/R column masks) the dancer steps to.
   *  lCol/rCol (0..3, or -1) are the StepParity foot placement — which panel
   *  each foot steps to — so the dancer foots the chart as a player would. */
  steps?: readonly { beat: number; cols: number; lCol?: number; rCol?: number }[];
  /** Use the heavy textured 3D model (default true). Set false in 2-player so
   *  two of them don't starve the field — the light procedural dancer shows. */
  model?: boolean;
}

export class AttractGpu {
  private readonly pipeline: GPURenderPipeline;
  private readonly uniform: GPUBuffer;
  private readonly bind: GPUBindGroup;
  private readonly data = new Float32Array(52); // 13 vec4
  private pal: GpuPalette = PALETTES[0];

  // Dancer mesh: CPU geometry (AttractDancer) drawn via two blend passes.
  private readonly solidPipe: GPURenderPipeline;
  private readonly addPipe: GPURenderPipeline;

  // Real 3D model (loaded async). While it loads, the procedural mesh shows;
  // once ready, our animation retargets onto it and we composite its render.
  private readonly modelPipe: GPURenderPipeline;
  private readonly modelSampler: GPUSampler;
  private model: SkinnedModel | null = null;
  private usingModel = false; // set per frame by renderModel()
  private modelLoadStarted = false; // the (single-player-only) heavy load kicked off
  private readonly dancerUniform: GPUBuffer;
  private readonly dancerBind: GPUBindGroup;
  private readonly dancerData = new Float32Array(4); // viewW, viewH, dim, _
  private solidBuf: GPUBuffer | null = null;
  private addBuf: GPUBuffer | null = null;
  private dancer: AttractDancer | null = null;

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
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

    // Dancer mesh pipelines: one shared cover-fit shader, two blend modes.
    const dm = device.createShaderModule({ code: DANCER_WGSL });
    const vbLayout: GPUVertexBufferLayout = {
      arrayStride: 20, // x,y,r,g,b = 5 * f32
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' },
        { shaderLocation: 1, offset: 8, format: 'float32x3' },
      ],
    };
    // A shared explicit layout so both blend-variant pipelines accept the same
    // bind group (an 'auto' layout would give each its own, incompatible one).
    const dancerBGL = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });
    const dancerPL = device.createPipelineLayout({ bindGroupLayouts: [dancerBGL] });
    const meshPipe = (blend?: GPUBlendState): GPURenderPipeline =>
      device.createRenderPipeline({
        layout: dancerPL,
        vertex: { module: dm, entryPoint: 'vs', buffers: [vbLayout] },
        fragment: { module: dm, entryPoint: 'fs', targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    // Solid: opaque body, src-over (alpha is always 1 → replace where drawn).
    this.solidPipe = meshPipe({
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
    });
    // Additive: neon edges + rim glow + sparks glow onto the scene.
    this.addPipe = meshPipe({
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    });
    this.dancerUniform = device.createBuffer({
      size: this.dancerData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.dancerBind = device.createBindGroup({
      layout: dancerBGL,
      entries: [{ binding: 0, resource: { buffer: this.dancerUniform } }],
    });

    // Model composite pipeline (samples the model's offscreen render, alpha
    // over the scene) + a linear sampler.
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
  private loadModel(): void {
    if (this.modelLoadStarted) return;
    this.modelLoadStarted = true;
    const pick = pickModel();
    void SkinnedModel.load(this.device, this.format, pick.url, pick.hair, pick.texCap)
      .then((m) => {
        this.model = m;
      })
      .catch(() => {
        // No model (fetch/decode failed) — stay on the procedural dancer.
      });
  }

  setConfig(cfg: AttractConfig): void {
    const n = PALETTES.length;
    const v = (((cfg.variant | 0) % n) + n) % n;
    this.pal = PALETTES[v];
    // One dancer per song (fresh spring/cursor state), stepping to this chart.
    this.dancer = new AttractDancer(v);
    this.dancer.setSteps(cfg.steps ?? []);
    // The heavy textured avatar is single-player only (two of them starve the
    // field in 2-player) — kick off its load lazily here. When it's off, the
    // light procedural dancer carries the whole show.
    if (cfg.model !== false) this.loadModel();
  }

  /** Live-inject a dance step (keyboard test mode). */
  pushStep(atBeat: number, cols: number, lCol: number, rCol: number): void {
    this.dancer?.pushStep(atBeat, cols, lCol, rCol);
  }

  /** Grow (or lazily create) a vertex buffer to hold `arr`. */
  private ensureVB(buf: GPUBuffer | null, arr: Float32Array): GPUBuffer {
    if (buf && buf.size >= arr.byteLength) return buf;
    buf?.destroy();
    return this.device.createBuffer({
      size: arr.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
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
    const model = this.model;
    if (!model || !this.dancer || viewW <= 0 || viewH <= 0) {
      this.usingModel = false;
      return;
    }
    // Only single-player renders the model (2-player uses the light procedural
    // dancer — see setConfig), so there's GPU headroom to run it at full
    // resolution and monitor refresh: no cap, no downscale.
    const b = Number.isFinite(beat) ? beat : now * 1.4;
    this.dancer.build(now, b); // solves the 3D skeleton (skel3)
    model.retargetFromSkeleton(this.dancer.getSkeleton3D(), DANCER_SKELETON);
    // The dancer is the STAR of the attract scene, not a background element —
    // keep her vivid and full-bright (with a slight boost so she pops off the
    // dimmed tunnel) regardless of the field's bg dim. Dimming her down was what
    // turned the face into a murky, hollow-eyed smudge in-game.
    void dim;
    model.setTint(1.12, 1.12, 1.12);
    // Dynamic camera — a proper moving shot, not a static frame: a wide,
    // two-frequency orbit sweeps most of the way around her and never repeats;
    // the eye cranes up and dips on a slower arc; it breathes in/out and punches
    // IN on every beat. (The background shader sways to match.)
    const c = model.center;
    const r = model.radius;
    const fovY = 0.62;
    const phase = b - Math.floor(b);
    const kick = Number.isFinite(beat) ? Math.exp(-6 * phase) : 0;
    const orbit = 0.62 * Math.sin(now * 0.16) + 0.22 * Math.sin(now * 0.37 + 1.0);
    const crane = 0.3 * r * Math.sin(now * 0.13 + 0.5);
    const dolly = 1 + 0.1 * Math.sin(now * 0.11) - 0.07 * kick;
    const dist = (r / Math.sin(fovY / 2)) * 1.02 * dolly;
    const panY = 0.08 * r * Math.sin(now * 0.19);
    // Frame lift: raising both eye and target drops the subject in frame so
    // her feet land on the near (large) cells of the shader floor grid instead
    // of hovering over its far rows.
    const lift = 0.13 * r;
    model.render(enc, viewW, viewH, {
      fovY,
      eye: [
        c[0] + Math.sin(orbit) * dist,
        c[1] + 0.32 * r + lift + crane,
        c[2] + Math.cos(orbit) * dist,
      ],
      target: [c[0], c[1] + panY + lift + crane * 0.35, c[2]],
    });
    this.usingModel = true;
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
    d[47] = 0;
    // Dance-pad arrow flash (L,D,U,R) — drawn on the shader floor so the pad
    // shows under EVERY dancer, including the 3D avatars.
    if (this.dancer) this.dancer.padFlashInto(b, this.data.subarray(48, 52));
    else d.fill(0, 48, 52);
    this.device.queue.writeBuffer(this.uniform, 0, d);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.draw(3);

    // The dancer over the background. If the real 3D model is loaded, our
    // animation was retargeted onto it in renderModel() (offscreen); composite
    // it. Otherwise draw the procedural mesh (solid facets + additive edges).
    if (this.usingModel && this.model) {
      const bind = this.device.createBindGroup({
        layout: this.modelPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.modelSampler },
          { binding: 1, resource: this.model.colorView },
        ],
      });
      pass.setPipeline(this.modelPipe);
      pass.setBindGroup(0, bind);
      pass.draw(3);
    } else if (this.dancer) {
      const dd = this.dancerData;
      dd[0] = viewW;
      dd[1] = viewH;
      dd[2] = Math.max(0, Math.min(1, dim));
      this.device.queue.writeBuffer(this.dancerUniform, 0, dd);
      const f = this.dancer.build(now, b);
      pass.setBindGroup(0, this.dancerBind);
      if (f.solidCount > 0) {
        this.solidBuf = this.ensureVB(this.solidBuf, f.solid);
        this.device.queue.writeBuffer(this.solidBuf, 0, f.solid, 0, f.solidCount * 5);
        pass.setPipeline(this.solidPipe);
        pass.setVertexBuffer(0, this.solidBuf);
        pass.draw(f.solidCount);
      }
      if (f.additiveCount > 0) {
        this.addBuf = this.ensureVB(this.addBuf, f.additive);
        this.device.queue.writeBuffer(this.addBuf, 0, f.additive, 0, f.additiveCount * 5);
        pass.setPipeline(this.addPipe);
        pass.setVertexBuffer(0, this.addBuf);
        pass.draw(f.additiveCount);
      }
    }
  }

  destroy(): void {
    try {
      this.uniform.destroy();
      this.dancerUniform.destroy();
      this.solidBuf?.destroy();
      this.addBuf?.destroy();
    } catch {
      // device already lost
    }
  }
}
