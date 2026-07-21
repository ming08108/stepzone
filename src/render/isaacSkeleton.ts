/**
 * Isaac pose-stream skeleton layouts.
 *
 * Every frame the relay (F:\isaac-spike\stream\pose_relay.py) forwards carries a
 * `b` field = the number of rigid bodies in that frame. Two skeletons are in use:
 *
 *   15 — legacy humanoid_28 reduced skeleton. Index order:
 *        0 pelvis 1 torso 2 head 3 R-upper-arm 4 R-lower-arm 5 R-hand
 *        6 L-upper-arm 7 L-lower-arm 8 L-hand 9 R-thigh 10 R-shin 11 R-foot
 *        12 L-thigh 13 L-shin 14 L-foot
 *
 *   21 — Miku-exact anatomical skeleton (rich_skeleton/amp_humanoid_miku.xml).
 *        The trunk is split into a real spine+chest, the neck is its own body,
 *        clavicles and toes are added, and L precedes R. Index order:
 *        0 pelvis 1 spine 2 chest 3 neck 4 head
 *        5 L-clavicle 6 L-upper-arm 7 L-lower-arm 8 L-hand
 *        9 R-clavicle 10 R-upper-arm 11 R-lower-arm 12 R-hand
 *        13 L-thigh 14 L-shin 15 L-foot 16 L-toe
 *        17 R-thigh 18 R-shin 19 R-foot 20 R-toe
 *
 * These index orders MUST stay in lockstep with the writer's
 * CANONICAL_BODY_ORDER_15 / CANONICAL_BODY_ORDER_MIKU21 in
 * F:\isaac-spike\stream\pose_stream_hook.py — that module remaps the robot's
 * native body order into exactly this order before streaming, so the viewer can
 * index bodies positionally.
 *
 * Kept free of three.js so the layout tables can be imported by both the live
 * viewer and unit tests without pulling the renderer in.
 */

export const MAX_BODIES = 21;

/** Parent -> child bone pairs (indices into the per-body position array) used to
 *  draw the capsule ball-and-tube skeleton. */
export type BonePair = readonly [number, number];

// 15-body bones (matches the legacy IsaacViewer BONES table exactly).
export const BONES_15: readonly BonePair[] = [
  [0, 1], // pelvis -> torso
  [1, 2], // torso -> head
  [1, 3], // torso -> right_upper_arm
  [3, 4], // right_upper_arm -> right_lower_arm
  [4, 5], // right_lower_arm -> right_hand
  [1, 6], // torso -> left_upper_arm
  [6, 7], // left_upper_arm -> left_lower_arm
  [7, 8], // left_lower_arm -> left_hand
  [0, 9], // pelvis -> right_thigh
  [9, 10], // right_thigh -> right_shin
  [10, 11], // right_shin -> right_foot
  [0, 12], // pelvis -> left_thigh
  [12, 13], // left_thigh -> left_shin
  [13, 14], // left_shin -> left_foot
];

// 21-body Miku bones. pelvis->spine->chest trunk, chest->neck->head, chest fans
// out to both clavicle->arm chains, pelvis to both thigh->...->toe chains.
export const BONES_21: readonly BonePair[] = [
  [0, 1], // pelvis -> spine
  [1, 2], // spine -> chest
  [2, 3], // chest -> neck
  [3, 4], // neck -> head
  [2, 5], // chest -> left_clavicle
  [5, 6], // left_clavicle -> left_upper_arm
  [6, 7], // left_upper_arm -> left_lower_arm
  [7, 8], // left_lower_arm -> left_hand
  [2, 9], // chest -> right_clavicle
  [9, 10], // right_clavicle -> right_upper_arm
  [10, 11], // right_upper_arm -> right_lower_arm
  [11, 12], // right_lower_arm -> right_hand
  [0, 13], // pelvis -> left_thigh
  [13, 14], // left_thigh -> left_shin
  [14, 15], // left_shin -> left_foot
  [15, 16], // left_foot -> left_toe
  [0, 17], // pelvis -> right_thigh
  [17, 18], // right_thigh -> right_shin
  [18, 19], // right_shin -> right_foot
  [19, 20], // right_foot -> right_toe
];

export interface SkeletonLayout {
  /** number of bodies per frame */
  nb: number;
  /** capsule bone pairs */
  bones: readonly BonePair[];
}

export const LAYOUT_15: SkeletonLayout = { nb: 15, bones: BONES_15 };
export const LAYOUT_21: SkeletonLayout = { nb: 21, bones: BONES_21 };

/** Pick the layout for a streamed body count. Anything that isn't the 21-body
 *  Miku skeleton falls back to the 15-body legacy layout (older relays, and the
 *  swing-only default), so an unexpected `b` never crashes the viewer. */
export function layoutForBodies(b: number | undefined): SkeletonLayout {
  return b === 21 ? LAYOUT_21 : LAYOUT_15;
}
