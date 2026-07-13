/**
 * Minimal glTF-Binary (.glb) parser — just enough to load and draw
 * `RobotExpressive.glb` (and models shaped like it) with no external deps.
 *
 * The robot rigs in two ways at once: most body parts are *rigid* meshes
 * parented to bone nodes (they move because their node moves in the
 * hierarchy), and only the two hands are true *skinned* meshes with
 * JOINTS_0/WEIGHTS_0. This parser exposes both: every drawable primitive
 * records the node it hangs off (`nodeIndex`) and, when skinned, which skin
 * (`skinIndex`). The renderer walks the node hierarchy to get global matrices
 * and, per skin, builds the joint palette `global[joint] * inverseBind`.
 *
 * We read accessors/bufferViews by hand (component types + normalization),
 * handling only what this model needs: tightly-packed (non-interleaved)
 * accessors, TRS nodes, u16 indices, POSITION/NORMAL f32x3, JOINTS_0 u8/u16x4,
 * WEIGHTS_0 f32x4. Column-major matrices throughout (matches WGSL mat4x4f).
 */

// ---------------------------------------------------------------------------
// Tiny column-major mat4 core (shared with the renderer).
// ---------------------------------------------------------------------------

/** Identity matrix into `out` at float offset `o`. */
export function mat4Identity(out: Float32Array, o = 0): void {
  out[o] = 1;
  out[o + 1] = 0;
  out[o + 2] = 0;
  out[o + 3] = 0;
  out[o + 4] = 0;
  out[o + 5] = 1;
  out[o + 6] = 0;
  out[o + 7] = 0;
  out[o + 8] = 0;
  out[o + 9] = 0;
  out[o + 10] = 1;
  out[o + 11] = 0;
  out[o + 12] = 0;
  out[o + 13] = 0;
  out[o + 14] = 0;
  out[o + 15] = 1;
}

/**
 * out = a * b (all column-major, 16 floats each at the given offsets).
 * `out` must not alias `a` or `b` at the same offset.
 */
export function mat4Multiply(
  out: Float32Array,
  oo: number,
  a: Float32Array,
  ao: number,
  b: Float32Array,
  bo: number,
): void {
  const a00 = a[ao],
    a01 = a[ao + 1],
    a02 = a[ao + 2],
    a03 = a[ao + 3];
  const a10 = a[ao + 4],
    a11 = a[ao + 5],
    a12 = a[ao + 6],
    a13 = a[ao + 7];
  const a20 = a[ao + 8],
    a21 = a[ao + 9],
    a22 = a[ao + 10],
    a23 = a[ao + 11];
  const a30 = a[ao + 12],
    a31 = a[ao + 13],
    a32 = a[ao + 14],
    a33 = a[ao + 15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[bo + i * 4];
    const b1 = b[bo + i * 4 + 1];
    const b2 = b[bo + i * 4 + 2];
    const b3 = b[bo + i * 4 + 3];
    out[oo + i * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[oo + i * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[oo + i * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    out[oo + i * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
}

/** Compose a column-major TRS matrix into `out` at offset `o`. */
export function mat4FromTRS(
  out: Float32Array,
  o: number,
  t: readonly number[],
  q: readonly number[],
  s: readonly number[],
): void {
  const x = q[0],
    y = q[1],
    z = q[2],
    w = q[3];
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
  const sx = s[0],
    sy = s[1],
    sz = s[2];
  out[o] = (1 - (yy + zz)) * sx;
  out[o + 1] = (xy + wz) * sx;
  out[o + 2] = (xz - wy) * sx;
  out[o + 3] = 0;
  out[o + 4] = (xy - wz) * sy;
  out[o + 5] = (1 - (xx + zz)) * sy;
  out[o + 6] = (yz + wx) * sy;
  out[o + 7] = 0;
  out[o + 8] = (xz + wy) * sz;
  out[o + 9] = (yz - wx) * sz;
  out[o + 10] = (1 - (xx + yy)) * sz;
  out[o + 11] = 0;
  out[o + 12] = t[0];
  out[o + 13] = t[1];
  out[o + 14] = t[2];
  out[o + 15] = 1;
}

// ---------------------------------------------------------------------------
// Parsed model types.
// ---------------------------------------------------------------------------

export interface GltfNode {
  name: string;
  /** Local transform (column-major 16 floats), composed from this node's TRS. */
  localMatrix: Float32Array<ArrayBuffer>;
  children: number[];
  parent: number; // -1 for roots
}

export interface GltfSkin {
  /** Node indices in palette order. */
  joints: number[];
  /** Inverse-bind matrices, 16 floats each (column-major), one per joint. */
  inverseBind: Float32Array<ArrayBuffer>;
  /** Joint node names in palette order (for retargeting later). */
  jointNames: string[];
}

export interface GltfPrimitive {
  position: Float32Array<ArrayBuffer>; // f32x3
  normal: Float32Array<ArrayBuffer>; // f32x3
  indices: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
  joints: Uint16Array<ArrayBuffer>; // u16x4 (zero-filled for rigid prims)
  weights: Float32Array<ArrayBuffer>; // f32x4 (zero-filled for rigid prims)
  baseColor: [number, number, number, number];
  /** Node this primitive is drawn under (its global matrix = model matrix). */
  nodeIndex: number;
  /** Skin index, or -1 when the primitive is a rigid (non-skinned) mesh. */
  skinIndex: number;
}

export interface GltfModel {
  nodes: GltfNode[];
  /** Scene root node indices. */
  roots: number[];
  skins: GltfSkin[];
  primitives: GltfPrimitive[];
  /** Node indices in an order where every parent precedes its children. */
  hierarchyOrder: number[];
}

// ---------------------------------------------------------------------------
// glb container + accessor reading.
// ---------------------------------------------------------------------------

interface RawGltf {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: {
    name?: string;
    mesh?: number;
    skin?: number;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    matrix?: number[];
  }[];
  meshes?: {
    name?: string;
    primitives: {
      attributes: Record<string, number>;
      indices?: number;
      material?: number;
      mode?: number;
    }[];
  }[];
  skins?: { joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  materials?: { name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[] } }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
  }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { byteLength: number; uri?: string }[];
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

const COMPONENT_SIZE: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

function componentCount(type: string): number {
  const n = TYPE_COMPONENTS[type];
  if (n === undefined) throw new Error(`glTF: unsupported accessor type ${type}`);
  return n;
}

/** Read one component at a byte offset, honoring `normalized` for int types. */
function readComponent(
  dv: DataView,
  byteOffset: number,
  componentType: number,
  normalized: boolean,
): number {
  switch (componentType) {
    case 5126:
      return dv.getFloat32(byteOffset, true);
    case 5125:
      return dv.getUint32(byteOffset, true);
    case 5123: {
      const v = dv.getUint16(byteOffset, true);
      return normalized ? v / 65535 : v;
    }
    case 5122: {
      const v = dv.getInt16(byteOffset, true);
      return normalized ? Math.max(v / 32767, -1) : v;
    }
    case 5121: {
      const v = dv.getUint8(byteOffset);
      return normalized ? v / 255 : v;
    }
    case 5120: {
      const v = dv.getInt8(byteOffset);
      return normalized ? Math.max(v / 127, -1) : v;
    }
    default:
      throw new Error(`glTF: unsupported componentType ${componentType}`);
  }
}

/**
 * Read an accessor's flat values (count * numComponents) as numbers.
 * Handles tightly-packed and strided bufferViews.
 */
function readAccessorFlat(gltf: RawGltf, bin: DataView, accessorIndex: number): number[] {
  const acc = gltf.accessors?.[accessorIndex];
  if (!acc) throw new Error(`glTF: missing accessor ${accessorIndex}`);
  const nc = componentCount(acc.type);
  const compSize = COMPONENT_SIZE[acc.componentType];
  if (compSize === undefined) throw new Error(`glTF: bad componentType ${acc.componentType}`);
  const out = new Array<number>(acc.count * nc);
  if (acc.bufferView === undefined) {
    out.fill(0); // sparse-only / zero-initialized accessor: not used by this model
    return out;
  }
  const bv = gltf.bufferViews?.[acc.bufferView];
  if (!bv) throw new Error(`glTF: missing bufferView ${acc.bufferView}`);
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = bv.byteStride ?? nc * compSize;
  const norm = acc.normalized ?? false;
  for (let i = 0; i < acc.count; i++) {
    const elemBase = base + i * stride;
    for (let c = 0; c < nc; c++) {
      out[i * nc + c] = readComponent(bin, elemBase + c * compSize, acc.componentType, norm);
    }
  }
  return out;
}

function readFloat32(
  gltf: RawGltf,
  bin: DataView,
  accessorIndex: number,
): Float32Array<ArrayBuffer> {
  return Float32Array.from(readAccessorFlat(gltf, bin, accessorIndex));
}

function readUint16(gltf: RawGltf, bin: DataView, accessorIndex: number): Uint16Array<ArrayBuffer> {
  return Uint16Array.from(readAccessorFlat(gltf, bin, accessorIndex));
}

/** Indices: keep native width (u16 vs u32) so the GPU index buffer matches. */
function readIndices(
  gltf: RawGltf,
  bin: DataView,
  accessorIndex: number,
): Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer> {
  const acc = gltf.accessors?.[accessorIndex];
  if (!acc) throw new Error(`glTF: missing index accessor ${accessorIndex}`);
  const flat = readAccessorFlat(gltf, bin, accessorIndex);
  return acc.componentType === 5125 ? Uint32Array.from(flat) : Uint16Array.from(flat);
}

// ---------------------------------------------------------------------------
// Parse.
// ---------------------------------------------------------------------------

/** Parse a `.glb` ArrayBuffer into GPU-ready, deduplicated model data. */
export function parseGlb(buffer: ArrayBuffer): GltfModel {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('glb: bad magic (not a .glb)');
  if (dv.getUint32(4, true) !== 2) throw new Error('glb: only glTF 2.0 is supported');

  // Walk chunks: chunk 0 must be JSON; the first BIN chunk is the buffer.
  let json: RawGltf | null = null;
  let bin: DataView | null = null;
  let offset = 12;
  const total = dv.getUint32(8, true);
  while (offset + 8 <= total) {
    const chunkLen = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (chunkType === CHUNK_JSON) {
      const bytes = new Uint8Array(buffer, dataStart, chunkLen);
      json = JSON.parse(new TextDecoder().decode(bytes)) as RawGltf;
    } else if (chunkType === CHUNK_BIN && bin === null) {
      bin = new DataView(buffer, dataStart, chunkLen);
    }
    offset = dataStart + chunkLen;
  }
  if (!json) throw new Error('glb: missing JSON chunk');
  if (!bin) throw new Error('glb: missing BIN chunk');

  const rawNodes = json.nodes ?? [];

  // Node hierarchy with composed local matrices.
  const nodes: GltfNode[] = rawNodes.map((n) => {
    const local = new Float32Array(16);
    if (n.matrix && n.matrix.length === 16) {
      local.set(n.matrix);
    } else {
      mat4FromTRS(
        local,
        0,
        n.translation ?? [0, 0, 0],
        n.rotation ?? [0, 0, 0, 1],
        n.scale ?? [1, 1, 1],
      );
    }
    return {
      name: n.name ?? '',
      localMatrix: local,
      children: n.children ?? [],
      parent: -1,
    };
  });
  for (let i = 0; i < nodes.length; i++) {
    for (const c of nodes[i].children) {
      if (c >= 0 && c < nodes.length) nodes[c].parent = i;
    }
  }

  // Scene roots (fall back to any parentless node).
  const sceneIndex = json.scene ?? 0;
  let roots = json.scenes?.[sceneIndex]?.nodes ?? [];
  if (roots.length === 0) roots = nodes.map((_, i) => i).filter((i) => nodes[i].parent === -1);

  // Parent-before-child ordering for cheap per-frame global-matrix passes.
  const hierarchyOrder: number[] = [];
  const stack = [...roots].reverse();
  while (stack.length) {
    const i = stack.pop()!;
    if (i < 0 || i >= nodes.length) continue;
    hierarchyOrder.push(i);
    for (let c = nodes[i].children.length - 1; c >= 0; c--) stack.push(nodes[i].children[c]);
  }

  // Skins.
  const skins: GltfSkin[] = (json.skins ?? []).map((s) => {
    const inverseBind =
      s.inverseBindMatrices !== undefined
        ? readFloat32(json!, bin!, s.inverseBindMatrices)
        : (() => {
            const ib = new Float32Array(s.joints.length * 16);
            for (let j = 0; j < s.joints.length; j++) mat4Identity(ib, j * 16);
            return ib;
          })();
    return {
      joints: s.joints,
      inverseBind,
      jointNames: s.joints.map((j) => nodes[j]?.name ?? ''),
    };
  });

  // Drawable primitives: every node that references a mesh.
  const primitives: GltfPrimitive[] = [];
  for (let ni = 0; ni < rawNodes.length; ni++) {
    const meshIndex = rawNodes[ni].mesh;
    if (meshIndex === undefined) continue;
    const mesh = json.meshes?.[meshIndex];
    if (!mesh) continue;
    const skinIndex = rawNodes[ni].skin ?? -1;

    for (const prim of mesh.primitives) {
      if (prim.mode !== undefined && prim.mode !== 4) continue; // triangles only
      const posAcc = prim.attributes['POSITION'];
      if (posAcc === undefined || prim.indices === undefined) continue;

      const position = readFloat32(json, bin, posAcc);
      const vertCount = position.length / 3;
      const normal =
        prim.attributes['NORMAL'] !== undefined
          ? readFloat32(json, bin, prim.attributes['NORMAL'])
          : new Float32Array(vertCount * 3); // zeros → flat shading fallback

      let joints: Uint16Array<ArrayBuffer>;
      let weights: Float32Array<ArrayBuffer>;
      if (
        skinIndex >= 0 &&
        prim.attributes['JOINTS_0'] !== undefined &&
        prim.attributes['WEIGHTS_0'] !== undefined
      ) {
        joints = readUint16(json, bin, prim.attributes['JOINTS_0']);
        weights = readFloat32(json, bin, prim.attributes['WEIGHTS_0']);
      } else {
        // Rigid mesh (or missing skin data): zero-filled so it shares the
        // skinning pipeline's vertex layout; the shader ignores it (useSkin=0).
        joints = new Uint16Array(vertCount * 4);
        weights = new Float32Array(vertCount * 4);
      }

      const mat = prim.material !== undefined ? json.materials?.[prim.material] : undefined;
      const bcf = mat?.pbrMetallicRoughness?.baseColorFactor;
      const baseColor: [number, number, number, number] =
        bcf && bcf.length === 4 ? [bcf[0], bcf[1], bcf[2], bcf[3]] : [0.8, 0.8, 0.8, 1];

      primitives.push({
        position,
        normal,
        indices: readIndices(json, bin, prim.indices),
        joints,
        weights,
        baseColor,
        nodeIndex: ni,
        // Only mark skinned when the primitive actually carries skin data.
        skinIndex: joints.some((v) => v !== 0) || weights.some((v) => v !== 0) ? skinIndex : -1,
      });
    }
  }

  return { nodes, roots, skins, primitives, hierarchyOrder };
}

/**
 * Compute global matrices for all nodes from their (possibly overridden)
 * local matrices. `localMatrices` is 16 floats * nodeCount; if omitted the
 * parsed rest locals are used. Writes into `out` (16 * nodeCount) and returns
 * it. No allocation when `out` is provided.
 */
export function computeGlobals(
  model: GltfModel,
  localMatrices: Float32Array | null,
  out: Float32Array,
): Float32Array {
  for (const ni of model.hierarchyOrder) {
    // Local source: the per-node override array (indexed) or the rest local.
    const localArr = localMatrices ?? model.nodes[ni].localMatrix;
    const localOff = localMatrices ? ni * 16 : 0;
    const parent = model.nodes[ni].parent;
    if (parent < 0) {
      for (let k = 0; k < 16; k++) out[ni * 16 + k] = localArr[localOff + k];
    } else {
      mat4Multiply(out, ni * 16, out, parent * 16, localArr, localOff);
    }
  }
  return out.subarray(0, model.nodes.length * 16);
}
