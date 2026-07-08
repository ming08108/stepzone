/**
 * Instanced sprite-quad pipeline — the entire per-frame draw path of the
 * WebGPU note field. Every visible thing (arrows, receptors, hold layers,
 * HUD, text) is one 96-byte instance: center/size/rotation, an atlas uv rect,
 * a premultiplied tint, tiling controls, and an optional mask uv rect. The
 * frame is a single render pass over one instance buffer; consecutive
 * instances sharing a blend mode collapse into one draw call (normal frames
 * are 3: over → additive explosions → over HUD).
 *
 * Instance extras:
 *  - repeatV > 1 tiles the sprite vertically (hold chevron/rail pattern) via
 *    fract() in the shader; flipV mirrors it (reverse scroll).
 *  - repeatU/phaseU tile and scroll horizontally — the dance gauge's flowing
 *    bands and maxed-gauge rainbow are scrolling patterns.
 *  - mask multiplies by a second atlas rect's alpha, sampled across the whole
 *    quad — patterns clip to the gauge's chevron-pill segments exactly like
 *    the 2D theme's ctx.clip() did.
 *  - uv rects may be cropped sub-rects (gauge fill by life, short hold
 *    gradients) — see cropUV.
 */

import type { AtlasRect } from './atlas';

const WGSL = /* wgsl */ `
struct View { size: vec2f, _pad: vec2f };
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var atlas: texture_2d<f32>;

struct In {
  @location(0) a0: vec4f, // cx, cy, halfW, halfH   (css px)
  @location(1) a1: vec4f, // rot, repeatV, flipV, repeatU
  @location(2) a2: vec4f, // uv rect u0 v0 u1 v1
  @location(3) a3: vec4f, // premultiplied tint
  @location(4) a4: vec4f, // mask uv rect (all-zero = no mask)
  @location(5) a5: vec4f, // phaseU, maskFlag, phaseV, unused
};
struct Out {
  @builtin(position) pos: vec4f,
  @location(0) luv: vec2f,
  @location(1) uvRect: vec4f,
  @location(2) tint: vec4f,
  @location(3) rep: vec3f,  // repeatV, flipV, repeatU
  @location(4) maskUV: vec4f,
  @location(5) extra: vec3f, // phaseU, maskFlag, phaseV
};

@vertex
fn vs(@builtin(vertex_index) vid: u32, q: In) -> Out {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
  );
  let corner = corners[vid];
  let rot = q.a1.x;
  let c = cos(rot);
  let s = sin(rot);
  let local = corner * q.a0.zw;
  let world = q.a0.xy + vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
  var out: Out;
  out.pos = vec4f(world.x / view.size.x * 2.0 - 1.0, 1.0 - world.y / view.size.y * 2.0, 0.0, 1.0);
  out.luv = corner * 0.5 + vec2f(0.5);
  out.uvRect = q.a2;
  out.tint = q.a3;
  out.rep = vec3f(q.a1.y, q.a1.z, q.a1.w);
  out.maskUV = q.a4;
  out.extra = q.a5.xyz;
  return out;
}

@fragment
fn fs(v: Out) -> @location(0) vec4f {
  var ly = v.luv.y;
  if (v.rep.y > 0.5) { ly = 1.0 - ly; }
  var vv = ly;
  if (v.rep.x > 1.0001 || v.extra.z != 0.0) { vv = fract(ly * max(v.rep.x, 1.0) + v.extra.z); }
  var uu = v.luv.x;
  if (v.rep.z > 1.0001 || v.extra.x != 0.0) { uu = fract(uu * max(v.rep.z, 1.0) + v.extra.x); }
  let uv = vec2f(
    mix(v.uvRect.x, v.uvRect.z, uu),
    mix(v.uvRect.y, v.uvRect.w, vv),
  );
  var col = textureSample(atlas, samp, uv) * v.tint;
  // Mask: always sampled (uniform control flow), applied only when flagged.
  let muv = vec2f(
    mix(v.maskUV.x, v.maskUV.z, v.luv.x),
    mix(v.maskUV.y, v.maskUV.w, v.luv.y),
  );
  let m = textureSample(atlas, samp, muv);
  return col * mix(1.0, m.a, v.extra.y);
}
`;

const FLOATS_PER_INSTANCE = 24;

/** Sub-rect of an atlas rect (fractions 0..1 of the sprite's own extent). */
export function cropUV(
  r: AtlasRect,
  fu0: number,
  fv0: number,
  fu1: number,
  fv1: number,
): AtlasRect {
  const du = r.u1 - r.u0;
  const dv = r.v1 - r.v0;
  return {
    u0: r.u0 + du * fu0,
    v0: r.v0 + dv * fv0,
    u1: r.u0 + du * fu1,
    v1: r.v0 + dv * fv1,
    w: r.w * (fu1 - fu0),
    h: r.h * (fv1 - fv0),
  };
}

export interface QuadOpts {
  rot?: number;
  repeatV?: number;
  flipV?: boolean;
  /** Horizontal tiling: how many pattern periods span the quad. */
  repeatU?: number;
  /** Horizontal scroll phase (fraction of a period; wraps via fract). */
  phaseU?: number;
  /** Vertical scroll phase (fraction of a period; wraps via fract). Any
   *  nonzero value also enables vertical wrapping, like phaseU. */
  phaseV?: number;
  /** Clip by this atlas rect's alpha, stretched across the quad. */
  mask?: AtlasRect;
  /** Additive blend (explosions). Instances group into blend segments in push order. */
  add?: boolean;
}

export class QuadBatch {
  private readonly pipeOver: GPURenderPipeline;
  private readonly pipeAdd: GPURenderPipeline;
  private readonly uniform: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private data = new Float32Array(FLOATS_PER_INSTANCE * 512);
  private buffer: GPUBuffer;
  private count = 0;
  private segments: Array<{ add: boolean; start: number; count: number }> = [];
  private readonly viewScratch = new Float32Array(4); // reused each begin() (no per-frame alloc)

  constructor(
    private readonly device: GPUDevice,
    format: GPUTextureFormat,
    atlasView: GPUTextureView,
  ) {
    const module = device.createShaderModule({ code: WGSL });
    const vertexBuffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: FLOATS_PER_INSTANCE * 4,
        stepMode: 'instance',
        attributes: [0, 1, 2, 3, 4, 5].map((i) => ({
          shaderLocation: i,
          offset: i * 16,
          format: 'float32x4' as const,
        })),
      },
    ];
    // One explicit layout shared by both blend pipelines — 'auto' would give
    // each its own, and the single bind group must be valid under both.
    const bgl = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const make = (blend: GPUBlendState) =>
      device.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: 'vs', buffers: vertexBuffers },
        fragment: { module, entryPoint: 'fs', targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    // Premultiplied source-over.
    this.pipeOver = make({
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    });
    // Additive (canvas 'lighter').
    this.pipeAdd = make({
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    });

    this.uniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: atlasView },
      ],
    });
    this.buffer = device.createBuffer({
      size: this.data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  begin(viewW: number, viewH: number): void {
    this.count = 0;
    this.segments.length = 0;
    const v = this.viewScratch;
    v[0] = viewW;
    v[1] = viewH;
    this.device.queue.writeBuffer(this.uniform, 0, v);
  }

  /**
   * Queue one sprite quad. `w`/`h` are full extents in css px; tint is a
   * straight (non-premultiplied) color, alpha-scaled here. Draw order is push
   * order.
   */
  push(
    cx: number,
    cy: number,
    w: number,
    h: number,
    uv: AtlasRect,
    r = 1,
    g = 1,
    b = 1,
    a = 1,
    opts?: QuadOpts,
  ): void {
    if (a <= 0 || w === 0 || h === 0) return;
    if ((this.count + 1) * FLOATS_PER_INSTANCE > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
      this.buffer.destroy();
      this.buffer = this.device.createBuffer({
        size: this.data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    const add = opts?.add ?? false;
    const seg = this.segments[this.segments.length - 1];
    if (!seg || seg.add !== add) this.segments.push({ add, start: this.count, count: 1 });
    else seg.count++;

    const o = this.count * FLOATS_PER_INSTANCE;
    const d = this.data;
    const mask = opts?.mask;
    d[o] = cx;
    d[o + 1] = cy;
    d[o + 2] = w / 2;
    d[o + 3] = h / 2;
    d[o + 4] = opts?.rot ?? 0;
    d[o + 5] = opts?.repeatV ?? 0;
    d[o + 6] = opts?.flipV ? 1 : 0;
    d[o + 7] = opts?.repeatU ?? 0;
    d[o + 8] = uv.u0;
    d[o + 9] = uv.v0;
    d[o + 10] = uv.u1;
    d[o + 11] = uv.v1;
    d[o + 12] = r * a;
    d[o + 13] = g * a;
    d[o + 14] = b * a;
    d[o + 15] = a;
    d[o + 16] = mask?.u0 ?? 0;
    d[o + 17] = mask?.v0 ?? 0;
    d[o + 18] = mask?.u1 ?? 0;
    d[o + 19] = mask?.v1 ?? 0;
    d[o + 20] = opts?.phaseU ?? 0;
    d[o + 21] = mask ? 1 : 0;
    d[o + 22] = opts?.phaseV ?? 0;
    d[o + 23] = 0;
    this.count++;
  }

  /** Encode all queued quads into the pass (blend-segmented draws). */
  flush(pass: GPURenderPassEncoder): void {
    if (this.count === 0) return;
    this.device.queue.writeBuffer(this.buffer, 0, this.data, 0, this.count * FLOATS_PER_INSTANCE);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.buffer);
    let current: GPURenderPipeline | null = null;
    for (const seg of this.segments) {
      const pipe = seg.add ? this.pipeAdd : this.pipeOver;
      if (pipe !== current) {
        pass.setPipeline(pipe);
        current = pipe;
      }
      pass.draw(6, seg.count, 0, seg.start);
    }
  }

  destroy(): void {
    try {
      this.buffer.destroy();
      this.uniform.destroy();
    } catch {
      // device already lost
    }
  }
}
