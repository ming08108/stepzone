/**
 * Retarget rig configuration: the declarative mapping from a rigged model's
 * bones onto our animation skeleton, plus the our-space→model-space axis
 * convention. The retarget ALGORITHM lives in `skinnedModel.ts`
 * (`retargetFromSkeleton`); this file is just the data it drives from, kept
 * separate so the rig can be tuned without wading through the renderer.
 */

// Our animation solves world-space joints in screen space: x = right, y = DOWN,
// z = toward the viewer, units = design px. glTF is y-UP, so we flip Y by
// default. These are exposed as tunables: flip a sign or reorder AXIS_ORDER to
// correct handedness/orientation during visual tuning without touching logic.
// A direction (child - bone) becomes model space as:
//   c = [dx*X_SIGN, dy*Y_SIGN, dz*Z_SIGN];  dirModel = [c[AXIS_ORDER[i]]]
// ---------------------------------------------------------------------------
export const X_SIGN = 1;
export const Y_SIGN = -1; // our y points down; glTF y points up
export const Z_SIGN = 1;
export const AXIS_ORDER: readonly [number, number, number] = [0, 1, 2];
/**
 * Extra multiplier on the our→model position scale (which is otherwise derived
 * from leg length). Nudge >1 to widen/enlarge the stance, <1 to shrink it,
 * during visual tuning. Only affects foot/root PLACEMENT, not bone aiming.
 */
export const POS_SCALE = 1;

/**
 * Model bone -> our skeleton chain segment. `restChild` is a descendant node
 * of `bone` whose bind position defines the bone's rest aim direction; `from`
 * and `to` are our named joints whose vector is the target aim direction. Two
 * model bones can share one segment (clavicle + upper arm, hips + lower spine).
 * `damp` (0..1) scales the aim rotation toward the rest pose — used to steady
 * short, noisy bones like the neck (a small position wiggle = a big angle).
 */
export interface BoneChain {
  bone: string;
  restChild: string;
  from: string;
  to: string;
  damp?: number;
  /** Hold the bone's bind WORLD orientation instead of aiming — the foot stays
   *  level (sole down) rather than inheriting the shin's tilt and pointing its
   *  toe at the floor. `from`/`to`/`restChild` are ignored when set. */
  hold?: boolean;
  /** Scale the sideways (our-space X) component of the aim target before
   *  aiming. <1 pulls the segment toward the body centerline — used on the leg
   *  chains so wide animation steps don't read as a splayed, bow-legged
   *  stance on the model's proportions. */
  narrowX?: number;
  /** Bend-plane pole control for a 2-bone limb (fixes forearm ROLL/twist that a
   *  bare minimal-arc aim leaves undetermined — invisible on tube limbs, but on
   *  a skinned arm it flips the hand and rotates the elbow's hinge plane).
   *  `pole` names three SOURCE joints (shoulder, elbow, wrist) whose bend-plane
   *  normal `cross(elbow−shoulder, wrist−elbow)` is the TARGET roll reference;
   *  `poleModel` names the matching three MODEL humanoid bones for the REST
   *  normal. Both bones of a limb pass the same triples so they share one plane.
   *  When the limb is near-straight (normal degenerates) it falls back to the
   *  plain aim. `poleSign` flips the rest normal if the L/R crossing inverts it. */
  pole?: readonly [string, string, string];
  poleModel?: readonly [string, string, string];
  poleSign?: number;
}

export const BONE_CHAINS: readonly BoneChain[] = [
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
export const VRM_CHAINS: readonly BoneChain[] = [
  // One bone per body segment — never two in-series bones aimed at the SAME
  // target. Aiming, say, both the clavicle and the upper arm at the elbow
  // COMPOUNDS their rotations (the clavicle swings out, then the arm swings
  // again from there), which displaces and visually stretches the limb at the
  // joint. So the clavicles (shoulder) and upperChest stay at bind and simply
  // inherit their parent's rotation; the real segment bone does the aiming.
  // SIDE NOTE — the L/R pairing is deliberately CROSSED. Our dancer faces the
  // viewer, so her screen-left ("...L") joints are her anatomical RIGHT side.
  // VRM 0.x avatars are pre-rotated 180° at parse (gltf.ts) to face the +Z
  // camera, which puts the model's anatomical-LEFT bones on the viewer's right
  // (+X). So model leftUpperArm must follow our screen-RIGHT ("...R") chain to
  // reproduce the animation as seen on screen. Pairing left-with-L aims every
  // limb at the opposite side's target: legs scissor into an X, arms aim
  // across/into the torso, and the near-180° aim deltas make quatFromTo
  // degenerate (random roll).
  { bone: 'spine', restChild: 'chest', from: 'pelvis', to: 'chest' },
  // The chest carries a POLE too: aiming chest→neck (up) leaves the axial TWIST
  // undetermined, so the shoulders never counter-rotate against the hips and the
  // torso stays square to camera. The pole aligns the chest's shoulder-plane
  // (up × shoulder-out) to the source's twisted shoulder line, so the whole
  // upper body rotates with the groove. (source shoulderR ↔ model leftUpperArm
  // under the crossed L/R mapping.)
  {
    bone: 'chest',
    restChild: 'neck',
    from: 'chest',
    to: 'neck',
    pole: ['pelvis', 'chest', 'shoulderR'],
    poleModel: ['spine', 'chest', 'leftUpperArm'],
  },
  // Neck heavily damped: the head bone is rigid to the neck, so a big neck BEND
  // swings the head off the shoulders and — because linear-blend skinning can't
  // preserve volume across a sharp bend — stretches and thins the neck mesh (it
  // read as a rubber-necked giraffe on head-up/turned poses). The bones never
  // change length (rotation-only retarget), so this is purely the skin stretching
  // over the bend; keeping the neck mostly upright (damp 0.45) holds the head on
  // the shoulders and keeps the column solid, at the cost of a little head sway.
  { bone: 'neck', restChild: 'head', from: 'neck', to: 'head', damp: 0.45 },
  // The clavicle follows the arm PARTWAY (low damp) so a raised arm doesn't
  // concentrate the whole bend at the deltoid — that linear-blend-skinning pinch
  // is what distorts the shoulder. It's aimed at the same target as the upper arm
  // but only ~30%, so the socket elevates a little to spread the deformation
  // without the over-reach a full clavicle aim caused (the old compounding bug).
  { bone: 'leftShoulder', restChild: 'leftUpperArm', from: 'shoulderR', to: 'elbowR', damp: 0.3 },
  // Upper + fore-arm share the elbow bend plane (shoulderR/elbowR/handR source,
  // leftUpperArm/leftLowerArm/leftHand model) so the forearm can't twist the
  // hand off the wrist and the elbow hinge stays in the right plane. Both bones
  // pass the same triple so they roll into one plane. The pole's forearm-roll is
  // what holds the (un-retargeted) hand in line with the wrist; a bare aim leaves
  // that roll free and the rigid hand flops as the arm swings. It no longer needs
  // a `poleSign`: the solver now takes the source bend-normal on the bind side
  // (an elbow hinges one way), so it can't flip 180° on folded arms-up poses.
  {
    bone: 'leftUpperArm',
    restChild: 'leftLowerArm',
    from: 'shoulderR',
    to: 'elbowR',
    pole: ['shoulderR', 'elbowR', 'handR'],
    poleModel: ['leftUpperArm', 'leftLowerArm', 'leftHand'],
  },
  {
    bone: 'leftLowerArm',
    restChild: 'leftHand',
    from: 'elbowR',
    to: 'handR',
    pole: ['shoulderR', 'elbowR', 'handR'],
    poleModel: ['leftUpperArm', 'leftLowerArm', 'leftHand'],
  },
  { bone: 'rightShoulder', restChild: 'rightUpperArm', from: 'shoulderL', to: 'elbowL', damp: 0.3 },
  {
    bone: 'rightUpperArm',
    restChild: 'rightLowerArm',
    from: 'shoulderL',
    to: 'elbowL',
    pole: ['shoulderL', 'elbowL', 'handL'],
    poleModel: ['rightUpperArm', 'rightLowerArm', 'rightHand'],
  },
  {
    bone: 'rightLowerArm',
    restChild: 'rightHand',
    from: 'elbowL',
    to: 'handL',
    pole: ['shoulderL', 'elbowL', 'handL'],
    poleModel: ['rightUpperArm', 'rightLowerArm', 'rightHand'],
  },
  { bone: 'leftUpperLeg', restChild: 'leftLowerLeg', from: 'hipR', to: 'kneeR', narrowX: 0.55 },
  { bone: 'leftLowerLeg', restChild: 'leftFoot', from: 'kneeR', to: 'footR', narrowX: 0.55 },
  { bone: 'leftFoot', restChild: 'leftFoot', from: 'footR', to: 'footR', hold: true },
  { bone: 'rightUpperLeg', restChild: 'rightLowerLeg', from: 'hipL', to: 'kneeL', narrowX: 0.55 },
  { bone: 'rightLowerLeg', restChild: 'rightFoot', from: 'kneeL', to: 'footL', narrowX: 0.55 },
  { bone: 'rightFoot', restChild: 'rightFoot', from: 'footL', to: 'footL', hold: true },
];

/** A resolved retarget bone: node + palette slot + precomputed rest aim dir. */
export interface RetargetBone {
  node: number;
  palette: number;
  restDir: Float32Array<ArrayBuffer>; // unit, native model space (from bind globals)
  from: string;
  to: string;
  damp: number; // 1 = full aim, <1 steadies toward rest
  hold: boolean; // hold bind world orientation (level foot) instead of aiming
  narrowX: number; // <1 pulls the aim target toward the centerline (legs)
  // Pole (bend-plane) control — set only on arm bones. `restN` is the bind
  // bend-plane normal in model space (unit); `poleSrc` are the three source
  // joint names whose live bend-plane normal is the target roll reference.
  restN?: Float32Array<ArrayBuffer>;
  poleSrc?: readonly [string, string, string];
}
