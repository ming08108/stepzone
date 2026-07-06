/**
 * Colored-triangle pipeline for the HUD panel backgrounds (score frame's
 * angled rows + hexagon, song panel's black band) and their gold trim —
 * drawn as geometry so the panels never rasterize through canvas. Vertices
 * are (pos css px, premultiplied rgba); the vertex shader maps css px → NDC
 * with the same view convention as the quad batch. Premultiplied source-over,
 * so it composites identically to the textured quads around it.
 *
 * Small helpers cover exactly what the panels need: filled convex polygons
 * (fan) with a per-vertex color callback (for vertical gradients), and stroked
 * edges (a quad per segment) with endpoint colors.
 */

export type ColorFn = (x: number, y: number) => readonly [number, number, number, number];

const WGSL = /* wgsl */ `
struct View { size: vec2f, _pad: vec2f };
@group(0) @binding(0) var<uniform> view: View;

struct Out { @builtin(position) pos: vec4f, @location(0) col: vec4f };

@vertex
fn vs(@location(0) p: vec2f, @location(1) c: vec4f) -> Out {
  var o: Out;
  o.pos = vec4f(p.x / view.size.x * 2.0 - 1.0, 1.0 - p.y / view.size.y * 2.0, 0.0, 1.0);
  o.col = c;
  return o;
}

@fragment
fn fs(@location(0) c: vec4f) -> @location(0) vec4f { return c; }
`;

const FLOATS_PER_VERT = 6; // x, y, r, g, b, a

export class ShapeBatch {
  private readonly pipeline: GPURenderPipeline;
  private readonly uniform: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private data = new Float32Array(FLOATS_PER_VERT * 512);
  private buffer: GPUBuffer;
  private count = 0;

  constructor(
    private readonly device: GPUDevice,
    format: GPUTextureFormat,
  ) {
    const module = device.createShaderModule({ code: WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: FLOATS_PER_VERT * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 8, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.uniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniform } }],
    });
    this.buffer = device.createBuffer({
      size: this.data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  begin(viewW: number, viewH: number): void {
    this.count = 0;
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([viewW, viewH, 0, 0]));
  }

  private vert(x: number, y: number, color: ColorFn): void {
    if ((this.count + 1) * FLOATS_PER_VERT > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
      this.buffer.destroy();
      this.buffer = this.device.createBuffer({
        size: this.data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    const o = this.count * FLOATS_PER_VERT;
    const [r, g, b, a] = color(x, y);
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = r * a; // premultiplied
    this.data[o + 3] = g * a;
    this.data[o + 4] = b * a;
    this.data[o + 5] = a;
    this.count++;
  }

  private tri(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    color: ColorFn,
  ): void {
    this.vert(ax, ay, color);
    this.vert(bx, by, color);
    this.vert(cx, cy, color);
  }

  /** Filled convex polygon (triangle fan) with a per-vertex color. */
  poly(pts: ReadonlyArray<readonly [number, number]>, color: ColorFn): void {
    for (let i = 1; i < pts.length - 1; i++) {
      this.tri(pts[0][0], pts[0][1], pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], color);
    }
  }

  /** Stroke the outline of a polygon (closed) with `width`, per-vertex color. */
  outline(pts: ReadonlyArray<readonly [number, number]>, width: number, color: ColorFn): void {
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      this.edge(x0, y0, x1, y1, width, color);
    }
  }

  /** A stroked segment (a quad `width` wide centered on the line). */
  edge(x0: number, y0: number, x1: number, y1: number, width: number, color: ColorFn): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (width / 2);
    const ny = (dx / len) * (width / 2);
    const a: [number, number] = [x0 + nx, y0 + ny];
    const b: [number, number] = [x0 - nx, y0 - ny];
    const c: [number, number] = [x1 - nx, y1 - ny];
    const d: [number, number] = [x1 + nx, y1 + ny];
    this.tri(a[0], a[1], b[0], b[1], c[0], c[1], color);
    this.tri(a[0], a[1], c[0], c[1], d[0], d[1], color);
  }

  flush(pass: GPURenderPassEncoder): void {
    if (this.count === 0) return;
    this.device.queue.writeBuffer(this.buffer, 0, this.data, 0, this.count * FLOATS_PER_VERT);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.buffer);
    pass.draw(this.count);
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
