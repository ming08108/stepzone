/**
 * Retarget a Mixamo (`mixamorig*`) animation clip onto a VRM's humanoid, using the
 * canonical rest-pose-relative rotation rebuild (the same approach as the official
 * three-vrm `loadMixamoAnimation` example). Unlike SkeletonUtils.retargetClip —
 * which copies raw world orientations and inverts limbs whose bind axes differ — this
 * expresses each frame relative to BOTH skeletons' rest pose, so it survives the
 * Mixamo→VRM axis differences. Output tracks target the VRM's NORMALIZED bone nodes;
 * drive them with an AnimationMixer on `vrm.scene`, then call `vrm.update(dt)`.
 */
import * as THREE from 'three/webgpu';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

const RIG: Record<string, VRMHumanBoneName> = {
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes',
};

const IDENTITY_Q = new THREE.Quaternion();

export function retargetMixamoToVrm(
  clip: THREE.AnimationClip,
  vrm: VRM,
  mixamoRoot: THREE.Object3D,
  gains?: Partial<Record<VRMHumanBoneName, number>>,
): THREE.AnimationClip {
  mixamoRoot.updateMatrixWorld(true);
  const tracks: THREE.KeyframeTrack[] = [];
  const q = new THREE.Quaternion();
  const restInv = new THREE.Quaternion();
  const parentRest = new THREE.Quaternion();

  const isVrm0 = vrm.meta?.metaVersion === '0';
  const seen = new Set<string>();
  const twist = new THREE.Quaternion();
  // Optional per-bone GAIN map: keep a bone's track only if it has an entry, scaling its motion
  // amplitude by the gain (1 = full authored motion, 0.55 = damped). The dancer keeps arms/hands
  // at full and the torso (spine/chest) at full — that clip choreography is what reads as
  // "dancing" — but damps the hips (the procedural contrapposto/lean layer + foot-IK ride on
  // top) and drops the legs entirely. Composed as clipPose·Δ downstream, so no slerp-fight.
  const gainOf = (bone: VRMHumanBoneName): number | undefined => (gains ? gains[bone] : 1); // no map → keep everything at full (back-compat)

  for (const track of clip.tracks) {
    const [boneName, prop] = track.name.split('.');
    const vrmBone = RIG[boneName];
    if (!vrmBone) continue;
    const gain = gainOf(vrmBone);
    if (gain === undefined) continue; // bone absent from the map → drop its track
    const vrmNode = vrm.humanoid?.getNormalizedBoneNode(vrmBone);
    const mixamoNode = mixamoRoot.getObjectByName(boneName); // real bone (dupes exist)
    if (!vrmNode || !mixamoNode) continue;
    const key = `${vrmNode.name}.${prop}`;
    if (seen.has(key)) continue; // dupe-named source bones → one track per target
    seen.add(key);

    // Rest orientations of the SOURCE bone and its parent.
    mixamoNode.getWorldQuaternion(restInv).invert();
    mixamoNode.parent!.getWorldQuaternion(parentRest);

    if (prop === 'quaternion' && track instanceof THREE.QuaternionKeyframeTrack) {
      const values = track.values.slice();
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(values, i);
        q.premultiply(parentRest).multiply(restInv); // parentRest · local · restⁱⁿᵛ
        if (isVrm0) {
          q.x = -q.x;
          q.z = -q.z; // VRM0 faces −Z → mirror the animation about the YZ/XY axes
        }
        // The HIPS drive the whole body, and the samba clip TURNS (full-body spins) — which spun
        // an attract dancer who should face the camera. Strip only the Y-axis twist (the facing
        // rotation) from the hips via swing-twist decomposition, keeping the roll/pitch hip sway.
        // (Torso twist stays: it lives in spine/chest, which rotate relative to a forward pelvis.)
        if (vrmBone === 'hips') {
          twist.set(0, q.y, 0, q.w).normalize(); // the Y-twist component
          q.multiply(twist.invert()); // swing = q · twist⁻¹  → yaw removed
        }
        // Scale the rest-relative deviation toward rest by (1−gain): keep `gain` of the motion.
        if (gain < 1) q.slerp(IDENTITY_Q, 1 - gain);
        q.toArray(values, i);
      }
      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${vrmNode.name}.quaternion`,
          track.times.slice(),
          values,
        ),
      );
    }
    // Position tracks are intentionally dropped (only the hip has one): keeping the
    // hips centred over the pad is what the foot-IK + height servo want. The VRM is
    // grounded by the servo, not by the clip's captured root wander.
  }
  return new THREE.AnimationClip('vrm-' + clip.name, clip.duration, tracks);
}
