/**
 * Background media pass for the WebGPU note field: draws the song's
 * image/video cover-fit behind the field, on the same surface (no second
 * canvas). Images/bitmaps upload once to a sampled texture; videos go through
 * importExternalTexture every frame (zero-copy where the platform allows).
 * The dim overlay on top is an ordinary quad from the main batch.
 */

const WGSL_COMMON = /* wgsl */ `
struct Rect { ndc: vec4f }; // x0, y0, x1, y1 (NDC corners of the cover-fit quad)
@group(0) @binding(0) var<uniform> rect: Rect;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vid: u32) -> Out {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
  );
  let c = corners[vid];
  var out: Out;
  out.pos = vec4f(mix(rect.ndc.xy, rect.ndc.zw, c), 0.0, 1.0);
  out.uv = vec2f(c.x, 1.0 - c.y);
  return out;
}
`;

const WGSL_IMAGE =
  WGSL_COMMON +
  /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
@fragment
fn fs(v: Out) -> @location(0) vec4f {
  return textureSample(tex, samp, v.uv);
}
`;

const WGSL_VIDEO =
  WGSL_COMMON +
  /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_external;
@fragment
fn fs(v: Out) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(tex, samp, v.uv);
}
`;

type Media = HTMLVideoElement | HTMLImageElement | ImageBitmap;

export class MediaLayer {
  private readonly pipeImage: GPURenderPipeline;
  private readonly pipeVideo: GPURenderPipeline;
  private readonly uniform: GPUBuffer;
  private readonly sampler: GPUSampler;
  private source: Media | null = null;
  private imageTex: GPUTexture | null = null;
  private imageBind: GPUBindGroup | null = null;
  private readonly ndc = new Float32Array(4); // reused each draw (no per-frame alloc)
  private videoLayout?: GPUBindGroupLayout; // cached (a video rebuilds only the bind group)

  constructor(
    private readonly device: GPUDevice,
    format: GPUTextureFormat,
  ) {
    const make = (code: string) => {
      const module = device.createShaderModule({ code });
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
    };
    this.pipeImage = make(WGSL_IMAGE);
    this.pipeVideo = make(WGSL_VIDEO);
    this.uniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  setSource(media: Media | null): void {
    if (media === this.source) return;
    this.source = media;
    this.imageTex?.destroy();
    this.imageTex = null;
    this.imageBind = null;
    if (media && !(media instanceof HTMLVideoElement)) this.uploadImage(media);
  }

  private uploadImage(img: HTMLImageElement | ImageBitmap): void {
    const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
    const h = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
    if (w <= 0 || h <= 0) return;
    try {
      this.imageTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.copyExternalImageToTexture(
        { source: img },
        { texture: this.imageTex },
        { width: w, height: h },
      );
      this.imageBind = this.device.createBindGroup({
        layout: this.pipeImage.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.imageTex.createView() },
        ],
      });
    } catch {
      this.imageTex = null;
      this.imageBind = null;
    }
  }

  /** True when a source is attached and currently drawable. */
  get active(): boolean {
    if (!this.source) return false;
    if (this.source instanceof HTMLVideoElement) {
      return this.source.videoWidth > 0 && this.source.readyState >= 2;
    }
    return this.imageBind !== null;
  }

  /** Encode the cover-fit blit (call first in the pass; it overwrites). */
  draw(pass: GPURenderPassEncoder, viewW: number, viewH: number): void {
    const src = this.source;
    if (!src || !this.active) return;
    const bw = src instanceof HTMLVideoElement ? src.videoWidth : (this.imageTex?.width ?? 0);
    const bh = src instanceof HTMLVideoElement ? src.videoHeight : (this.imageTex?.height ?? 0);
    if (bw <= 0 || bh <= 0) return;
    // Cover-fit rect in css px → NDC.
    const scale = Math.max(viewW / bw, viewH / bh);
    const dw = bw * scale;
    const dh = bh * scale;
    const x0 = (viewW - dw) / 2;
    const y0 = (viewH - dh) / 2;
    const ndc = this.ndc;
    ndc[0] = (x0 / viewW) * 2 - 1;
    ndc[1] = 1 - ((y0 + dh) / viewH) * 2;
    ndc[2] = ((x0 + dw) / viewW) * 2 - 1;
    ndc[3] = 1 - (y0 / viewH) * 2;
    this.device.queue.writeBuffer(this.uniform, 0, ndc);

    if (src instanceof HTMLVideoElement) {
      let external: GPUExternalTexture;
      try {
        external = this.device.importExternalTexture({ source: src });
      } catch {
        return; // frame not available yet — keep the cleared background
      }
      // The external texture is transient (valid one frame) so the bind group
      // must be rebuilt each frame; the layout is stable, so cache it.
      this.videoLayout ??= this.pipeVideo.getBindGroupLayout(0);
      const bind = this.device.createBindGroup({
        layout: this.videoLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: external },
        ],
      });
      pass.setPipeline(this.pipeVideo);
      pass.setBindGroup(0, bind);
      pass.draw(6);
    } else if (this.imageBind) {
      pass.setPipeline(this.pipeImage);
      pass.setBindGroup(0, this.imageBind);
      pass.draw(6);
    }
  }

  destroy(): void {
    try {
      this.imageTex?.destroy();
      this.uniform.destroy();
    } catch {
      // device already lost
    }
  }
}
