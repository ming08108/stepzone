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

export function retargetMixamoToVrm(
  clip: THREE.AnimationClip,
  vrm: VRM,
  mixamoRoot: THREE.Object3D,
): THREE.AnimationClip {
  mixamoRoot.updateMatrixWorld(true);
  const tracks: THREE.KeyframeTrack[] = [];
  const q = new THREE.Quaternion();
  const restInv = new THREE.Quaternion();
  const parentRest = new THREE.Quaternion();

  const isVrm0 = vrm.meta?.metaVersion === '0';
  const seen = new Set<string>();

  for (const track of clip.tracks) {
    const [boneName, prop] = track.name.split('.');
    const vrmBone = RIG[boneName];
    if (!vrmBone) continue;
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
