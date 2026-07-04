/**
 * WebGPU animated background — a beat-reactive aurora rendered behind the note
 * field. Purely additive eye-candy: `create()` returns null if WebGPU is
 * unavailable or init fails, and the caller keeps the plain Canvas background.
 * The note field draws on a separate, transparent 2D canvas stacked on top.
 */

export interface FieldFx {
  render(timeSeconds: number, beat: number, energy: number): void;
  resize(width: number, height: number, dpr: number): void;
  destroy(): void;
}

const SHADER = /* wgsl */ `
struct U {
  time: f32,
  beat: f32,
  energy: f32,
  aspect: f32,
  res: vec2f,
  _pad: vec2f,
};
@group(0) @binding(0) var<uniform> u: U;

// Fullscreen triangle — no vertex buffer needed.
@vertex
fn vs(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  return vec4f(p[vid], 0.0, 1.0);
}

fn hue(h: f32) -> vec3f {
  let k = vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0);
  let p = abs(fract(vec3f(h) + k) * 6.0 - 3.0);
  return clamp(p - 1.0, vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let uv = frag.xy / u.res;
  let p = vec2f((uv.x - 0.5) * u.aspect + 0.5, 1.0 - uv.y); // y up
  let t = u.time * 0.16;

  var col = vec3f(0.015, 0.02, 0.05); // deep base

  // Layered aurora bands flowing upward.
  for (var i = 0; i < 5; i = i + 1) {
    let fi = f32(i);
    let wob = sin(p.x * (2.5 + fi) + t * (1.0 + fi * 0.25) + sin(p.y * 3.5 + t) * 1.6);
    let y = 0.12 + fi * 0.17 + sin(t * 0.8 + fi) * 0.05;
    let d = abs(p.y - y - wob * 0.12);
    let glow = 0.016 / (d * d + 0.0016);
    let h = fract(0.58 + fi * 0.06 + u.beat * 0.015);
    col = col + hue(h) * glow * (0.35 + u.energy * 0.75);
  }

  // Per-beat flash.
  let pulse = pow(1.0 - fract(u.beat), 4.0) * (0.10 + u.energy * 0.15);
  col = col + vec3f(0.45, 0.55, 1.0) * pulse;

  // Subtle vignette.
  let vig = smoothstep(1.25, 0.28, length(p - vec2f(0.5, 0.42)));
  col = col * (0.42 + 0.58 * vig);

  return vec4f(col, 1.0);
}
`;

/** Resolve to null if the promise doesn't settle in `ms` (some headless GPUs hang). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

export class ShaderBackground implements FieldFx {
  private constructor(
    private readonly device: GPUDevice,
    private readonly ctx: GPUCanvasContext,
    private readonly pipeline: GPURenderPipeline,
    private readonly uniform: GPUBuffer,
    private readonly bindGroup: GPUBindGroup,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  static async create(canvas: HTMLCanvasElement): Promise<ShaderBackground | null> {
    try {
      const gpu = navigator.gpu;
      if (!gpu) return null;
      const adapter = await withTimeout(gpu.requestAdapter(), 3000);
      if (!adapter) return null;
      const device = await withTimeout(adapter.requestDevice(), 3000);
      if (!device) return null;
      const ctx = canvas.getContext('webgpu');
      if (!ctx) return null;
      const format = gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: 'opaque' });

      const module = device.createShaderModule({ code: SHADER });
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      const uniform = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniform } }],
      });

      // Surface device-loss so a lost context degrades to the Canvas fallback
      // instead of throwing every frame.
      device.lost.then(() => {}).catch(() => {});

      return new ShaderBackground(device, ctx, pipeline, uniform, bindGroup, canvas);
    } catch {
      return null;
    }
  }

  private readonly u = new Float32Array(8);
  private lost = false;

  render(timeSeconds: number, beat: number, energy: number): void {
    if (this.lost) return;
    const w = this.canvas.width || 1;
    const h = this.canvas.height || 1;
    this.u[0] = timeSeconds;
    this.u[1] = beat;
    this.u[2] = Math.max(0, Math.min(1, energy));
    this.u[3] = w / h;
    this.u[4] = w;
    this.u[5] = h;
    try {
      this.device.queue.writeBuffer(this.uniform, 0, this.u);
      const view = this.ctx.getCurrentTexture().createView();
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [
          { view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.draw(3);
      pass.end();
      this.device.queue.submit([enc.finish()]);
    } catch {
      this.lost = true; // fall silent; Canvas field still renders on top
    }
  }

  resize(width: number, height: number, dpr: number): void {
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
  }

  destroy(): void {
    this.lost = true;
    try {
      this.uniform.destroy();
      this.device.destroy();
    } catch {
      // ignore
    }
  }
}
