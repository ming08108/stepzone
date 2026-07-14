/**
 * WebGPU skinned-mesh renderer for a glTF character. Loads + skins + renders the
 * model (Phase 1), and poses it from our animation's solved skeleton via an
 * aim-constraint retarget (`retargetFromSkeleton`, Phase 2). Foundation for a
 * real 3D character in the attract background.
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
  type GltfSampler,
} from './gltf.ts';
import {
  X_SIGN,
  Y_SIGN,
  Z_SIGN,
  AXIS_ORDER,
  POS_SCALE,
  BONE_CHAINS,
  VRM_CHAINS,
  type RetargetBone,
} from './retargetRig.ts';
import {
  quatFromMat,
  quatMul,
  quatInvMul,
  quatFromTo,
  quatSlerpIdentity,
  mat4Invert,
  dist3,
  composeTRSAt,
  transformPoint,
  skinPoint,
  perspectiveZO,
  lookAt,
} from './skinnedMath.ts';

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
  uvBuf: GPUBuffer;
  idxBuf: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  nodeIndex: number;
  skinIndex: number;
  jointBase: number; // palette offset (in joints) for this primitive's skin
  baseColor: [number, number, number, number];
  materialIndex: number;
  useTexture: boolean;
  isBlend: boolean;
  alphaCutoff: number;
  pipeline: GPURenderPipeline; // variant for this prim's alpha mode + cull
  texBind: GPUBindGroup; // group 2: base-color texture + sampler
  recolor: boolean; // replace texture hue with baseColor, keep luminance (hair tint)
  faceKind: number; // 0 = body, 1 = face/skin (spare the neon wash), 2 = eye highlight (emissive)
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
  model      : mat4x4f,
  baseColor  : vec4f,   // flat color, or base-color factor for textured prims
  jointBase  : u32,
  useSkin    : u32,
  flags      : u32,     // bit0 = use base-color texture, bit1 = alpha-blended
  alphaCutoff: f32,     // MASK alpha test threshold (0 for OPAQUE/BLEND)
};
@group(1) @binding(0) var<uniform> draw : Draw;

@group(2) @binding(0) var baseSampler : sampler;
@group(2) @binding(1) var baseTex : texture_2d<f32>;

struct VOut {
  @builtin(position) pos  : vec4f,
  @location(0)       nrm  : vec3f,
  @location(1)       wpos : vec3f,
  @location(2)       uv   : vec2f,
};

@vertex
fn vs(
  @location(0) position : vec3f,
  @location(1) normal   : vec3f,
  @location(2) joints   : vec4u,
  @location(3) weights  : vec4f,
  @location(4) uv       : vec2f,
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
  o.uv = uv;
  return o;
}

@fragment
fn fs(
  @location(0) nrm : vec3f,
  @location(1) wpos : vec3f,
  @location(2) uv : vec2f,
) -> @location(0) vec4f {
  let useTex = (draw.flags & 1u) != 0u;
  let isBlend = (draw.flags & 2u) != 0u;
  let recolor = (draw.flags & 4u) != 0u;
  let isFace = (draw.flags & 8u) != 0u;  // face/skin: spare the neon wash, warm fill
  let isEyeHi = (draw.flags & 16u) != 0u; // eye highlight: emissive catchlight

  // Albedo: sampled texture × factor (textured), or the flat material color.
  // The base-color texture is created sRGB so the sample is already linear.
  // recolor replaces the texture's hue with baseColor while keeping its
  // luminance (strand shading) — used to tint hair (e.g. a teal Miku look).
  var albedo : vec3f;
  var alpha : f32;
  if (useTex) {
    let texel = textureSample(baseTex, baseSampler, uv);
    if (recolor) {
      let lum = dot(texel.rgb, vec3f(0.3, 0.59, 0.11));
      albedo = clamp(lum * 1.5, 0.12, 1.25) * draw.baseColor.rgb;
    } else {
      albedo = texel.rgb * draw.baseColor.rgb;
    }
    alpha = texel.a * draw.baseColor.a;
  } else {
    albedo = draw.baseColor.rgb;
    alpha = draw.baseColor.a;
  }
  if (alpha < draw.alphaCutoff) { discard; } // MASK cutout

  // Guard against absent normals (some decimated/exported meshes drop NORMAL):
  // normalize(0) is NaN, which renders the whole prim black. Fall back to a
  // camera-facing normal so it flat-shades instead.
  let nl = length(nrm);
  let n = select(normalize(frame.camPos.xyz - wpos), nrm / nl, nl > 1e-4);
  let l = normalize(frame.lightDir.xyz);
  let viewDir = normalize(frame.camPos.xyz - wpos);
  // Toon shade: quantize the diffuse into a couple of soft bands so the model
  // reads as a stylized cel character (PS2-DDR dancer), not a flat/murky mesh.
  // The bands are lifted (0.72..1.05) so nothing sinks into a dead grey.
  let ndl = dot(n, l) * 0.5 + 0.5; // half-lambert — softer wrap, no black side
  let band = smoothstep(0.34, 0.5, ndl) * 0.2 + smoothstep(0.55, 0.72, ndl) * 0.18;
  // Keep the exposure MODEST so lit white cloth lands ~0.8, not clipped to 1.0 —
  // clipping forced R=G=B and erased the neon tint (bright-but-grey torso). The
  // colour comes from a STRONG multiply-tint, not from cranking brightness.
  // Face prims are spared the neon wash — the earlier pass crushed the eyes/skin
  // into the body's rose hue (a mannequin with no readable face). Lift the shade
  // floor, cut the tint/grade/rim on the face, and warm it with a camera fill.
  let shade = select(0.84, 0.98, isFace) + band; // brighter base for arcade screens
  // The neon world's colour, by facing: cyan on one side, magenta on the other.
  let envCol = mix(vec3f(0.35, 0.85, 1.15), vec3f(1.2, 0.42, 0.95), n.x * 0.5 + 0.5);
  // TINT the albedo toward that neon (multiplied) so even a white outfit goes
  // lavender/cyan; strong on the body, gentle on the face so skin stays skin.
  let tinted = albedo * mix(vec3f(1.0), envCol, select(0.6, 0.15, isFace));
  // Ambient neon fill + a camera-facing warm fill (stronger on the face) so the
  // face reads without bleaching the cardigan back to grey.
  let fill = envCol * (1.0 - ndl) * 0.18;
  let front = max(dot(n, viewDir), 0.0);
  var lit = tinted * frame.tint.rgb * shade + tinted * fill + envCol * front * 0.1
    + albedo * front * select(0.0, 0.32, isFace);
  // Hot rim — BLEND the silhouette toward saturated neon; strong on the body, cut
  // hard on the face (a neon rim across a nose reads as grime at this scale).
  let rimAmt = pow(1.0 - max(dot(n, viewDir), 0.0), 1.5);
  lit = mix(lit, envCol * 2.3, clamp(rimAmt * select(0.92, 0.2, isFace), 0.0, 0.9));
  // Pad up-glow: magenta light from the deck onto downward-facing surfaces
  // (shins, shoe tops, jaw underside) — grounds her ON the lit stage.
  lit += vec3f(1.0, 0.3, 0.72) * max(-n.y, 0.0) * 0.5;
  // Re-encode to sRGB for textured prims (linear lighting → sRGB store);
  // flat-color prims keep the renderer's original non-linear passthrough.
  if (useTex) { lit = pow(max(lit, vec3f(0.0)), vec3f(1.0 / 2.2)); }
  // Post-clamp neon GRADE: recolour the FINAL pixel toward the environment hue
  // (magenta on one side, cyan on the other). Applied here — after the exposure
  // clamp — so no brightness choice can wash the tint out (earlier the ~1.0
  // ceiling ate half of it, leaving a near-grey torso). Normalized by its max
  // channel so it only shifts hue, never darkens.
  let em = max(max(envCol.r, envCol.g), envCol.b);
  lit = lit * mix(vec3f(1.0), envCol / em, select(0.3, 0.08, isFace));
  // Eye highlights: bypass all lighting and go emissive — two bright catchlights
  // that survive the dither and attract distance. This is the pixel that flips
  // "mannequin" to "she's performing for you".
  if (isEyeHi) { lit = albedo * 1.9; }

  let outA = select(1.0, alpha, isBlend) * frame.tint.a;
  return vec4f(lit, outA);
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

  /** Model bounds (for a caller computing an orbiting/dolly camera). */
  get center(): readonly [number, number, number] {
    return this.boundsCenter;
  }
  get radius(): number {
    return this.boundsRadius;
  }

  private tint: [number, number, number, number] = [1, 1, 1, 1];

  // --- Retargeting bind data + scratch (built in the constructor). ----------
  private retargetBones: RetargetBone[] = [];
  private retargetByNode: (RetargetBone | undefined)[] = [];
  private bindGlobalQuat!: Float32Array<ArrayBuffer>; // per node, [x,y,z,w]
  private bindLocalQuat!: Float32Array<ArrayBuffer>; // per node
  private bindLocalTrans!: Float32Array<ArrayBuffer>; // per node, [x,y,z]
  private bindLocalScale!: Float32Array<ArrayBuffer>; // per node, [x,y,z]
  private curGlobalQuat!: Float32Array<ArrayBuffer>; // per node scratch
  private retargetLocals!: Float32Array<ArrayBuffer>; // palette-order out (16 each)
  private bindPaletteLocals!: Float32Array<ArrayBuffer>; // palette-order bind locals
  private readonly qA = new Float32Array(4);
  private readonly qB = new Float32Array(4);
  private readonly qC = new Float32Array(4); // pole roll delta
  private readonly vDir = new Float32Array(3);
  private readonly vComp = new Float32Array(3);
  private readonly vWorld = new Float32Array(3);
  private readonly vLocal = new Float32Array(3);
  private readonly vN = new Float32Array(3); // pole: target bend-plane normal
  private readonly vN1 = new Float32Array(3); // pole: aim-rotated rest normal
  private readonly vSeg = new Float32Array(3); // pole: scratch segment

  // --- Foot/root placement (feet step to our foot joints). ------------------
  private placeEnabled = false;
  private placeBody = -1; // palette slot of the pelvis/root proxy bone (Body)
  private placeBodyNode = -1;
  private placeFootL = -1; // palette slot of Foot.L bone
  private placeFootLNode = -1;
  private placeFootR = -1;
  private placeFootRNode = -1;
  private readonly invParentGlobal = new Float32Array(16); // inverse of feet/body parent bind global
  private readonly pelvisAnchor = new Float32Array(3); // model pos our pelvis maps to
  private modelLegLen = 1;
  private posScale = NaN; // our→model scale, locked on first retarget
  private readonly pelvis0 = new Float32Array(3); // our pelvis on first retarget
  private haveAnchor = false;
  // Place the feet as independent siblings (robot rig) vs. body-only (VRM, where
  // the feet are descendants of the hips, so translating the hips moves the
  // whole body and the aimed leg bones follow the stepped foot positions).
  private placeFeetSep = false;

  // --- Per-material color override (recolor to the scene palette). ----------
  private matColor!: Float32Array<ArrayBuffer>; // nMaterials * 3 rgb
  private matColorHas!: Uint8Array; // per-material override flag
  private nMaterials = 0;

  private constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly model: GltfModel,
    private readonly prims: GpuPrimitive[],
    private readonly frameBuf: GPUBuffer,
    private readonly paletteBuf: GPUBuffer,
    private readonly drawBuf: GPUBuffer,
    private readonly group0: GPUBindGroup,
    private readonly group1: GPUBindGroup,
    readonly sampler: GPUSampler,
    private readonly skinJointOffsets: number[],
    private readonly opaqueOrder: number[],
    private readonly blendOrder: number[],
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
    let maxMat = -1;
    for (const p of prims) if (p.materialIndex > maxMat) maxMat = p.materialIndex;
    this.nMaterials = maxMat + 1;
    this.matColor = new Float32Array(Math.max(1, this.nMaterials) * 3);
    this.matColorHas = new Uint8Array(Math.max(1, this.nMaterials));
    this.buildRetargetData();
  }

  /**
   * Precompute the bind-pose data the aim retarget needs: per-node bind global
   * and bind local rotations (quaternions), bind local translation/scale, and
   * the resolved bone chains with their rest aim directions. Bones are resolved
   * through skin[0]'s joints so mesh nodes that share a bone's name never match.
   */
  private buildRetargetData(): void {
    const model = this.model;
    const nNodes = model.nodes.length;
    this.bindGlobalQuat = new Float32Array(nNodes * 4);
    this.bindLocalQuat = new Float32Array(nNodes * 4);
    this.bindLocalTrans = new Float32Array(nNodes * 3);
    this.bindLocalScale = new Float32Array(nNodes * 3);
    this.curGlobalQuat = new Float32Array(nNodes * 4);

    // Bind global matrices → per-node bind global rotation.
    const bindGlobals = new Float32Array(nNodes * 16);
    computeGlobals(model, null, bindGlobals);
    for (let i = 0; i < nNodes; i++) {
      quatFromMat(this.bindGlobalQuat, i * 4, bindGlobals, i * 16);
      const lm = model.nodes[i].localMatrix;
      quatFromMat(this.bindLocalQuat, i * 4, lm, 0);
      this.bindLocalTrans[i * 3] = lm[12];
      this.bindLocalTrans[i * 3 + 1] = lm[13];
      this.bindLocalTrans[i * 3 + 2] = lm[14];
      this.bindLocalScale[i * 3] = Math.hypot(lm[0], lm[1], lm[2]) || 1;
      this.bindLocalScale[i * 3 + 1] = Math.hypot(lm[4], lm[5], lm[6]) || 1;
      this.bindLocalScale[i * 3 + 2] = Math.hypot(lm[8], lm[9], lm[10]) || 1;
    }

    // Palette bind locals (fallback for unmapped joints) + node→palette map.
    const joints = model.skins[0]?.joints ?? [];
    this.bindPaletteLocals = new Float32Array(joints.length * 16);
    const paletteOfNode = new Map<number, number>();
    for (let j = 0; j < joints.length; j++) {
      this.bindPaletteLocals.set(model.nodes[joints[j]].localMatrix, j * 16);
      if (!paletteOfNode.has(joints[j])) paletteOfNode.set(joints[j], j);
    }
    this.retargetLocals = new Float32Array(Math.max(1, joints.length) * 16);

    // Resolve each chain: bone must be a palette joint; restChild a descendant.
    const nameToPalette = new Map<string, number>();
    const jointNames = model.skins[0]?.jointNames ?? [];
    for (let j = 0; j < jointNames.length; j++) {
      if (!nameToPalette.has(jointNames[j])) nameToPalette.set(jointNames[j], j);
    }
    // Resolve each chain to (bone node, rest-child node). VRM models resolve
    // through the humanoid map; otherwise fall back to the robot's node names.
    const humanoid = model.humanoid;
    const resolveBone = (name: string): number =>
      humanoid
        ? (humanoid[name] ?? -1)
        : nameToPalette.get(name) !== undefined
          ? joints[nameToPalette.get(name)!]
          : -1;
    const resolveChild = (boneNode: number, name: string): number =>
      humanoid ? (humanoid[name] ?? -1) : findDescendantByName(model, boneNode, name);
    const chains = humanoid ? VRM_CHAINS : BONE_CHAINS;

    this.retargetBones = [];
    this.retargetByNode = new Array(nNodes).fill(undefined);
    for (const chain of chains) {
      const node = resolveBone(chain.bone);
      if (node < 0) continue;
      const palette = paletteOfNode.get(node);
      if (palette === undefined) continue; // bone must be a skin joint
      const dir = new Float32Array(3);
      if (!chain.hold) {
        const child = resolveChild(node, chain.restChild);
        if (child < 0) continue;
        dir[0] = bindGlobals[child * 16 + 12] - bindGlobals[node * 16 + 12];
        dir[1] = bindGlobals[child * 16 + 13] - bindGlobals[node * 16 + 13];
        dir[2] = bindGlobals[child * 16 + 14] - bindGlobals[node * 16 + 14];
        const len = Math.hypot(dir[0], dir[1], dir[2]);
        if (len < 1e-6) continue; // degenerate rest bone — leave at bind
        dir[0] /= len;
        dir[1] /= len;
        dir[2] /= len;
      }
      const bone: RetargetBone = {
        node,
        palette,
        restDir: dir,
        from: chain.from,
        to: chain.to,
        damp: chain.damp ?? 1,
        hold: chain.hold ?? false,
        narrowX: chain.narrowX ?? 1,
      };
      // Pole (bend-plane) control: precompute the REST bend-plane normal from the
      // three model humanoid bones' bind positions, in model space.
      if (chain.pole && chain.poleModel) {
        const pa = resolveBone(chain.poleModel[0]);
        const pb = resolveBone(chain.poleModel[1]);
        const pc = resolveBone(chain.poleModel[2]);
        if (pa >= 0 && pb >= 0 && pc >= 0) {
          const g = bindGlobals;
          const e1x = g[pb * 16 + 12] - g[pa * 16 + 12];
          const e1y = g[pb * 16 + 13] - g[pa * 16 + 13];
          const e1z = g[pb * 16 + 14] - g[pa * 16 + 14];
          const e2x = g[pc * 16 + 12] - g[pb * 16 + 12];
          const e2y = g[pc * 16 + 13] - g[pb * 16 + 13];
          const e2z = g[pc * 16 + 14] - g[pb * 16 + 14];
          const nx = e1y * e2z - e1z * e2y;
          const ny = e1z * e2x - e1x * e2z;
          const nz = e1x * e2y - e1y * e2x;
          const nl = Math.hypot(nx, ny, nz);
          if (nl > 1e-5) {
            const s = (chain.poleSign ?? 1) / nl;
            bone.restN = new Float32Array([nx * s, ny * s, nz * s]);
            bone.poleSrc = chain.pole;
          }
        }
      }
      this.retargetBones.push(bone);
      this.retargetByNode[node] = bone;
    }

    // --- Foot/root placement setup. -----------------------------------------
    // The body (pelvis proxy) is TRANSLATED from our animation's pelvis so the
    // whole figure bounces on the beat, shifts its weight, and launches on a
    // jump — the aim retarget only rotates bones, so without this the body is
    // pinned at bind and the dance reads as arm-flailing over a static torso.
    //
    // Resolve through the VRM humanoid map (all shipped avatars) with a fallback
    // to the robot rig's node names. On the robot, Body + both feet are SIBLINGS
    // under the armature root and each is placed independently. On a VRM the feet
    // are DESCENDANTS of the hips, so we translate the hips only and let the
    // aimed leg bones carry the feet to their stepped spots (placeFeetSep=false).
    const palOfBone = (vrmName: string, robotName: string): number | undefined => {
      if (humanoid && humanoid[vrmName] !== undefined) {
        const p = paletteOfNode.get(humanoid[vrmName]);
        if (p !== undefined) return p;
      }
      return nameToPalette.get(robotName);
    };
    const bodyP = palOfBone('hips', 'Body');
    const footLP = palOfBone('leftFoot', 'Foot.L');
    const footRP = palOfBone('rightFoot', 'Foot.R');
    const ulP = palOfBone('leftUpperLeg', 'UpperLeg.L');
    const llP = palOfBone('leftLowerLeg', 'LowerLeg.L');
    if (
      bodyP !== undefined &&
      footLP !== undefined &&
      footRP !== undefined &&
      ulP !== undefined &&
      llP !== undefined
    ) {
      this.placeFeetSep = !humanoid; // robot: independent feet; VRM: body only
      this.placeBody = bodyP;
      this.placeBodyNode = joints[bodyP];
      this.placeFootL = footLP;
      this.placeFootLNode = joints[footLP];
      this.placeFootR = footRP;
      this.placeFootRNode = joints[footRP];
      const parentNode = model.nodes[this.placeBodyNode].parent;
      // Full inverse of the body's parent bind global (carries the VRM export
      // scale + pre-rotation); identity if the body is itself a scene root.
      if (parentNode >= 0) mat4Invert(this.invParentGlobal, 0, bindGlobals, parentNode * 16);
      else {
        this.invParentGlobal.fill(0);
        this.invParentGlobal[0] =
          this.invParentGlobal[5] =
          this.invParentGlobal[10] =
          this.invParentGlobal[15] =
            1;
      }
      // Our pelvis maps to the body bone's bind world position.
      this.pelvisAnchor[0] = bindGlobals[this.placeBodyNode * 16 + 12];
      this.pelvisAnchor[1] = bindGlobals[this.placeBodyNode * 16 + 13];
      this.pelvisAnchor[2] = bindGlobals[this.placeBodyNode * 16 + 14];
      // Model leg path length (hip→knee→ankle) for the our→model scale.
      const ulN = joints[ulP];
      const llN = joints[llP];
      const endN = this.placeFeetSep
        ? findDescendantByName(model, llN, 'LowerLeg.L_end')
        : this.placeFootLNode;
      const seg = (a: number, b: number): number =>
        Math.hypot(
          bindGlobals[a * 16 + 12] - bindGlobals[b * 16 + 12],
          bindGlobals[a * 16 + 13] - bindGlobals[b * 16 + 13],
          bindGlobals[a * 16 + 14] - bindGlobals[b * 16 + 14],
        );
      this.modelLegLen =
        seg(ulN, llN) + (endN >= 0 ? seg(llN, endN) : seg(llN, this.placeFootLNode));
      this.placeEnabled = this.modelLegLen > 1e-6;
    }

    this.applyFingerCurl(paletteOfNode);
  }

  /**
   * Bake a relaxed curl into the finger bones' bind locals (one-time, at load).
   * The retarget doesn't map fingers, so they keep their bind pose — which on a
   * VRoid avatar is ramrod-straight along the arm line, so a fully extended arm
   * tapers to a needle "spike" instead of reading as a hand. Flexing each
   * phalanx a little (tighter toward the tip) and opposing the thumbs turns the
   * bind hand into a natural loose half-fist from every angle.
   *
   * VRM 0.x/1.0 normalized rest pose: finger locals have identity rotation and
   * point along ±X (left = −X, right = +X) with palms facing −Y, so flexion is
   * a rotation about local Z (+ for the left hand, − for the right), and thumb
   * opposition is a rotation about local Y. Bones resolve through the VRM
   * humanoid map with a VRoid `J_Bip_*` node-name fallback; models without
   * finger bones (the robot) are a no-op. Writes both `bindPaletteLocals`
   * (what unmapped joints hold through every retarget) and `workingLocals`
   * (the pre-retarget pose).
   */
  private applyFingerCurl(paletteOfNode: Map<number, number>): void {
    const model = this.model;
    const rot = new Float32Array(16);
    const src = new Float32Array(16);
    const resolve = (vrmName: string, nodeName: string): number => {
      const h = model.humanoid?.[vrmName];
      if (h !== undefined && h >= 0 && h < model.nodes.length) return h;
      for (let i = 0; i < model.nodes.length; i++) {
        if (model.nodes[i].name === nodeName) return i;
      }
      return -1;
    };
    const applyLocalRot = (node: number): void => {
      // local' = local * R — rotate the bone in its own local frame.
      src.set(this.workingLocals.subarray(node * 16, node * 16 + 16));
      mat4Multiply(this.workingLocals, node * 16, src, 0, rot, 0);
      const p = paletteOfNode.get(node);
      if (p !== undefined) {
        src.set(this.bindPaletteLocals.subarray(p * 16, p * 16 + 16));
        mat4Multiply(this.bindPaletteLocals, p * 16, src, 0, rot, 0);
      }
    };
    const rotZ = (a: number): void => {
      rot.fill(0);
      const c = Math.cos(a);
      const s = Math.sin(a);
      rot[0] = c;
      rot[1] = s;
      rot[4] = -s;
      rot[5] = c;
      rot[10] = 1;
      rot[15] = 1;
    };
    const rotY = (a: number): void => {
      rot.fill(0);
      const c = Math.cos(a);
      const s = Math.sin(a);
      rot[0] = c;
      rot[2] = -s;
      rot[8] = s;
      rot[10] = c;
      rot[5] = 1;
      rot[15] = 1;
    };

    const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;
    const SEGS = ['Proximal', 'Intermediate', 'Distal'] as const;
    const CURL = [0.42, 0.6, 0.38]; // radians per phalanx, tighter toward the tip
    const THUMB = [0.32, 0.2, 0.12]; // gentler — the thumb folds toward the palm edge
    for (const side of ['left', 'right'] as const) {
      const sgn = side === 'left' ? 1 : -1;
      const jb = side === 'left' ? 'L' : 'R';
      for (const finger of FINGERS) {
        for (let k = 0; k < 3; k++) {
          const node = resolve(`${side}${finger}${SEGS[k]}`, `J_Bip_${jb}_${finger}${k + 1}`);
          if (node < 0) continue;
          rotZ(sgn * CURL[k]);
          applyLocalRot(node);
        }
      }
      for (let k = 0; k < 3; k++) {
        const node = resolve(`${side}Thumb${SEGS[k]}`, `J_Bip_${jb}_Thumb${k + 1}`);
        if (node < 0) continue;
        rotY(sgn * THUMB[k]);
        applyLocalRot(node);
      }
      // Enlarge the hand ~18%: VRoid hands are small and, at a fully extended
      // arm, taper the sleeve into a thin white "needle". A bigger hand reads as
      // a hand from a distance and terminates the arm line cleanly.
      const handNode = resolve(`${side}Hand`, `J_Bip_${jb}_Hand`);
      if (handNode >= 0) {
        rot.fill(0);
        rot[0] = rot[5] = rot[10] = 1.18;
        rot[15] = 1;
        applyLocalRot(handNode);
      }
    }
  }

  static async load(
    device: GPUDevice,
    format: GPUTextureFormat,
    url: string,
    recolorHair?: readonly [number, number, number],
    texCap = 0,
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

    const frameBuf = device.createBuffer({
      size: FRAME_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const paletteBuf = device.createBuffer({
      size: paletteLen * 16 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const drawBuf = device.createBuffer({
      size: Math.max(1, model.primitives.length) * DRAW_STRIDE,
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
    const group2Layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const pipeLayout = device.createPipelineLayout({
      bindGroupLayouts: [group0Layout, group1Layout, group2Layout],
    });
    const vertexBuffers: GPUVertexBufferLayout[] = [
      { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
      { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
      { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'uint16x4' }] },
      { arrayStride: 16, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] },
      { arrayStride: 8, attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x2' }] },
    ];
    // One pipeline per (blend, cull) combination, built lazily and cached.
    const pipeCache = new Map<string, GPURenderPipeline>();
    const getPipeline = (blend: boolean, cull: GPUCullMode, zWrite: boolean): GPURenderPipeline => {
      const key = `${blend ? 'b' : 'o'}-${cull}-${zWrite ? 'z' : ''}`;
      let p = pipeCache.get(key);
      if (!p) {
        p = device.createRenderPipeline({
          layout: pipeLayout,
          vertex: { module, entryPoint: 'vs', buffers: vertexBuffers },
          fragment: {
            module,
            entryPoint: 'fs',
            targets: [
              {
                format,
                blend: blend
                  ? {
                      // Standard "over" compositing. Color blends src over dst;
                      // alpha ACCUMULATES (src + dst·(1−src)) so a blend prim
                      // makes the offscreen opaque where it covers — otherwise a
                      // model whose materials are ALL alpha-blended (common in
                      // MMD-derived VRMs) leaves the whole silhouette at the
                      // clear alpha (0) and composites to nothing.
                      color: {
                        srcFactor: 'src-alpha',
                        dstFactor: 'one-minus-src-alpha',
                        operation: 'add',
                      },
                      alpha: {
                        srcFactor: 'one',
                        dstFactor: 'one-minus-src-alpha',
                        operation: 'add',
                      },
                    }
                  : undefined,
              },
            ],
          },
          primitive: { topology: 'triangle-list', cullMode: cull },
          // Opaque prims write depth. Blended prims normally only test it (drawn
          // after opaque), EXCEPT "transparent-with-ZWrite" ones (zWrite) — MMD/
          // MToon materials that are tagged BLEND but are really opaque with
          // anti-aliased edges. Those must write depth so their stacked face
          // layers (skin + brow + mouth) occlude instead of alpha-blending into
          // a muddy patch. See the isBlend/zWrite computation below.
          depthStencil: {
            format: 'depth24plus',
            depthWriteEnabled: !blend || zWrite,
            depthCompare: 'less',
          },
        });
        pipeCache.set(key, p);
      }
      return p;
    };

    // Decode embedded images → sRGB GPU textures; build per-glTF samplers.
    const { textures, defaultSampler, whiteTex } = await createTextures(device, model, texCap);
    const gpuSamplers = model.samplers.map((s) => device.createSampler(samplerDesc(s)));

    // Per-material base-color bind group (group 2). Untextured → 1×1 white.
    const whiteView = whiteTex.createView();
    const defaultBind = device.createBindGroup({
      layout: group2Layout,
      entries: [
        { binding: 0, resource: defaultSampler },
        { binding: 1, resource: whiteView },
      ],
    });
    const materialBind = model.materials.map((mat) => {
      const texIdx = mat.baseColorTexture;
      if (texIdx < 0 || texIdx >= model.textures.length) return defaultBind;
      const tex = model.textures[texIdx];
      const img = textures[tex.source];
      if (!img) return defaultBind;
      const samp =
        tex.sampler >= 0 && gpuSamplers[tex.sampler] ? gpuSamplers[tex.sampler] : defaultSampler;
      return device.createBindGroup({
        layout: group2Layout,
        entries: [
          { binding: 0, resource: samp },
          { binding: 1, resource: img.createView() },
        ],
      });
    });

    // GPU buffers + draw state per primitive.
    const prims: GpuPrimitive[] = model.primitives.map((p) => {
      const jointBase = p.skinIndex >= 0 ? skinJointOffsets[p.skinIndex] : 0;
      const mat = p.materialIndex >= 0 ? model.materials[p.materialIndex] : undefined;
      const useTexture = !!mat && mat.baseColorTexture >= 0;
      const isBlend = mat?.alphaMode === 'BLEND';
      // A BLEND material whose base-color alpha is fully opaque isn't really
      // translucent — it's "transparent-with-ZWrite" (MMD/MToon exports tag
      // opaque-but-anti-aliased surfaces this way). Let those write depth so
      // overlapping face layers occlude rather than blend into mush. A genuinely
      // translucent material (base alpha < 1) keeps depth-write off for correct
      // over-compositing.
      const zWrite = isBlend && p.baseColor[3] >= 1;
      const cull: GPUCullMode = mat?.doubleSided ? 'none' : 'back';
      return {
        posBuf: makeVertexBuffer(device, p.position),
        nrmBuf: makeVertexBuffer(device, p.normal),
        jntBuf: makeVertexBufferU16(device, p.joints),
        wgtBuf: makeVertexBuffer(device, p.weights),
        uvBuf: makeVertexBuffer(device, p.uv),
        idxBuf: makeIndexBuffer(device, p.indices),
        indexCount: p.indices.length,
        indexFormat: p.indices instanceof Uint32Array ? 'uint32' : 'uint16',
        nodeIndex: p.nodeIndex,
        skinIndex: p.skinIndex,
        jointBase,
        baseColor: p.baseColor,
        materialIndex: p.materialIndex,
        useTexture,
        isBlend,
        alphaCutoff: mat?.alphaMode === 'MASK' ? mat.alphaCutoff : 0,
        pipeline: getPipeline(isBlend, cull, zWrite),
        texBind: mat && p.materialIndex >= 0 ? materialBind[p.materialIndex] : defaultBind,
        recolor: false,
        faceKind: 0,
      };
    });
    // Classify FACE prims by material name so they can be spared the neon wash —
    // the eyes/face were crushed into the same rose hue as the body (a mannequin
    // with no readable eyes). VRM/MToon materials are reliably named. Eye
    // highlights go emissive (bright catchlights); face/skin get gentler tint.
    prims.forEach((gp, i) => {
      const name = model.materials[model.primitives[i].materialIndex]?.name ?? '';
      if (/highlight|eye_?extra|eyestar|catchlight/i.test(name)) gp.faceKind = 2;
      else if (/face|skin|eye|iris|mouth|brow|lash|eyeline|pupil|sclera/i.test(name))
        gp.faceKind = 1;
    });
    // Optional hair recolor (e.g. a teal "Miku" look): tint every HAIR-named
    // material to `recolorHair`, keeping the texture's luminance for shading.
    if (recolorHair) {
      prims.forEach((gp, i) => {
        const name = model.materials[model.primitives[i].materialIndex]?.name ?? '';
        if (/hair/i.test(name)) {
          gp.recolor = true;
          gp.baseColor = [recolorHair[0], recolorHair[1], recolorHair[2], gp.baseColor[3]];
        }
      });
    }
    // Draw opaque/masked prims first, then blended prims (back-to-front-ish).
    const opaqueOrder: number[] = [];
    const blendOrder: number[] = [];
    prims.forEach((p, i) => (p.isBlend ? blendOrder : opaqueOrder).push(i));

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
      group0,
      group1,
      sampler,
      skinJointOffsets,
      opaqueOrder,
      blendOrder,
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

  /**
   * Pose the model's bones to match our animation's world-space skeleton with an
   * aim-constraint (look-at) retarget, then setPose internally.
   *
   * `skel`: Float64Array of [x,y,z] per joint (our space: x=right, y=DOWN,
   * z=toward viewer, design px). `idx`: named-joint → index map (pelvis, chest,
   * neck, head, shoulder/elbow/hand L·R, hip/knee/foot L·R).
   *
   * For each mapped bone, parent-first: rotate its bind rest direction onto the
   * target direction (child−bone, mapped to model space), convert that world
   * rotation into a local rotation under the parent's already-retargeted global,
   * and bake a local matrix that keeps the bone's bind translation/scale.
   * Unmapped bones (fingers, poles, feet) keep their bind local. Allocation-free
   * and NaN-safe: degenerate directions fall back to the bind pose.
   */

  /** Map a source-space segment p→q into model space (axis signs + order). */
  private mapSeg(out: Float32Array, skel: Float64Array, p: number, q: number): void {
    const comp = this.vComp;
    comp[0] = (skel[q * 3] - skel[p * 3]) * X_SIGN;
    comp[1] = (skel[q * 3 + 1] - skel[p * 3 + 1]) * Y_SIGN;
    comp[2] = (skel[q * 3 + 2] - skel[p * 3 + 2]) * Z_SIGN;
    out[0] = comp[AXIS_ORDER[0]];
    out[1] = comp[AXIS_ORDER[1]];
    out[2] = comp[AXIS_ORDER[2]];
  }

  /** Rotate vec3 `v` by unit quat `qq` → `out` (t = 2·q.xyz×v; out = v + w·t + q.xyz×t). */
  private rotVec(out: Float32Array, qq: Float32Array, v: Float32Array): void {
    const x = qq[0],
      y = qq[1],
      z = qq[2],
      w = qq[3];
    const vx = v[0],
      vy = v[1],
      vz = v[2];
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);
    out[0] = vx + w * tx + (y * tz - z * ty);
    out[1] = vy + w * ty + (z * tx - x * tz);
    out[2] = vz + w * tz + (x * ty - y * tx);
  }

  /**
   * Spin the aim delta `q` about the aim axis `dir` so the bone's bend plane
   * matches the source animation's — a pole/twist constraint. Without it the
   * forearm roll is undetermined (minimal-arc), which flips the hand and rotates
   * the elbow's hinge plane on a skinned arm. `q` is modified in place; no-op if
   * the limb is near-straight (normal degenerates → fall back to plain aim).
   */
  private applyPoleRoll(
    q: Float32Array,
    dir: Float32Array,
    bone: RetargetBone,
    skel: Float64Array,
    idx: Record<string, number>,
  ): void {
    const ps = bone.poleSrc!;
    const ia = idx[ps[0]],
      ib = idx[ps[1]],
      ic = idx[ps[2]];
    if (ia === undefined || ib === undefined || ic === undefined) return;
    // Target bend-plane normal N = seg1 × seg2, in model space.
    const seg = this.vSeg,
      N = this.vN;
    this.mapSeg(seg, skel, ia, ib);
    const s1x = seg[0],
      s1y = seg[1],
      s1z = seg[2];
    const l1 = Math.hypot(s1x, s1y, s1z);
    this.mapSeg(seg, skel, ib, ic);
    const l2 = Math.hypot(seg[0], seg[1], seg[2]);
    N[0] = s1y * seg[2] - s1z * seg[1];
    N[1] = s1z * seg[0] - s1x * seg[2];
    N[2] = s1x * seg[1] - s1y * seg[0];
    const nRaw = Math.hypot(N[0], N[1], N[2]);
    // Fade the correction out as the arm straightens (|N|/(|seg1||seg2|) =
    // sin(elbow angle) → 0): the bend plane is undefined for a straight arm, so
    // easing to zero avoids a roll POP as it passes through near-straight.
    const bendSin = nRaw / (l1 * l2 + 1e-9);
    const t = (bendSin - 0.12) / (0.32 - 0.12);
    const w = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); // smoothstep
    if (w <= 0) return; // effectively straight → plain aim
    // Rest normal, carried through the aim delta so it sits in the aimed frame.
    const N1 = this.vN1;
    this.rotVec(N1, q, bone.restN!);
    // Project both normals ⟂ dir so the correcting spin is purely about the aim.
    const p1 = N1[0] * dir[0] + N1[1] * dir[1] + N1[2] * dir[2];
    N1[0] -= p1 * dir[0];
    N1[1] -= p1 * dir[1];
    N1[2] -= p1 * dir[2];
    const p2 = N[0] * dir[0] + N[1] * dir[1] + N[2] * dir[2];
    N[0] -= p2 * dir[0];
    N[1] -= p2 * dir[1];
    N[2] -= p2 * dir[2];
    const pl1 = Math.hypot(N1[0], N1[1], N1[2]),
      pl2 = Math.hypot(N[0], N[1], N[2]);
    if (pl1 < 1e-4 || pl2 < 1e-4) return;
    N1[0] /= pl1;
    N1[1] /= pl1;
    N1[2] /= pl1;
    N[0] /= pl2;
    N[1] /= pl2;
    N[2] /= pl2;
    quatFromTo(this.qC, 0, N1, N); // spin about dir aligning N1 → N
    if (w < 1) quatSlerpIdentity(this.qC, 0, this.qC, 0, w); // ease in with bend
    quatMul(q, 0, this.qC, 0, q, 0); // q = qRoll · q
  }

  retargetFromSkeleton(skel: Float64Array, idx: Record<string, number>): void {
    // Start from bind: unmapped palette joints stay at their rest local.
    this.retargetLocals.set(this.bindPaletteLocals);

    const model = this.model;
    const q = this.qA; // world rotation scratch
    const ql = this.qB; // local rotation scratch
    const dir = this.vDir;

    for (const node of model.hierarchyOrder) {
      const parent = model.nodes[node].parent;
      const parentOff = parent >= 0 ? parent * 4 : -1;
      const bone = this.retargetByNode[node];

      let mapped = false;
      if (bone && bone.hold) {
        // Hold the bind WORLD orientation: newWorld = bindGlobal, local =
        // inv(parentCurGlobal) * bindGlobal. Keeps the foot level regardless of
        // how the shin above it is aimed.
        q[0] = this.bindGlobalQuat[bone.node * 4];
        q[1] = this.bindGlobalQuat[bone.node * 4 + 1];
        q[2] = this.bindGlobalQuat[bone.node * 4 + 2];
        q[3] = this.bindGlobalQuat[bone.node * 4 + 3];
        if (parentOff >= 0) quatInvMul(ql, 0, this.curGlobalQuat, parentOff, q, 0);
        else {
          ql[0] = q[0];
          ql[1] = q[1];
          ql[2] = q[2];
          ql[3] = q[3];
        }
        this.curGlobalQuat[node * 4] = q[0];
        this.curGlobalQuat[node * 4 + 1] = q[1];
        this.curGlobalQuat[node * 4 + 2] = q[2];
        this.curGlobalQuat[node * 4 + 3] = q[3];
        composeTRSAt(
          this.retargetLocals,
          bone.palette * 16,
          this.bindLocalTrans,
          bone.node * 3,
          ql,
          0,
          this.bindLocalScale,
          bone.node * 3,
        );
        mapped = true;
      } else if (bone) {
        const fi = idx[bone.from];
        const ti = idx[bone.to];
        if (fi !== undefined && ti !== undefined) {
          // Target direction in model space (apply axis signs, then reorder).
          const comp = this.vComp;
          // narrowX <1 damps the sideways reach of the aim (legs): wide or
          // crossed animation steps pull toward the centerline for a natural
          // stance on the model's proportions.
          comp[0] = (skel[ti * 3] - skel[fi * 3]) * X_SIGN * bone.narrowX;
          comp[1] = (skel[ti * 3 + 1] - skel[fi * 3 + 1]) * Y_SIGN;
          comp[2] = (skel[ti * 3 + 2] - skel[fi * 3 + 2]) * Z_SIGN;
          dir[0] = comp[AXIS_ORDER[0]];
          dir[1] = comp[AXIS_ORDER[1]];
          dir[2] = comp[AXIS_ORDER[2]];
          const len = Math.hypot(dir[0], dir[1], dir[2]);
          if (len > 1e-6) {
            dir[0] /= len;
            dir[1] /= len;
            dir[2] /= len;
            // q = delta rotating restDir → target; damp short/noisy bones by
            // easing the delta toward identity, then apply on the bind global.
            quatFromTo(q, 0, bone.restDir, dir);
            // Pole roll: spin `q` about the aim so the limb's bend plane matches
            // the source, fixing forearm twist (the hand flipping / elbow-plane
            // error a bare aim leaves undetermined off an A-pose bind).
            if (bone.restN && bone.poleSrc) this.applyPoleRoll(q, dir, bone, skel, idx);
            if (bone.damp < 1) quatSlerpIdentity(q, 0, q, 0, bone.damp);
            quatMul(q, 0, q, 0, this.bindGlobalQuat, bone.node * 4); // newWorld
            // localRot = inverse(parentCurrentGlobal) * newWorld
            if (parentOff >= 0) {
              quatInvMul(ql, 0, this.curGlobalQuat, parentOff, q, 0);
            } else {
              ql[0] = q[0];
              ql[1] = q[1];
              ql[2] = q[2];
              ql[3] = q[3];
            }
            // curGlobal[node] = newWorld
            this.curGlobalQuat[node * 4] = q[0];
            this.curGlobalQuat[node * 4 + 1] = q[1];
            this.curGlobalQuat[node * 4 + 2] = q[2];
            this.curGlobalQuat[node * 4 + 3] = q[3];
            // Bake local matrix: bind T/S, retargeted R.
            composeTRSAt(
              this.retargetLocals,
              bone.palette * 16,
              this.bindLocalTrans,
              bone.node * 3,
              ql,
              0,
              this.bindLocalScale,
              bone.node * 3,
            );
            mapped = true;
          }
        }
      }

      if (!mapped) {
        // Keep bind local; propagate current global = parentGlobal * bindLocal.
        if (parentOff >= 0) {
          quatMul(
            this.curGlobalQuat,
            node * 4,
            this.curGlobalQuat,
            parentOff,
            this.bindLocalQuat,
            node * 4,
          );
        } else {
          this.curGlobalQuat[node * 4] = this.bindLocalQuat[node * 4];
          this.curGlobalQuat[node * 4 + 1] = this.bindLocalQuat[node * 4 + 1];
          this.curGlobalQuat[node * 4 + 2] = this.bindLocalQuat[node * 4 + 2];
          this.curGlobalQuat[node * 4 + 3] = this.bindLocalQuat[node * 4 + 3];
        }
      }
    }

    this.placeFeetAndRoot(skel, idx);
    this.setPose(this.retargetLocals);
  }

  /**
   * Step the feet and shift the body from our animation's foot/pelvis joints.
   * Because this rig IK-pins the feet to the armature root, aiming the leg bones
   * alone only splays the legs off planted feet — so instead we PLACE each Foot
   * bone (and the body/root) at our joint positions, mapped our-space→model-space
   * by a single scale locked on the first call (model leg length ÷ our leg
   * length). The leg bones are still aimed (above), so the shin points at the
   * stepped foot. Foot-lock is inherited: a foot our animation holds still maps
   * to a still position, so it neither slides nor jitters. NaN-safe: skips
   * entirely if placement data or joints are missing/degenerate.
   */
  private placeFeetAndRoot(skel: Float64Array, idx: Record<string, number>): void {
    if (!this.placeEnabled) return;
    const pi = idx.pelvis;
    const fl = idx.footL;
    const fr = idx.footR;
    const hl = idx.hipL;
    const kl = idx.kneeL;
    if (
      pi === undefined ||
      fl === undefined ||
      fr === undefined ||
      hl === undefined ||
      kl === undefined
    )
      return;

    if (!this.haveAnchor) {
      // Lock the our→model scale from the (constant) leg-segment path length.
      const ourLeg = dist3(skel, hl, kl) + dist3(skel, kl, fl);
      this.posScale = ourLeg > 1e-4 ? (this.modelLegLen / ourLeg) * POS_SCALE : POS_SCALE;
      this.pelvis0[0] = skel[pi * 3];
      this.pelvis0[1] = skel[pi * 3 + 1];
      this.pelvis0[2] = skel[pi * 3 + 2];
      this.haveAnchor = true;
    }
    const s = this.posScale;
    if (!(s > 0)) return;

    this.placeNodeAt(this.placeBody, this.placeBodyNode, skel, pi, s);
    if (this.placeFeetSep) {
      // Robot rig: feet are siblings of the body — pin each one independently.
      this.placeNodeAt(this.placeFootL, this.placeFootLNode, skel, fl, s);
      this.placeNodeAt(this.placeFootR, this.placeFootRNode, skel, fr, s);
    }
  }

  /**
   * Position one placed bone: our joint `ji` maps to a model-world point in the
   * pelvis-anchored frame, converted into the bone's parent (armature-root)
   * local space; rotation/scale stay at bind. Writes the palette-order local.
   */
  private placeNodeAt(
    palette: number,
    node: number,
    skel: Float64Array,
    ji: number,
    s: number,
  ): void {
    // World target: anchor + scale * axisMap(joint − pelvis0).
    const cx = (skel[ji * 3] - this.pelvis0[0]) * X_SIGN;
    const cy = (skel[ji * 3 + 1] - this.pelvis0[1]) * Y_SIGN;
    const cz = (skel[ji * 3 + 2] - this.pelvis0[2]) * Z_SIGN;
    this.vComp[0] = cx;
    this.vComp[1] = cy;
    this.vComp[2] = cz;
    const w = this.vWorld;
    w[0] = this.pelvisAnchor[0] + s * this.vComp[AXIS_ORDER[0]];
    w[1] = this.pelvisAnchor[1] + s * this.vComp[AXIS_ORDER[1]];
    w[2] = this.pelvisAnchor[2] + s * this.vComp[AXIS_ORDER[2]];
    // Local translation under the parent = inv(parentGlobal) * worldPoint
    // (full inverse handles the armature-root scale + rotation).
    transformPoint(this.vLocal, this.invParentGlobal, 0, w[0], w[1], w[2]);
    composeTRSAt(
      this.retargetLocals,
      palette * 16,
      this.vLocal,
      0,
      this.bindLocalQuat,
      node * 4,
      this.bindLocalScale,
      node * 3,
    );
  }

  /** Override the color tint (multiplies base colors). Default white. */
  setTint(r: number, g: number, b: number, a = 1): void {
    this.tint = [r, g, b, a];
  }

  /** Number of glTF materials (for `setMaterialColors`). */
  get materialCount(): number {
    return this.nMaterials;
  }

  /**
   * Override per-material base colors (keyed by glTF material index) to recolor
   * the model to a scene palette. `colors[i]` = `[r,g,b]` in 0..1 replaces
   * material i's base color; pass `null`/`undefined` for a slot to leave it at
   * the model's original color. Alpha and `setTint` still apply on top. Takes
   * effect on the next `render()`.
   *
   * Material order for RobotExpressive: 0 = Grey (trim), 1 = Main (body),
   * 2 = Black (dark).
   */
  setMaterialColors(
    colors: readonly (readonly [number, number, number] | null | undefined)[],
  ): void {
    for (let i = 0; i < this.nMaterials; i++) {
      const c = colors[i];
      if (c) {
        this.matColor[i * 3] = c[0];
        this.matColor[i * 3 + 1] = c[1];
        this.matColor[i * 3 + 2] = c[2];
        this.matColorHas[i] = 1;
      } else if (c === null) {
        this.matColorHas[i] = 0;
      }
    }
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
      const mi = p.materialIndex;
      if (mi >= 0 && this.matColorHas[mi]) {
        this.drawData[o + 16] = this.matColor[mi * 3];
        this.drawData[o + 17] = this.matColor[mi * 3 + 1];
        this.drawData[o + 18] = this.matColor[mi * 3 + 2];
      } else {
        this.drawData[o + 16] = p.baseColor[0];
        this.drawData[o + 17] = p.baseColor[1];
        this.drawData[o + 18] = p.baseColor[2];
      }
      this.drawData[o + 19] = p.baseColor[3];
      this.drawDataU32[o + 20] = p.jointBase;
      this.drawDataU32[o + 21] = p.skinIndex >= 0 ? 1 : 0;
      this.drawDataU32[o + 22] =
        (p.useTexture ? 1 : 0) |
        (p.isBlend ? 2 : 0) |
        (p.recolor ? 4 : 0) |
        (p.faceKind === 1 ? 8 : 0) |
        (p.faceKind === 2 ? 16 : 0);
      this.drawData[o + 23] = p.alphaCutoff; // f32 alpha cutoff
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
    pass.setBindGroup(0, this.group0);
    // Opaque + masked first (depth write), then blended (depth test only).
    this.curPipeline = null;
    for (let k = 0; k < this.opaqueOrder.length; k++) this.drawPrim(pass, this.opaqueOrder[k]);
    for (let k = 0; k < this.blendOrder.length; k++) this.drawPrim(pass, this.blendOrder[k]);
    pass.end();
  }

  private curPipeline: GPURenderPipeline | null = null;

  /** Issue one primitive draw, switching pipeline/bind groups only as needed. */
  private drawPrim(pass: GPURenderPassEncoder, i: number): void {
    const p = this.prims[i];
    if (p.pipeline !== this.curPipeline) {
      pass.setPipeline(p.pipeline);
      this.curPipeline = p.pipeline;
    }
    pass.setBindGroup(1, this.group1, this.dynOffset(i));
    pass.setBindGroup(2, p.texBind);
    pass.setVertexBuffer(0, p.posBuf);
    pass.setVertexBuffer(1, p.nrmBuf);
    pass.setVertexBuffer(2, p.jntBuf);
    pass.setVertexBuffer(3, p.wgtBuf);
    pass.setVertexBuffer(4, p.uvBuf);
    pass.setIndexBuffer(p.idxBuf, p.indexFormat);
    pass.drawIndexed(p.indexCount);
  }

  /** Reused single-element dynamic-offset array (no per-draw allocation). */
  private readonly dynScratch: [number] = [0];
  private dynOffset(i: number): [number] {
    this.dynScratch[0] = i * DRAW_STRIDE;
    return this.dynScratch;
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
// Model-topology helpers. (Quaternion / matrix / skinning math lives in
// ./skinnedMath; the retarget rig tables in ./retargetRig.)
// ---------------------------------------------------------------------------

/** Find the first descendant of `root` (searching its subtree) named `name`. */
function findDescendantByName(model: GltfModel, root: number, name: string): number {
  const stack = [...model.nodes[root].children];
  while (stack.length) {
    const n = stack.pop()!;
    if (model.nodes[n].name === name) return n;
    for (const c of model.nodes[n].children) stack.push(c);
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Texture helpers.
// ---------------------------------------------------------------------------

function samplerDesc(s: GltfSampler): GPUSamplerDescriptor {
  return {
    magFilter: s.magLinear ? 'linear' : 'nearest',
    minFilter: s.minLinear ? 'linear' : 'nearest',
    mipmapFilter: 'linear',
    addressModeU: s.wrapU,
    addressModeV: s.wrapV,
  };
}

/**
 * Decode each embedded glTF image into an sRGB GPU texture (so sampling returns
 * linear color). Also builds a 1×1 white fallback texture + a default sampler.
 * NaN/decode-safe: an image that fails to decode becomes `null` and its
 * material falls back to the white texture (flat factor color).
 */
async function createTextures(
  device: GPUDevice,
  model: GltfModel,
  texCap = 0, // >0 caps the longest texture edge (retro/PS2 low-res look)
): Promise<{ textures: (GPUTexture | null)[]; defaultSampler: GPUSampler; whiteTex: GPUTexture }> {
  const defaultSampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });
  const usage =
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
  const whiteTex = device.createTexture({ size: [1, 1], format: 'rgba8unorm-srgb', usage });
  device.queue.writeTexture(
    { texture: whiteTex },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4 },
    { width: 1, height: 1 },
  );
  const textures = await Promise.all(
    model.images.map(async (img): Promise<GPUTexture | null> => {
      if (!img.bytes.length) return null;
      try {
        const blob = new Blob([img.bytes], { type: img.mimeType || 'image/png' });
        let bmp = await createImageBitmap(blob);
        // Downscale to the retro cap (bilinear) — kills the texture aliasing on
        // decimated low-poly UVs and reads as an authentic low-res PS2 texture.
        if (texCap > 0 && Math.max(bmp.width, bmp.height) > texCap) {
          const s = texCap / Math.max(bmp.width, bmp.height);
          const rw = Math.max(1, Math.round(bmp.width * s));
          const rh = Math.max(1, Math.round(bmp.height * s));
          bmp.close();
          bmp = await createImageBitmap(blob, { resizeWidth: rw, resizeHeight: rh });
        }
        const w = Math.max(1, bmp.width);
        const h = Math.max(1, bmp.height);
        const tex = device.createTexture({ size: [w, h], format: 'rgba8unorm-srgb', usage });
        device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [w, h]);
        bmp.close();
        return tex;
      } catch {
        return null;
      }
    }),
  );
  return { textures, defaultSampler, whiteTex };
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
