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
  mat4Identity,
  type GltfModel,
  type GltfPrimitive,
  type GltfSampler,
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

// ---------------------------------------------------------------------------
// Retargeting axis convention.
//
// Our animation solves world-space joints in screen space: x = right, y = DOWN,
// z = toward the viewer, units = design px. glTF is y-UP, so we flip Y by
// default. These are exposed as tunables: flip a sign or reorder AXIS_ORDER to
// correct handedness/orientation during visual tuning without touching logic.
// A direction (child - bone) becomes model space as:
//   c = [dx*X_SIGN, dy*Y_SIGN, dz*Z_SIGN];  dirModel = [c[AXIS_ORDER[i]]]
// ---------------------------------------------------------------------------
const X_SIGN = 1;
const Y_SIGN = -1; // our y points down; glTF y points up
const Z_SIGN = 1;
const AXIS_ORDER: readonly [number, number, number] = [0, 1, 2];
/**
 * Extra multiplier on the our→model position scale (which is otherwise derived
 * from leg length). Nudge >1 to widen/enlarge the stance, <1 to shrink it,
 * during visual tuning. Only affects foot/root PLACEMENT, not bone aiming.
 */
const POS_SCALE = 1;

/**
 * Model bone -> our skeleton chain segment. `restChild` is a descendant node
 * of `bone` whose bind position defines the bone's rest aim direction; `from`
 * and `to` are our named joints whose vector is the target aim direction. Two
 * model bones can share one segment (clavicle + upper arm, hips + lower spine).
 * `damp` (0..1) scales the aim rotation toward the rest pose — used to steady
 * short, noisy bones like the neck (a small position wiggle = a big angle).
 */
interface BoneChain {
  bone: string;
  restChild: string;
  from: string;
  to: string;
  damp?: number;
  /** Hold the bone's bind WORLD orientation instead of aiming — the foot stays
   *  level (sole down) rather than inheriting the shin's tilt and pointing its
   *  toe at the floor. `from`/`to`/`restChild` are ignored when set. */
  hold?: boolean;
}
const BONE_CHAINS: readonly BoneChain[] = [
  // One aiming bone per segment (see VRM_CHAINS): never two in-series bones at
  // the same target, which compounds rotations and stretches/crosses the limb.
  // Hips and the clavicles stay at bind and inherit their parent's rotation.
  { bone: 'Abdomen', restChild: 'Torso', from: 'pelvis', to: 'chest' },
  { bone: 'Torso', restChild: 'Neck', from: 'chest', to: 'neck' },
  // Neck follows the head but damped; the Head bone stays rigid to the neck so
  // the head reads upright instead of cocking on the tiny neck→head segment.
  { bone: 'Neck', restChild: 'Head', from: 'neck', to: 'head', damp: 0.5 },
  { bone: 'UpperArm.L', restChild: 'LowerArm.L', from: 'shoulderL', to: 'elbowL' },
  { bone: 'LowerArm.L', restChild: 'Palm2.L', from: 'elbowL', to: 'handL' },
  { bone: 'UpperArm.R', restChild: 'LowerArm.R', from: 'shoulderR', to: 'elbowR' },
  { bone: 'LowerArm.R', restChild: 'Palm2.R', from: 'elbowR', to: 'handR' },
  { bone: 'UpperLeg.L', restChild: 'LowerLeg.L', from: 'hipL', to: 'kneeL' },
  { bone: 'LowerLeg.L', restChild: 'LowerLeg.L_end', from: 'kneeL', to: 'footL' },
  { bone: 'Foot.L', restChild: 'Foot.L', from: 'footL', to: 'footL', hold: true },
  { bone: 'UpperLeg.R', restChild: 'LowerLeg.R', from: 'hipR', to: 'kneeR' },
  { bone: 'LowerLeg.R', restChild: 'LowerLeg.R_end', from: 'kneeR', to: 'footR' },
  { bone: 'Foot.R', restChild: 'Foot.R', from: 'footR', to: 'footR', hold: true },
];

/**
 * Same chains keyed by VRM humanoid bone names. When a model exposes a VRM
 * humanoid map, bones/restChildren resolve through it (robust across VRoid
 * avatars) instead of the robot's node names. VRM feet are in the leg chain
 * (not IK-pinned), so aiming lowerLeg→foot already steps them.
 */
const VRM_CHAINS: readonly BoneChain[] = [
  // One bone per body segment — never two in-series bones aimed at the SAME
  // target. Aiming, say, both the clavicle and the upper arm at the elbow
  // COMPOUNDS their rotations (the clavicle swings out, then the arm swings
  // again from there), which displaces and visually stretches the limb at the
  // joint. So the clavicles (shoulder) and upperChest stay at bind and simply
  // inherit their parent's rotation; the real segment bone does the aiming.
  { bone: 'spine', restChild: 'chest', from: 'pelvis', to: 'chest' },
  { bone: 'chest', restChild: 'neck', from: 'chest', to: 'neck' },
  { bone: 'neck', restChild: 'head', from: 'neck', to: 'head', damp: 0.5 },
  { bone: 'leftUpperArm', restChild: 'leftLowerArm', from: 'shoulderL', to: 'elbowL' },
  { bone: 'leftLowerArm', restChild: 'leftHand', from: 'elbowL', to: 'handL' },
  { bone: 'rightUpperArm', restChild: 'rightLowerArm', from: 'shoulderR', to: 'elbowR' },
  { bone: 'rightLowerArm', restChild: 'rightHand', from: 'elbowR', to: 'handR' },
  { bone: 'leftUpperLeg', restChild: 'leftLowerLeg', from: 'hipL', to: 'kneeL' },
  { bone: 'leftLowerLeg', restChild: 'leftFoot', from: 'kneeL', to: 'footL' },
  { bone: 'leftFoot', restChild: 'leftFoot', from: 'footL', to: 'footL', hold: true },
  { bone: 'rightUpperLeg', restChild: 'rightLowerLeg', from: 'hipR', to: 'kneeR' },
  { bone: 'rightLowerLeg', restChild: 'rightFoot', from: 'kneeR', to: 'footR' },
  { bone: 'rightFoot', restChild: 'rightFoot', from: 'footR', to: 'footR', hold: true },
];

/** A resolved retarget bone: node + palette slot + precomputed rest aim dir. */
interface RetargetBone {
  node: number;
  palette: number;
  restDir: Float32Array<ArrayBuffer>; // unit, native model space (from bind globals)
  from: string;
  to: string;
  damp: number; // 1 = full aim, <1 steadies toward rest
  hold: boolean; // hold bind world orientation (level foot) instead of aiming
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

  // Albedo: sampled texture × factor (textured), or the flat material color.
  // The base-color texture is created sRGB so the sample is already linear.
  var albedo : vec3f;
  var alpha : f32;
  if (useTex) {
    let texel = textureSample(baseTex, baseSampler, uv);
    albedo = texel.rgb * draw.baseColor.rgb;
    alpha = texel.a * draw.baseColor.a;
  } else {
    albedo = draw.baseColor.rgb;
    alpha = draw.baseColor.a;
  }
  if (alpha < draw.alphaCutoff) { discard; } // MASK cutout

  let n = normalize(nrm);
  let l = normalize(frame.lightDir.xyz);
  let viewDir = normalize(frame.camPos.xyz - wpos);
  // Toon shade: quantize the diffuse into a couple of soft bands so the model
  // reads as a stylized cel character (PS2-DDR dancer), not a flat/murky mesh.
  // The bands are lifted (0.72..1.05) so nothing sinks into a dead grey.
  let ndl = dot(n, l) * 0.5 + 0.5; // half-lambert — softer wrap, no black side
  let band = smoothstep(0.34, 0.5, ndl) * 0.18 + smoothstep(0.55, 0.72, ndl) * 0.15;
  let shade = 0.72 + band; // 0.72 (shadow) → ~1.05 (lit)
  // Neon rim — cyan→magenta by facing — so the silhouette pops off the tunnel
  // and the skin never looks pale/ghostly. Additive, view-based Fresnel.
  let fres = pow(1.0 - max(dot(n, viewDir), 0.0), 2.4);
  let rimCol = mix(vec3f(0.15, 0.55, 1.0), vec3f(1.0, 0.25, 0.75), n.x * 0.5 + 0.5);
  let rim = rimCol * fres * 0.6;
  var lit = albedo * frame.tint.rgb * shade + rim;
  // Re-encode to sRGB for textured prims (linear lighting → sRGB store);
  // flat-color prims keep the renderer's original non-linear passthrough.
  if (useTex) { lit = pow(max(lit, vec3f(0.0)), vec3f(1.0 / 2.2)); }

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
  private readonly vDir = new Float32Array(3);
  private readonly vComp = new Float32Array(3);
  private readonly vWorld = new Float32Array(3);
  private readonly vLocal = new Float32Array(3);

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
      };
      this.retargetBones.push(bone);
      this.retargetByNode[node] = bone;
    }

    // --- Foot/root placement setup. -----------------------------------------
    // Body (pelvis proxy) and both Foot bones share the same parent (the
    // armature root "Bone"); place them in that parent's frame. Feet meshes are
    // children of the Foot bones, so moving a Foot bone steps its foot.
    const bodyP = nameToPalette.get('Body');
    const footLP = nameToPalette.get('Foot.L');
    const footRP = nameToPalette.get('Foot.R');
    const ulP = nameToPalette.get('UpperLeg.L');
    const llP = nameToPalette.get('LowerLeg.L');
    if (
      bodyP !== undefined &&
      footLP !== undefined &&
      footRP !== undefined &&
      ulP !== undefined &&
      llP !== undefined
    ) {
      this.placeBody = bodyP;
      this.placeBodyNode = joints[bodyP];
      this.placeFootL = footLP;
      this.placeFootLNode = joints[footLP];
      this.placeFootR = footRP;
      this.placeFootRNode = joints[footRP];
      const parentNode = model.nodes[this.placeBodyNode].parent;
      if (parentNode >= 0) {
        // Full inverse of the parent (armature-root) bind global — it carries a
        // large export scale + a 90° rotation, so a world→local conversion needs
        // the whole matrix, not just the rotation.
        mat4Invert(this.invParentGlobal, 0, bindGlobals, parentNode * 16);
        // Our pelvis maps to Body's bind world position.
        this.pelvisAnchor[0] = bindGlobals[this.placeBodyNode * 16 + 12];
        this.pelvisAnchor[1] = bindGlobals[this.placeBodyNode * 16 + 13];
        this.pelvisAnchor[2] = bindGlobals[this.placeBodyNode * 16 + 14];
        // Model leg path length (hip→knee→ankle) for the our→model scale.
        const ulN = joints[ulP];
        const llN = joints[llP];
        const endN = findDescendantByName(model, llN, 'LowerLeg.L_end');
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
    }
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
    const getPipeline = (blend: boolean, cull: GPUCullMode): GPURenderPipeline => {
      const key = `${blend ? 'b' : 'o'}-${cull}`;
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
                      // Blend color over what's there; keep destination alpha so
                      // the composited silhouette stays opaque.
                      color: {
                        srcFactor: 'src-alpha',
                        dstFactor: 'one-minus-src-alpha',
                        operation: 'add',
                      },
                      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
                    }
                  : undefined,
              },
            ],
          },
          primitive: { topology: 'triangle-list', cullMode: cull },
          // Blended prims test depth but don't write it (drawn after opaque).
          depthStencil: { format: 'depth24plus', depthWriteEnabled: !blend, depthCompare: 'less' },
        });
        pipeCache.set(key, p);
      }
      return p;
    };

    // Decode embedded images → sRGB GPU textures; build per-glTF samplers.
    const { textures, defaultSampler, whiteTex } = await createTextures(device, model);
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
        pipeline: getPipeline(isBlend, cull),
        texBind: mat && p.materialIndex >= 0 ? materialBind[p.materialIndex] : defaultBind,
      };
    });
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
          comp[0] = (skel[ti * 3] - skel[fi * 3]) * X_SIGN;
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
    this.placeNodeAt(this.placeFootL, this.placeFootLNode, skel, fl, s);
    this.placeNodeAt(this.placeFootR, this.placeFootRNode, skel, fr, s);
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
      this.drawDataU32[o + 22] = (p.useTexture ? 1 : 0) | (p.isBlend ? 2 : 0);
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
// Retarget math: quaternions (allocation-free, offset-addressed) + helpers.
// Quaternions are [x, y, z, w]; matrices are column-major.
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

/** Extract a unit rotation quaternion from a column-major matrix's 3x3 (scale-removed). */
function quatFromMat(out: Float32Array, oo: number, m: Float32Array, mo: number): void {
  const sx = Math.hypot(m[mo], m[mo + 1], m[mo + 2]) || 1;
  const sy = Math.hypot(m[mo + 4], m[mo + 5], m[mo + 6]) || 1;
  const sz = Math.hypot(m[mo + 8], m[mo + 9], m[mo + 10]) || 1;
  const m00 = m[mo] / sx,
    m01 = m[mo + 1] / sx,
    m02 = m[mo + 2] / sx;
  const m10 = m[mo + 4] / sy,
    m11 = m[mo + 5] / sy,
    m12 = m[mo + 6] / sy;
  const m20 = m[mo + 8] / sz,
    m21 = m[mo + 9] / sz,
    m22 = m[mo + 10] / sz;
  // m[col*4+row]: m00=col0row0, m10=col1row0, ... trace uses diagonal m00,m11,m22.
  const trace = m00 + m11 + m22;
  let x, y, z, w;
  if (trace > 0) {
    let s = Math.sqrt(trace + 1) * 2; // s = 4w
    w = 0.25 * s;
    x = (m12 - m21) / s;
    y = (m20 - m02) / s;
    z = (m01 - m10) / s;
  } else if (m00 > m11 && m00 > m22) {
    let s = Math.sqrt(1 + m00 - m11 - m22) * 2; // s = 4x
    w = (m12 - m21) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m20 + m02) / s;
  } else if (m11 > m22) {
    let s = Math.sqrt(1 + m11 - m00 - m22) * 2; // s = 4y
    w = (m20 - m02) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    let s = Math.sqrt(1 + m22 - m00 - m11) * 2; // s = 4z
    w = (m01 - m10) / s;
    x = (m20 + m02) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const inv = 1 / (Math.hypot(x, y, z, w) || 1);
  out[oo] = x * inv;
  out[oo + 1] = y * inv;
  out[oo + 2] = z * inv;
  out[oo + 3] = w * inv;
}

/** out = a * b (Hamilton product). Aliasing out with a/b is safe (locals used). */
function quatMul(
  out: Float32Array,
  oo: number,
  a: Float32Array,
  ao: number,
  b: Float32Array,
  bo: number,
): void {
  const ax = a[ao],
    ay = a[ao + 1],
    az = a[ao + 2],
    aw = a[ao + 3];
  const bx = b[bo],
    by = b[bo + 1],
    bz = b[bo + 2],
    bw = b[bo + 3];
  out[oo] = aw * bx + ax * bw + ay * bz - az * by;
  out[oo + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[oo + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** out = inverse(a) * b, for unit a (inverse = conjugate). */
function quatInvMul(
  out: Float32Array,
  oo: number,
  a: Float32Array,
  ao: number,
  b: Float32Array,
  bo: number,
): void {
  const ax = -a[ao],
    ay = -a[ao + 1],
    az = -a[ao + 2],
    aw = a[ao + 3];
  const bx = b[bo],
    by = b[bo + 1],
    bz = b[bo + 2],
    bw = b[bo + 3];
  out[oo] = aw * bx + ax * bw + ay * bz - az * by;
  out[oo + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[oo + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/**
 * out = unit quaternion rotating unit vector `a` onto unit vector `b`
 * (shortest arc). NaN-safe: handles parallel (identity) and antiparallel
 * (180° about an arbitrary perpendicular axis).
 */
function quatFromTo(out: Float32Array, oo: number, a: Float32Array, b: Float32Array): void {
  const ax = a[0],
    ay = a[1],
    az = a[2];
  const bx = b[0],
    by = b[1],
    bz = b[2];
  const d = ax * bx + ay * by + az * bz;
  if (d >= 1 - 1e-6) {
    out[oo] = 0;
    out[oo + 1] = 0;
    out[oo + 2] = 0;
    out[oo + 3] = 1;
    return;
  }
  if (d <= -1 + 1e-6) {
    // Antiparallel: rotate 180° about any axis perpendicular to `a`.
    let px = ay * 1 - az * 0,
      py = az * 0 - ax * 1,
      pz = ax * 0 - ay * 0; // a × X
    if (px * px + py * py + pz * pz < 1e-8) {
      px = ay * 0 - az * 1; // a × Y
      py = az * 0 - ax * 0;
      pz = ax * 1 - ay * 0;
    }
    const pl = Math.hypot(px, py, pz) || 1;
    out[oo] = px / pl;
    out[oo + 1] = py / pl;
    out[oo + 2] = pz / pl;
    out[oo + 3] = 0;
    return;
  }
  // General case: axis = a × b, w = 1 + dot, then normalize.
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const w = 1 + d;
  const inv = 1 / (Math.hypot(cx, cy, cz, w) || 1);
  out[oo] = cx * inv;
  out[oo + 1] = cy * inv;
  out[oo + 2] = cz * inv;
  out[oo + 3] = w * inv;
}

/**
 * out = slerp(identity, q, t) for unit q — eases a rotation toward no-op.
 * NaN-safe: falls back to nlerp for near-parallel quaternions.
 */
function quatSlerpIdentity(
  out: Float32Array,
  oo: number,
  q: Float32Array,
  qo: number,
  t: number,
): void {
  let x = q[qo],
    y = q[qo + 1],
    z = q[qo + 2],
    w = q[qo + 3];
  if (w < 0) {
    // shortest arc: identity·q = w, negate for w<0
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  if (w > 0.9995) {
    // Near identity: linear blend then normalize.
    const bx = t * x,
      by = t * y,
      bz = t * z,
      bw = 1 - t + t * w;
    const inv = 1 / (Math.hypot(bx, by, bz, bw) || 1);
    out[oo] = bx * inv;
    out[oo + 1] = by * inv;
    out[oo + 2] = bz * inv;
    out[oo + 3] = bw * inv;
    return;
  }
  const omega = Math.acos(w);
  const sin = Math.sin(omega);
  const s0 = Math.sin((1 - t) * omega) / sin;
  const s1 = Math.sin(t * omega) / sin;
  out[oo] = s1 * x;
  out[oo + 1] = s1 * y;
  out[oo + 2] = s1 * z;
  out[oo + 3] = s0 + s1 * w;
}

/**
 * out[oo..oo+16] = inverse of the column-major 4x4 at m[mo..]. Returns whether
 * it was invertible; on a singular matrix writes identity (NaN-safe).
 */
function mat4Invert(out: Float32Array, oo: number, m: Float32Array, mo: number): boolean {
  const a00 = m[mo],
    a01 = m[mo + 1],
    a02 = m[mo + 2],
    a03 = m[mo + 3];
  const a10 = m[mo + 4],
    a11 = m[mo + 5],
    a12 = m[mo + 6],
    a13 = m[mo + 7];
  const a20 = m[mo + 8],
    a21 = m[mo + 9],
    a22 = m[mo + 10],
    a23 = m[mo + 11];
  const a30 = m[mo + 12],
    a31 = m[mo + 13],
    a32 = m[mo + 14],
    a33 = m[mo + 15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) {
    mat4Identity(out, oo);
    return false;
  }
  det = 1 / det;
  out[oo] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[oo + 1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[oo + 2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[oo + 3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[oo + 4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[oo + 5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[oo + 6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[oo + 7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[oo + 8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[oo + 9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[oo + 10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[oo + 11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[oo + 12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[oo + 13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[oo + 14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[oo + 15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return true;
}

/** Euclidean distance between joints a and b in a flat [x,y,z] skeleton array. */
function dist3(skel: Float64Array, a: number, b: number): number {
  return Math.hypot(
    skel[a * 3] - skel[b * 3],
    skel[a * 3 + 1] - skel[b * 3 + 1],
    skel[a * 3 + 2] - skel[b * 3 + 2],
  );
}

/** Compose a column-major TRS matrix into `out[oo..]` from offset-addressed T, quat R, S. */
function composeTRSAt(
  out: Float32Array,
  oo: number,
  t: Float32Array,
  to: number,
  q: Float32Array,
  qo: number,
  s: Float32Array,
  so: number,
): void {
  const x = q[qo],
    y = q[qo + 1],
    z = q[qo + 2],
    w = q[qo + 3];
  const x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  const xx = x * x2,
    xy = x * y2,
    xz = x * z2;
  const yy = y * y2,
    yz = y * z2,
    zz = z * z2;
  const wx = w * x2,
    wy = w * y2,
    wz = w * z2;
  const sx = s[so],
    sy = s[so + 1],
    sz = s[so + 2];
  out[oo] = (1 - (yy + zz)) * sx;
  out[oo + 1] = (xy + wz) * sx;
  out[oo + 2] = (xz - wy) * sx;
  out[oo + 3] = 0;
  out[oo + 4] = (xy - wz) * sy;
  out[oo + 5] = (1 - (xx + zz)) * sy;
  out[oo + 6] = (yz + wx) * sy;
  out[oo + 7] = 0;
  out[oo + 8] = (xz + wy) * sz;
  out[oo + 9] = (yz - wx) * sz;
  out[oo + 10] = (1 - (xx + yy)) * sz;
  out[oo + 11] = 0;
  out[oo + 12] = t[to];
  out[oo + 13] = t[to + 1];
  out[oo + 14] = t[to + 2];
  out[oo + 15] = 1;
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
        const bmp = await createImageBitmap(
          new Blob([img.bytes], { type: img.mimeType || 'image/png' }),
        );
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
