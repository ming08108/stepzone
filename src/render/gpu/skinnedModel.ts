/**
 * WebGPU skinned-mesh renderer for a glTF character (Phase 1: load + skin +
 * render in a static pose). Foundation for a real 3D character in the attract
 * background; Phase 2 will feed retargeted per-joint rotations into `setPose`.
 *
 * The model rigs two ways at once (see gltf.ts): rigid body meshes parented to
 * bones, plus two truly skinned hands. Both go through one skinning pipeline —
 * rigid primitives carry zero joint weights and a per-draw model matrix
 * (`useSkin = 0`), skinned primitives blend the joint palette (`useSkin = 1`).
 *
 * Each frame we walk the node hierarchy with the current local matrices to get
 * global matrices, then per skin build `jointMatrix = global[joint] *
 * inverseBind` and upload the palette (storage buffer). The character is drawn
 * into its OWN offscreen color + depth target so it self-occludes correctly;
 * `colorView` + `sampler` let a caller composite it as a cover-fit quad.
 *
 * All per-frame buffers are preallocated — render() does no allocation.
 */

import {
  parseGlb,
  computeGlobals,
  mat4Multiply,
  type GltfModel,
  type GltfPrimitive,
} from './gltf.ts';

export interface Camera {
  /** Vertical field of view in radians (default framed from the model). */
  fovY?: number;
  eye?: [number, number, number];
  target?: [number, number, number];
  up?: [number, number, number];
  near?: number;
  far?: number;
}

interface GpuPrimitive {
  posBuf: GPUBuffer;
  nrmBuf: GPUBuffer;
  jntBuf: GPUBuffer;
  wgtBuf: GPUBuffer;
  idxBuf: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  nodeIndex: number;
  skinIndex: number;
  jointBase: number; // palette offset (in joints) for this primitive's skin
  baseColor: [number, number, number, number];
}

const DRAW_STRIDE = 256; // dynamic-uniform offset alignment
const DRAW_FLOATS = DRAW_STRIDE / 4;
const FRAME_FLOATS = 28; // viewProj(16) + lightDir(4) + tint(4) + camPos(4)

const WGSL = /* wgsl */ `
struct Frame {
  viewProj : mat4x4f,
  lightDir : vec4f,
  tint     : vec4f,
  camPos   : vec4f,
};
@group(0) @binding(0) var<uniform> frame : Frame;
@group(0) @binding(1) var<storage, read> palette : array<mat4x4f>;

struct Draw {
  model     : mat4x4f,
  baseColor : vec4f,
  jointBase : u32,
  useSkin   : u32,
  _p0       : u32,
  _p1       : u32,
};
@group(1) @binding(0) var<uniform> draw : Draw;

struct VOut {
  @builtin(position) pos  : vec4f,
  @location(0)       nrm  : vec3f,
  @location(1)       wpos : vec3f,
};

@vertex
fn vs(
  @location(0) position : vec3f,
  @location(1) normal   : vec3f,
  @location(2) joints   : vec4u,
  @location(3) weights  : vec4f,
) -> VOut {
  var world : vec4f;
  var wn : vec3f;
  if (draw.useSkin == 1u) {
    let m = weights.x * palette[draw.jointBase + joints.x]
          + weights.y * palette[draw.jointBase + joints.y]
          + weights.z * palette[draw.jointBase + joints.z]
          + weights.w * palette[draw.jointBase + joints.w];
    world = m * vec4f(position, 1.0);
    wn = (m * vec4f(normal, 0.0)).xyz;
  } else {
    world = draw.model * vec4f(position, 1.0);
    wn = (draw.model * vec4f(normal, 0.0)).xyz;
  }
  var o : VOut;
  o.pos = frame.viewProj * world;
  o.nrm = wn;
  o.wpos = world.xyz;
  return o;
}

@fragment
fn fs(@location(0) nrm : vec3f, @location(1) wpos : vec3f) -> @location(0) vec4f {
  let n = normalize(nrm);
  let l = normalize(frame.lightDir.xyz);
  let diff = max(dot(n, l), 0.0);
  let ambient = 0.35;
  let viewDir = normalize(frame.camPos.xyz - wpos);
  let rim = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0) * 0.35;
  let base = draw.baseColor.rgb * frame.tint.rgb;
  let lit = base * (ambient + diff * 0.85) + rim;
  return vec4f(lit, draw.baseColor.a * frame.tint.a);
}
`;

export class SkinnedModel {
  readonly boneNames: readonly string[];
  private colorTex: GPUTexture | null = null;
  private depthTex: GPUTexture | null = null;
  private _colorView: GPUTextureView | null = null;
  private texW = 0;
  private texH = 0;

  // Per-frame scratch — all preallocated, no allocation in render().
  private readonly workingLocals: Float32Array<ArrayBuffer>; // per-node local matrices
  private readonly globals: Float32Array<ArrayBuffer>; // per-node global matrices
  private readonly paletteData: Float32Array<ArrayBuffer>; // all skins' joint matrices
  private readonly frameData = new Float32Array(FRAME_FLOATS);
  private readonly drawData: Float32Array<ArrayBuffer>;
  private readonly drawDataU32: Uint32Array<ArrayBuffer>;
  private readonly viewM = new Float32Array(16);
  private readonly projM = new Float32Array(16);

  // Default camera framed to the model bounds (each field overridable).
  private readonly boundsCenter: [number, number, number];
  private readonly boundsRadius: number;

  private tint: [number, number, number, number] = [1, 1, 1, 1];

  private constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly model: GltfModel,
    private readonly prims: GpuPrimitive[],
    private readonly frameBuf: GPUBuffer,
    private readonly paletteBuf: GPUBuffer,
    private readonly drawBuf: GPUBuffer,
    private readonly pipeline: GPURenderPipeline,
    private readonly group0: GPUBindGroup,
    private readonly group1: GPUBindGroup,
    readonly sampler: GPUSampler,
    private readonly skinJointOffsets: number[],
    boneNames: string[],
    boundsCenter: [number, number, number],
    boundsRadius: number,
  ) {
    this.boneNames = boneNames;
    this.boundsCenter = boundsCenter;
    this.boundsRadius = boundsRadius;
    const nNodes = model.nodes.length;
    this.workingLocals = new Float32Array(nNodes * 16);
    for (let i = 0; i < nNodes; i++) this.workingLocals.set(model.nodes[i].localMatrix, i * 16);
    this.globals = new Float32Array(nNodes * 16);
    let paletteLen = 0;
    for (const s of model.skins) paletteLen += s.joints.length;
    this.paletteData = new Float32Array(Math.max(1, paletteLen) * 16);
    this.drawData = new Float32Array(Math.max(1, prims.length) * DRAW_FLOATS);
    this.drawDataU32 = new Uint32Array(this.drawData.buffer);
  }

  static async load(
    device: GPUDevice,
    format: GPUTextureFormat,
    url: string,
  ): Promise<SkinnedModel> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SkinnedModel: fetch ${url} failed (${res.status})`);
    const model = parseGlb(await res.arrayBuffer());

    // Palette layout: skins concatenated; each primitive's jointBase indexes in.
    const skinJointOffsets: number[] = [];
    let acc = 0;
    for (const s of model.skins) {
      skinJointOffsets.push(acc);
      acc += s.joints.length;
    }
    const paletteLen = Math.max(1, acc);

    // GPU buffers per primitive.
    const prims: GpuPrimitive[] = model.primitives.map((p) => {
      const jointBase = p.skinIndex >= 0 ? skinJointOffsets[p.skinIndex] : 0;
      return {
        posBuf: makeVertexBuffer(device, p.position),
        nrmBuf: makeVertexBuffer(device, p.normal),
        jntBuf: makeVertexBufferU16(device, p.joints),
        wgtBuf: makeVertexBuffer(device, p.weights),
        idxBuf: makeIndexBuffer(device, p.indices),
        indexCount: p.indices.length,
        indexFormat: p.indices instanceof Uint32Array ? 'uint32' : 'uint16',
        nodeIndex: p.nodeIndex,
        skinIndex: p.skinIndex,
        jointBase,
        baseColor: p.baseColor,
      };
    });

    const frameBuf = device.createBuffer({
      size: FRAME_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const paletteBuf = device.createBuffer({
      size: paletteLen * 16 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const drawBuf = device.createBuffer({
      size: Math.max(1, prims.length) * DRAW_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const module = device.createShaderModule({ code: WGSL });
    const group0Layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const group1Layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 96 },
        },
      ],
    });
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [group0Layout, group1Layout] }),
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'uint16x4' }] },
          { arrayStride: 16, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    const group0 = device.createBindGroup({
      layout: group0Layout,
      entries: [
        { binding: 0, resource: { buffer: frameBuf } },
        { binding: 1, resource: { buffer: paletteBuf } },
      ],
    });
    const group1 = device.createBindGroup({
      layout: group1Layout,
      entries: [{ binding: 0, resource: { buffer: drawBuf, size: 96 } }],
    });

    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const boneNames = model.skins[0]?.jointNames.slice() ?? [];
    const { center, radius } = computeBounds(model, skinJointOffsets);

    return new SkinnedModel(
      device,
      format,
      model,
      prims,
      frameBuf,
      paletteBuf,
      drawBuf,
      pipeline,
      group0,
      group1,
      sampler,
      skinJointOffsets,
      boneNames,
      center,
      radius,
    );
  }

  /** Rest-pose local matrices for skin[0]'s joints (palette order), 16 floats each. */
  bindPose(): Float32Array {
    const joints = this.model.skins[0]?.joints ?? [];
    const out = new Float32Array(joints.length * 16);
    for (let j = 0; j < joints.length; j++) {
      out.set(this.model.nodes[joints[j]].localMatrix, j * 16);
    }
    return out;
  }

  /**
   * Set the per-joint LOCAL matrices (skin[0] palette order, 16 floats each) to
   * pose the skeleton. Joints not covered keep their rest local. Phase 2 will
   * feed retargeted rotations here.
   */
  setPose(localMatrices: Float32Array): void {
    const joints = this.model.skins[0]?.joints ?? [];
    const n = Math.min(joints.length, Math.floor(localMatrices.length / 16));
    for (let j = 0; j < n; j++) {
      this.workingLocals.set(localMatrices.subarray(j * 16, j * 16 + 16), joints[j] * 16);
    }
  }

  /** Reset the skeleton to its parsed rest pose. */
  resetPose(): void {
    for (let i = 0; i < this.model.nodes.length; i++) {
      this.workingLocals.set(this.model.nodes[i].localMatrix, i * 16);
    }
  }

  /** Override the color tint (multiplies base colors). Default white. */
  setTint(r: number, g: number, b: number, a = 1): void {
    this.tint = [r, g, b, a];
  }

  get colorView(): GPUTextureView {
    if (!this._colorView)
      throw new Error('SkinnedModel: render() must run before colorView is read');
    return this._colorView;
  }

  private ensureTargets(w: number, h: number): void {
    if (this.colorTex && this.texW === w && this.texH === h) return;
    this.colorTex?.destroy();
    this.depthTex?.destroy();
    this.colorTex = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.depthTex = this.device.createTexture({
      size: [w, h],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._colorView = this.colorTex.createView();
    this.texW = w;
    this.texH = h;
  }

  /**
   * Render the skinned model into its own offscreen color + depth target sized
   * WxH, from a simple perspective camera framing the character. Reads
   * `colorView` afterward to composite the result.
   */
  render(encoder: GPUCommandEncoder, w: number, h: number, camera: Camera = {}): void {
    if (w <= 0 || h <= 0) return;
    this.ensureTargets(w, h);

    // 1. Node globals from the current local matrices.
    computeGlobals(this.model, this.workingLocals, this.globals);

    // 2. Joint palette: jointMatrix = global[joint] * inverseBind, per skin.
    for (let s = 0; s < this.model.skins.length; s++) {
      const skin = this.model.skins[s];
      const base = this.skinJointOffsets[s];
      for (let j = 0; j < skin.joints.length; j++) {
        mat4Multiply(
          this.paletteData,
          (base + j) * 16,
          this.globals,
          skin.joints[j] * 16,
          skin.inverseBind,
          j * 16,
        );
      }
    }
    if (this.paletteData.length >= 16) {
      this.device.queue.writeBuffer(this.paletteBuf, 0, this.paletteData);
    }

    // 3. Camera → view-projection + frame uniform.
    const eye = camera.eye ?? this.defaultEye();
    const target = camera.target ?? this.boundsCenter;
    const up = camera.up ?? [0, 1, 0];
    const fovY = camera.fovY ?? 0.62; // ~35.5°
    const near = camera.near ?? Math.max(0.01, this.boundsRadius * 0.05);
    const far = camera.far ?? this.boundsRadius * 20;
    lookAt(this.viewM, eye, target, up);
    perspectiveZO(this.projM, fovY, w / h, near, far);
    // frame.viewProj = proj * view
    mat4Multiply(this.frameData, 0, this.projM, 0, this.viewM, 0);
    this.frameData[16] = 0.4; // lightDir (from upper-front-right)
    this.frameData[17] = 0.8;
    this.frameData[18] = 0.6;
    this.frameData[19] = 0;
    this.frameData[20] = this.tint[0];
    this.frameData[21] = this.tint[1];
    this.frameData[22] = this.tint[2];
    this.frameData[23] = this.tint[3];
    this.frameData[24] = eye[0];
    this.frameData[25] = eye[1];
    this.frameData[26] = eye[2];
    this.frameData[27] = 0;
    this.device.queue.writeBuffer(this.frameBuf, 0, this.frameData);

    // 4. Per-draw uniforms (model matrix + material + skin flags).
    for (let i = 0; i < this.prims.length; i++) {
      const p = this.prims[i];
      const o = i * DRAW_FLOATS;
      // model matrix = node global (used only when useSkin == 0)
      this.drawData.set(this.globals.subarray(p.nodeIndex * 16, p.nodeIndex * 16 + 16), o);
      this.drawData[o + 16] = p.baseColor[0];
      this.drawData[o + 17] = p.baseColor[1];
      this.drawData[o + 18] = p.baseColor[2];
      this.drawData[o + 19] = p.baseColor[3];
      this.drawDataU32[o + 20] = p.jointBase;
      this.drawDataU32[o + 21] = p.skinIndex >= 0 ? 1 : 0;
      this.drawDataU32[o + 22] = 0;
      this.drawDataU32[o + 23] = 0;
    }
    if (this.prims.length > 0) this.device.queue.writeBuffer(this.drawBuf, 0, this.drawData);

    // 5. Draw into the offscreen target.
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this._colorView!,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTex!.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group0);
    for (let i = 0; i < this.prims.length; i++) {
      const p = this.prims[i];
      pass.setBindGroup(1, this.group1, [i * DRAW_STRIDE]);
      pass.setVertexBuffer(0, p.posBuf);
      pass.setVertexBuffer(1, p.nrmBuf);
      pass.setVertexBuffer(2, p.jntBuf);
      pass.setVertexBuffer(3, p.wgtBuf);
      pass.setIndexBuffer(p.idxBuf, p.indexFormat);
      pass.drawIndexed(p.indexCount);
    }
    pass.end();
  }

  /** Default camera eye: in front of the character, slightly above (small tilt). */
  private defaultEye(): [number, number, number] {
    const c = this.boundsCenter;
    // Far enough that the whole bounding sphere clears the ~35° fov (asin(1/3.4)),
    // with a small lift so the camera looks very slightly down at the character.
    const dist = this.boundsRadius * 3.4;
    return [c[0], c[1] + this.boundsRadius * 0.18, c[2] + dist];
  }
}

// ---------------------------------------------------------------------------
// Buffer helpers.
// ---------------------------------------------------------------------------

function makeVertexBuffer(device: GPUDevice, data: Float32Array<ArrayBuffer>): GPUBuffer {
  const buf = device.createBuffer({
    size: Math.max(4, align4(data.byteLength)),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, data);
  return buf;
}

function makeVertexBufferU16(device: GPUDevice, data: Uint16Array<ArrayBuffer>): GPUBuffer {
  const buf = device.createBuffer({
    size: Math.max(4, align4(data.byteLength)),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, data);
  return buf;
}

function makeIndexBuffer(
  device: GPUDevice,
  data: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>,
): GPUBuffer {
  const size = Math.max(4, align4(data.byteLength));
  const buf = device.createBuffer({ size, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  // writeBuffer requires the written byte length to be a multiple of 4; pad
  // u16 index runs with an odd element count into a zero-tail buffer.
  if (data instanceof Uint16Array && data.byteLength % 4 !== 0) {
    const padded = new Uint16Array(size / 2);
    padded.set(data);
    device.queue.writeBuffer(buf, 0, padded);
  } else {
    device.queue.writeBuffer(buf, 0, data);
  }
  return buf;
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

// ---------------------------------------------------------------------------
// Bounds (rest pose) → camera framing.
// ---------------------------------------------------------------------------

function computeBounds(
  model: GltfModel,
  skinJointOffsets: number[],
): { center: [number, number, number]; radius: number } {
  const globals = new Float32Array(model.nodes.length * 16);
  computeGlobals(model, null, globals);

  // Rest joint palette (for skinned prim bounds).
  let paletteLen = 0;
  for (const s of model.skins) paletteLen += s.joints.length;
  const palette = new Float32Array(Math.max(1, paletteLen) * 16);
  for (let s = 0; s < model.skins.length; s++) {
    const skin = model.skins[s];
    const base = skinJointOffsets[s];
    for (let j = 0; j < skin.joints.length; j++) {
      mat4Multiply(
        palette,
        (base + j) * 16,
        globals,
        skin.joints[j] * 16,
        skin.inverseBind,
        j * 16,
      );
    }
  }

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  const p = new Float32Array(3);
  for (const prim of model.primitives) {
    const vc = prim.position.length / 3;
    for (let v = 0; v < vc; v++) {
      const x = prim.position[v * 3];
      const y = prim.position[v * 3 + 1];
      const z = prim.position[v * 3 + 2];
      if (prim.skinIndex >= 0) {
        skinPoint(p, prim, v, palette, skinJointOffsets[prim.skinIndex]);
      } else {
        transformPoint(p, globals, prim.nodeIndex * 16, x, y, z);
      }
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[2] < minZ) minZ = p[2];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
      if (p[2] > maxZ) maxZ = p[2];
    }
  }
  if (!isFinite(minX)) {
    return { center: [0, 0, 0], radius: 1 };
  }
  const center: [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];
  const dx = maxX - minX,
    dy = maxY - minY,
    dz = maxZ - minZ;
  const radius = 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { center, radius: radius > 0 ? radius : 1 };
}

function transformPoint(
  out: Float32Array,
  m: Float32Array,
  mo: number,
  x: number,
  y: number,
  z: number,
): void {
  out[0] = m[mo] * x + m[mo + 4] * y + m[mo + 8] * z + m[mo + 12];
  out[1] = m[mo + 1] * x + m[mo + 5] * y + m[mo + 9] * z + m[mo + 13];
  out[2] = m[mo + 2] * x + m[mo + 6] * y + m[mo + 10] * z + m[mo + 14];
}

function skinPoint(
  out: Float32Array,
  prim: GltfPrimitive,
  v: number,
  palette: Float32Array,
  base: number,
): void {
  const x = prim.position[v * 3];
  const y = prim.position[v * 3 + 1];
  const z = prim.position[v * 3 + 2];
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  const tmp = _skinTmp;
  for (let k = 0; k < 4; k++) {
    const w = prim.weights[v * 4 + k];
    if (w === 0) continue;
    const jm = (base + prim.joints[v * 4 + k]) * 16;
    transformPoint(tmp, palette, jm, x, y, z);
    out[0] += w * tmp[0];
    out[1] += w * tmp[1];
    out[2] += w * tmp[2];
  }
}
const _skinTmp = new Float32Array(3);

// ---------------------------------------------------------------------------
// View / projection (column-major, WebGPU depth range [0,1]).
// ---------------------------------------------------------------------------

function perspectiveZO(
  out: Float32Array,
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): void {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  if (far !== Infinity) {
    const nf = 1 / (near - far);
    out[10] = far * nf;
    out[14] = far * near * nf;
  } else {
    out[10] = -1;
    out[14] = -near;
  }
}

function lookAt(
  out: Float32Array,
  eye: readonly number[],
  center: readonly number[],
  up: readonly number[],
): void {
  let zx = eye[0] - center[0],
    zy = eye[1] - center[1],
    zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len;
  zy /= len;
  zz /= len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz);
  if (len === 0) {
    xx = 1;
    xy = 0;
    xz = 0;
  } else {
    xx /= len;
    xy /= len;
    xz /= len;
  }
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
}
