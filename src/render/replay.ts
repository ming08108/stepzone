/**
 * Replay file format v1 — parser + pose interpolator for the ?replaydancer
 * showcase renderer and the scripts/renderReplay.mjs batch capture.
 *
 * A replay is a recorded RL-dancer rollout: a stream of humanoid pose frames
 * (the SAME per-frame body layout the live Isaac pose stream carries, so the
 * exact retarget driver — render/isaacVrmDancer.ts — can play it back), plus the
 * chart events (notes with pad, assigned foot, judgment, timing error).
 *
 * This module is deliberately free of three.js so the interpolation math unit
 * tests stay fast and dependency-light. It emits plain Float32Arrays that the
 * page hands straight to IsaacVrmDancer.update(pos, 0, 0, 0, dt, quatXYZW).
 *
 * Per-frame body layout (documented in docs/replay-format.md):
 *   NBODY = 15 reduced humanoid_28 bodies, order:
 *     0 pelvis, 1 torso, 2 head, 3 R-upper-arm, 4 R-lower-arm, 5 R-hand,
 *     6 L-upper-arm, 7 L-lower-arm, 8 L-hand, 9 R-thigh, 10 R-shin, 11 R-foot,
 *     12 L-thigh, 13 L-shin, 14 L-foot.
 *   Each frame is a flat float array, env-local, Isaac world convention (Z-up,
 *   metres). BLOCK layout so the capture side just concatenates the two arrays
 *   its pose hook already builds:
 *     [ 45 position floats: body0.xyz, body1.xyz, … body14.xyz ]
 *     [ 60 quaternion floats: body0.wxyz, … body14.wxyz ]   (OPTIONAL)
 *   -> length 45  = positions only (swing-only retarget; facing degrades)
 *   -> length 105 = positions + per-body world quaternions (WXYZ) enabling the
 *      facing/twist layer. Quats strongly recommended.
 */

export const NBODY = 15;
const POS_LEN = NBODY * 3; // 45
const QUAT_LEN = NBODY * 4; // 60
const FULL_LEN = POS_LEN + QUAT_LEN; // 105

/** Snap (do not blend) when a body position jumps more than this between two
 *  consecutive frames — an env reset teleports the dancer and must read as a
 *  clean cut, not a smeared slide. Mirrors IsaacViewer.SNAP_JUMP. */
export const SNAP_JUMP = 0.6;

export type JudgmentName = 'marvelous' | 'perfect' | 'great' | 'miss';
const JUDGMENTS: readonly JudgmentName[] = ['marvelous', 'perfect', 'great', 'miss'];

/** 0=Left, 1=Right, 2=Up, 3=Down (DDR pad indices). */
export interface ReplayNote {
  t: number; // seconds into the rollout
  pad: number; // 0=L,1=R,2=U,3=D
  foot: number; // 0=left,1=right (assigned)
  judgment: JudgmentName;
  hit_dt_ms: number | null; // signed timing error of the clean hit, null if miss
  hold_s: number; // hold length in seconds (0 = tap)
}

export interface ReplayChart {
  name: string;
  notes: ReplayNote[];
}

export interface ReplayMeta {
  checkpoint?: string;
  ex_score?: number;
  clean_rate?: number;
  survived?: boolean;
  [k: string]: unknown;
}

export interface Replay {
  version: number;
  fps: number; // pose frames per second (30 or 60 — handled generically)
  chart: ReplayChart;
  frames: Float32Array[]; // one array per frame, block layout above
  hasQuat: boolean; // whether frames carry the optional 60-float quat block
  meta: ReplayMeta;
}

/** An interpolated pose: env-local Isaac Z-up positions and XYZW world quats
 *  (already reordered from the file's WXYZ so it drops straight into the VRM
 *  driver). `quatXYZW` is null when the replay carries no quaternion block. */
export interface Pose {
  pos: Float32Array; // length 45
  quatXYZW: Float32Array | null; // length 60, XYZW, or null
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function normJudgment(v: unknown): JudgmentName {
  const s = String(v).toLowerCase();
  return (JUDGMENTS as readonly string[]).includes(s) ? (s as JudgmentName) : 'miss';
}

/** Parse + validate a raw JSON object into a typed Replay. Throws on structural
 *  problems (missing/empty frames, wrong frame width). Lenient on note fields. */
export function parseReplay(raw: unknown): Replay {
  if (!raw || typeof raw !== 'object') throw new Error('replay: not an object');
  const o = raw as Record<string, unknown>;

  const version = isFiniteNum(o.version) ? o.version : 1;

  const fps = isFiniteNum(o.fps) && o.fps > 0 ? o.fps : 30;

  const chartRaw = (o.chart ?? {}) as Record<string, unknown>;
  const name = typeof chartRaw.name === 'string' && chartRaw.name.length ? chartRaw.name : 'Replay';
  const notesRaw = Array.isArray(chartRaw.notes) ? chartRaw.notes : [];
  const notes: ReplayNote[] = notesRaw
    .map((n0) => {
      const n = (n0 ?? {}) as Record<string, unknown>;
      return {
        t: isFiniteNum(n.t) ? n.t : 0,
        pad: isFiniteNum(n.pad) ? Math.max(0, Math.min(3, Math.round(n.pad))) : 0,
        foot: isFiniteNum(n.foot) ? (n.foot ? 1 : 0) : 0,
        judgment: normJudgment(n.judgment),
        hit_dt_ms: isFiniteNum(n.hit_dt_ms) ? n.hit_dt_ms : null,
        hold_s: isFiniteNum(n.hold_s) ? Math.max(0, n.hold_s) : 0,
      };
    })
    .sort((a, b) => a.t - b.t);

  const framesRaw = o.frames;
  if (!Array.isArray(framesRaw) || framesRaw.length === 0)
    throw new Error('replay: frames must be a non-empty array');

  const width = Array.isArray(framesRaw[0]) ? framesRaw[0].length : -1;
  if (width !== POS_LEN && width !== FULL_LEN)
    throw new Error(
      `replay: frame width ${width} not supported (expected ${POS_LEN} pos-only or ${FULL_LEN} pos+quat)`,
    );
  const hasQuat = width === FULL_LEN;

  const frames: Float32Array[] = framesRaw.map((f, i) => {
    if (!Array.isArray(f) || f.length !== width)
      throw new Error(`replay: frame ${i} has width ${(f as unknown[])?.length} != ${width}`);
    return Float32Array.from(f as number[]);
  });

  const meta = (o.meta ?? {}) as ReplayMeta;

  return { version, fps, chart: { name, notes }, frames, hasQuat, meta };
}

/** Total pose duration in seconds (the playable length of the rollout). */
export function replayDuration(r: Replay): number {
  const poseDur = r.frames.length > 1 ? (r.frames.length - 1) / r.fps : 0;
  // Extend a touch past the last note so its judgment popup can finish.
  const lastNote = r.chart.notes.length ? r.chart.notes[r.chart.notes.length - 1].t + 0.5 : 0;
  return Math.max(poseDur, lastNote);
}

/** Allocate a reusable Pose sized for this replay. */
export function makePose(r: Replay): Pose {
  return {
    pos: new Float32Array(POS_LEN),
    quatXYZW: r.hasQuat ? new Float32Array(QUAT_LEN) : null,
  };
}

/** Normalize a WXYZ quaternion in-place (guards against denormalized data). */
function normalizeWXYZ(
  w: number,
  x: number,
  y: number,
  z: number,
): [number, number, number, number] {
  const n = Math.hypot(w, x, y, z) || 1;
  return [w / n, x / n, y / n, z / n];
}

/** Spherical linear interpolation of two WXYZ quaternions, writing the result
 *  to `dst` at `dstOff` in XYZW order (the order the VRM driver consumes).
 *  Shortest-arc (flips b when the dot is negative); falls back to nlerp for
 *  near-antipodal/degenerate pairs. */
function slerpWXYZtoXYZW(
  a: Float32Array,
  ao: number,
  b: Float32Array,
  bo: number,
  t: number,
  dst: Float32Array,
  dstOff: number,
): void {
  let [aw, ax, ay, az] = normalizeWXYZ(a[ao], a[ao + 1], a[ao + 2], a[ao + 3]);
  let [bw, bx, by, bz] = normalizeWXYZ(b[bo], b[bo + 1], b[bo + 2], b[bo + 3]);
  let cos = aw * bw + ax * bx + ay * by + az * bz;
  if (cos < 0) {
    bw = -bw;
    bx = -bx;
    by = -by;
    bz = -bz;
    cos = -cos;
  }
  let s0: number, s1: number;
  if (cos > 0.9995) {
    // very close — linear blend then renormalize (nlerp) to avoid div-by-zero
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(cos);
    const sinTheta = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sinTheta;
    s1 = Math.sin(t * theta) / sinTheta;
  }
  const w = s0 * aw + s1 * bw;
  const x = s0 * ax + s1 * bx;
  const y = s0 * ay + s1 * by;
  const z = s0 * az + s1 * bz;
  const inv = 1 / (Math.hypot(w, x, y, z) || 1);
  // XYZW output
  dst[dstOff] = x * inv;
  dst[dstOff + 1] = y * inv;
  dst[dstOff + 2] = z * inv;
  dst[dstOff + 3] = w * inv;
}

/** Copy a frame's WXYZ quat block into `dst` as XYZW. */
function copyWXYZtoXYZW(src: Float32Array, dst: Float32Array): void {
  for (let j = 0; j < NBODY; j++) {
    const s = POS_LEN + j * 4;
    const d = j * 4;
    dst[d] = src[s + 1]; // x
    dst[d + 1] = src[s + 2]; // y
    dst[d + 2] = src[s + 3]; // z
    dst[d + 3] = src[s]; // w
  }
}

/** Largest absolute per-position-component difference between two frames. */
function maxPosJump(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < POS_LEN; i++) {
    const d = Math.abs(b[i] - a[i]);
    if (d > m) m = d;
  }
  return m;
}

/**
 * Interpolated pose at time `t` seconds. Positions lerp; quaternions SLERP
 * (never a naive per-component quat lerp — matters for the 120fps and rate!=1
 * over-crank capture modes). Snaps (no blend) across env-reset teleports.
 * Handles fps 30 or 60 identically — `t` is real seconds, indexing is `t*fps`.
 */
export function sampleReplay(r: Replay, t: number, out?: Pose): Pose {
  const pose = out ?? makePose(r);
  const frames = r.frames;
  const n = frames.length;
  if (n === 0) {
    pose.pos.fill(0);
    return pose;
  }
  const fpos = Math.max(0, Math.min(n - 1, t * r.fps));
  const i0 = Math.floor(fpos);
  const i1 = Math.min(n - 1, i0 + 1);
  const frac = fpos - i0;
  const a = frames[i0];
  const b = frames[i1];

  if (i0 === i1 || frac <= 0) {
    pose.pos.set(a.subarray(0, POS_LEN));
    if (pose.quatXYZW) copyWXYZtoXYZW(a, pose.quatXYZW);
    return pose;
  }
  // Teleport between a and b -> show the newer frame, don't smear across it.
  if (maxPosJump(a, b) > SNAP_JUMP) {
    const src = frac < 0.5 ? a : b;
    pose.pos.set(src.subarray(0, POS_LEN));
    if (pose.quatXYZW) copyWXYZtoXYZW(src, pose.quatXYZW);
    return pose;
  }
  for (let i = 0; i < POS_LEN; i++) pose.pos[i] = a[i] + (b[i] - a[i]) * frac;
  if (pose.quatXYZW && r.hasQuat) {
    for (let j = 0; j < NBODY; j++)
      slerpWXYZtoXYZW(a, POS_LEN + j * 4, b, POS_LEN + j * 4, frac, pose.quatXYZW, j * 4);
  }
  return pose;
}

/** Judgment display colors (classic DDR / Simply Love coding), reused by the
 *  page HUD and the pad flashes. */
export const JUDGMENT_COLOR: Record<JudgmentName, string> = {
  marvelous: '#3fc7ff', // bright cyan (Fantastic/Marvelous)
  perfect: '#ffd500', // gold
  great: '#31d15a', // green
  miss: '#ff3b52', // red
};

export const JUDGMENT_LABEL: Record<JudgmentName, string> = {
  marvelous: 'MARVELOUS',
  perfect: 'PERFECT',
  great: 'GREAT',
  miss: 'MISS',
};

/** Running EX% over the notes with t <= now, using the standard 3/2/1/0
 *  Fantastic/Perfect/Great/Miss weighting. Returns 100 when nothing judged. */
export function exPercentAt(notes: readonly ReplayNote[], now: number): number {
  let earned = 0;
  let possible = 0;
  for (const nt of notes) {
    if (nt.t > now) break; // notes are sorted by t
    possible += 3;
    earned +=
      nt.judgment === 'marvelous'
        ? 3
        : nt.judgment === 'perfect'
          ? 2
          : nt.judgment === 'great'
            ? 1
            : 0;
  }
  return possible === 0 ? 100 : (earned / possible) * 100;
}

/** Combo at `now`: consecutive non-miss notes ending at the last judged note.
 *  (Miss and, conventionally, Great-or-better keep combo; only Miss breaks it.) */
export function comboAt(notes: readonly ReplayNote[], now: number): number {
  let combo = 0;
  for (const nt of notes) {
    if (nt.t > now) break;
    if (nt.judgment === 'miss') combo = 0;
    else combo += 1;
  }
  return combo;
}
