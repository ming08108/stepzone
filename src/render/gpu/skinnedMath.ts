/**
 * Allocation-free, offset-addressed math for the skinned-model renderer and its
 * retargeter: quaternions ([x, y, z, w]), column-major 4x4 matrices, and the
 * skinning / view-projection helpers. Every function writes into a caller-owned
 * output array at a byte-free element offset, so the hot paths never allocate.
 */

import { mat4Identity, type GltfPrimitive } from './gltf.ts';

// ---------------------------------------------------------------------------
// Quaternions.
// ---------------------------------------------------------------------------

/** Extract a unit rotation quaternion from a column-major matrix's 3x3 (scale-removed). */
export function quatFromMat(out: Float32Array, oo: number, m: Float32Array, mo: number): void {
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
export function quatMul(
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
export function quatInvMul(
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
export function quatFromTo(out: Float32Array, oo: number, a: Float32Array, b: Float32Array): void {
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
export function quatSlerpIdentity(
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

// ---------------------------------------------------------------------------
// Matrices.
// ---------------------------------------------------------------------------

/**
 * out[oo..oo+16] = inverse of the column-major 4x4 at m[mo..]. Returns whether
 * it was invertible; on a singular matrix writes identity (NaN-safe).
 */
export function mat4Invert(out: Float32Array, oo: number, m: Float32Array, mo: number): boolean {
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

/** Compose a column-major TRS matrix into `out[oo..]` from offset-addressed T, quat R, S. */
export function composeTRSAt(
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
// Vectors / skinning.
// ---------------------------------------------------------------------------

/** Euclidean distance between joints a and b in a flat [x,y,z] skeleton array. */
export function dist3(skel: Float64Array, a: number, b: number): number {
  return Math.hypot(
    skel[a * 3] - skel[b * 3],
    skel[a * 3 + 1] - skel[b * 3 + 1],
    skel[a * 3 + 2] - skel[b * 3 + 2],
  );
}

/** out(xyz) = (column-major m at mo) * (x, y, z, 1). */
export function transformPoint(
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

const _skinTmp = new Float32Array(3);

/** out(xyz) = linear-blend-skinned position of prim vertex `v` (palette at `base`). */
export function skinPoint(
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

// ---------------------------------------------------------------------------
// View / projection (column-major, WebGPU depth range [0,1]).
// ---------------------------------------------------------------------------

export function perspectiveZO(
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

export function lookAt(
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
