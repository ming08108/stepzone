/**
 * VRM ⇄ physics binding. Two jobs, both pure adapters:
 *  - skeletonFromVrm: measure the avatar's anatomical landmarks (world space,
 *    rest pose) so the rig builds bodies with the character's true
 *    proportions — a taller avatar really is heavier and slower to move.
 *  - PhysVrmBinding: after each physics step, write body orientations back
 *    onto the RAW humanoid bones. Only simulated bones are written; everything
 *    else (fingers, toes, unmapped spine links) keeps its rest pose, so the
 *    rendered character is exactly the simulated one.
 *
 * The VRM is assumed to be rotateVRM0'd (facing +Z) with its scene at the
 * origin BEFORE either function is called; nothing here ever moves the scene.
 */
import * as THREE from 'three/webgpu';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { BodyName, PhysRig, RigPoint, RigSkeleton } from './rig';

const BODY_BONE: readonly (readonly [BodyName, VRMHumanBoneName])[] = [
  // Order matters: parents before children so world quats accumulate.
  ['pelvis', 'hips'],
  ['abdomen', 'spine'],
  ['thorax', 'chest'],
  ['head', 'head'],
  ['uarmL', 'leftUpperArm'],
  ['farmL', 'leftLowerArm'],
  ['uarmR', 'rightUpperArm'],
  ['farmR', 'rightLowerArm'],
  ['thighL', 'leftUpperLeg'],
  ['shinL', 'leftLowerLeg'],
  ['footL', 'leftFoot'],
  ['thighR', 'rightUpperLeg'],
  ['shinR', 'rightLowerLeg'],
  ['footR', 'rightFoot'],
];

function raw(vrm: VRM, name: VRMHumanBoneName): THREE.Object3D | null {
  return vrm.humanoid?.getRawBoneNode(name) ?? null;
}

function worldPos(o: THREE.Object3D): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
}

const P = (v: THREE.Vector3): RigPoint => ({ x: v.x, y: v.y, z: v.z });

/** Measure the avatar. Requires vrm.scene.updateMatrixWorld(true) first. */
export function skeletonFromVrm(vrm: VRM): RigSkeleton {
  const need = (n: VRMHumanBoneName): THREE.Vector3 => {
    const b = raw(vrm, n);
    if (!b) throw new Error(`VRM missing required humanoid bone: ${n}`);
    return worldPos(b);
  };
  const opt = (n: VRMHumanBoneName): THREE.Vector3 | null => {
    const b = raw(vrm, n);
    return b ? worldPos(b) : null;
  };

  const hips = need('hips');
  const spine = need('spine');
  const head = need('head');
  const neck = opt('neck') ?? head.clone();
  const chest = opt('chest') ?? spine.clone().lerp(neck, 0.5);
  const headTop = head.clone();
  headTop.y += Math.max(0.1, (head.y - neck.y) * 1.6 || 0.12);

  const side = (s: 'left' | 'right') => ({
    shoulder: need(`${s}UpperArm` as VRMHumanBoneName),
    elbow: need(`${s}LowerArm` as VRMHumanBoneName),
    wrist: need(`${s}Hand` as VRMHumanBoneName),
    hipSocket: need(`${s}UpperLeg` as VRMHumanBoneName),
    knee: need(`${s}LowerLeg` as VRMHumanBoneName),
    ankle: need(`${s}Foot` as VRMHumanBoneName),
    toe:
      opt(`${s}Toes` as VRMHumanBoneName) ??
      need(`${s}Foot` as VRMHumanBoneName)
        .clone()
        .add(new THREE.Vector3(0, -0.02, 0.13)),
  });
  const L = side('left');
  const R = side('right');

  return {
    hips: P(hips),
    spine: P(spine),
    chest: P(chest),
    neck: P(neck),
    headTop: P(headTop),
    shoulder: [P(L.shoulder), P(R.shoulder)],
    elbow: [P(L.elbow), P(R.elbow)],
    wrist: [P(L.wrist), P(R.wrist)],
    hipSocket: [P(L.hipSocket), P(R.hipSocket)],
    knee: [P(L.knee), P(R.knee)],
    ankle: [P(L.ankle), P(R.ankle)],
    toe: [P(L.toe), P(R.toe)],
  };
}

interface BoneBind {
  body: BodyName;
  bone: THREE.Object3D;
  parent: BoneBind | null;
  qWorld0: THREE.Quaternion; // bone world rotation at rest
  qInter: THREE.Quaternion; // rest locals of unmapped bones between parent bind and this bone
  qWorldNow: THREE.Quaternion; // scratch: this frame's world rotation
}

export class PhysVrmBinding {
  private readonly binds: BoneBind[] = [];
  private readonly rootParentInv = new THREE.Matrix4();
  private readonly rootParentQInv = new THREE.Quaternion();
  private readonly hipsLocal0: THREE.Vector3;

  // scratch
  private readonly _q1 = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _v1 = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();

  constructor(
    private readonly vrm: VRM,
    private readonly rig: PhysRig,
  ) {
    vrm.scene.updateMatrixWorld(true);
    const byBone = new Map<THREE.Object3D, BoneBind>();
    for (const [body, boneName] of BODY_BONE) {
      const bone = raw(vrm, boneName);
      if (!bone) continue; // optional chest handled below via remap
      // Find the nearest mapped ancestor and collect the rest rotation of the
      // unmapped links between it and this bone.
      let parent: BoneBind | null = null;
      const qInter = new THREE.Quaternion();
      const chain: THREE.Object3D[] = [];
      for (let a = bone.parent; a; a = a.parent) {
        const hit = byBone.get(a);
        if (hit) {
          parent = hit;
          break;
        }
        chain.push(a);
      }
      // chain is child→ancestor; rest local product must be ancestor→child.
      for (let i = chain.length - 1; i >= 0; i--) qInter.multiply(chain[i].quaternion);
      const bind: BoneBind = {
        body,
        bone,
        parent,
        qWorld0: bone.getWorldQuaternion(new THREE.Quaternion()),
        qInter,
        qWorldNow: new THREE.Quaternion(),
      };
      byBone.set(bone, bind);
      this.binds.push(bind);
    }
    const rootBone = this.binds[0].bone; // hips
    const rootParent = rootBone.parent!;
    this.rootParentInv.copy(rootParent.matrixWorld).invert();
    rootParent.getWorldQuaternion(this.rootParentQInv).invert();
    this.hipsLocal0 = worldPos(rootBone).sub(this.rig.restCentreOf('pelvis'));
  }

  /** Push the current physics pose onto the VRM's raw bones. */
  apply(): void {
    const { _q1, _q2, _v1, _v2 } = this;
    for (const b of this.binds) {
      this.rig.bodyPose(b.body, _q1, _v1);
      // Body rotations are world-frame (bodies were built with identity
      // rotation), so the bone's target world rotation is qBody·qWorld0.
      b.qWorldNow.copy(_q1).multiply(b.qWorld0);
      if (!b.parent) {
        // Root: hips bone — position AND rotation from the pelvis body.
        b.bone.quaternion.copy(this.rootParentQInv).multiply(b.qWorldNow);
        _v2.copy(this.hipsLocal0).applyQuaternion(_q1).add(_v1);
        b.bone.position.copy(_v2.applyMatrix4(this.rootParentInv));
      } else {
        // qLocal = (parentWorld·qInter)⁻¹ · targetWorld
        _q2.copy(b.parent.qWorldNow).multiply(b.qInter).invert().multiply(b.qWorldNow);
        b.bone.quaternion.copy(_q2);
      }
    }
    this.vrm.scene.updateMatrixWorld(true);
  }
}
