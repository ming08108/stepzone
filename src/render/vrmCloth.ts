/**
 * Build VRM spring-bone physics for a skirt + hair that were rigged but shipped
 * WITHOUT a spring-bone config — common in MMD→VRM conversions (e.g. the Miku model,
 * whose bones are Japanese: スカート = skirt, 髪 = hair). Adds body colliders so cloth
 * is pushed aside instead of clipping. Call at bind pose, then `sbm.setInitState()`.
 *
 * NB the caller should only invoke this when `vrm.springBoneManager.joints.size === 0`
 * — proper VRM/VRoid exports carry their own spring bones and must not be double-driven.
 */
import * as THREE from 'three/webgpu';
import {
  VRMSpringBoneJoint,
  VRMSpringBoneCollider,
  VRMSpringBoneColliderShapeCapsule,
  VRMSpringBoneColliderShapeSphere,
  type VRMSpringBoneColliderGroup,
  type VRMSpringBoneJointSettings,
} from '@pixiv/three-vrm-springbone';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

// Match the skirt CHAIN bones only (スカート_<segment>_<strip>) — NOT the スカート親
// root, which stays fixed to the waist so the skirt hangs from it. Unanchoring this to
// include the root turns the whole skirt springy off its own base → it collapses.
const SKIRT_RE = /^(スカート_\d+_\d+|skirt_?\d+)/i;
const HAIR_RE = /髪|hair/i;
// Miku's MMD skirt chains are スカート_<segment>_<strip>; segment 0 = waistband.
const SKIRT_SEG_RE = /スカート_(\d+)_/;

export function buildClothPhysics(vrm: VRM): void {
  const sbm = vrm.springBoneManager;
  if (!sbm) return;
  const raw = (n: VRMHumanBoneName) => vrm.humanoid?.getRawBoneNode(n) ?? null;

  const capsule = (name: VRMHumanBoneName, radius: number) => {
    const bone = raw(name);
    if (!bone) return null;
    const child = bone.children.find((c) => (c as THREE.Bone).isBone) ?? null;
    const tail = child ? child.position.clone() : new THREE.Vector3(0, -0.3, 0);
    const col = new VRMSpringBoneCollider(
      new VRMSpringBoneColliderShapeCapsule({ radius, offset: new THREE.Vector3(), tail }),
    );
    bone.add(col);
    return col;
  };
  const sphere = (name: VRMHumanBoneName, radius: number) => {
    const bone = raw(name);
    if (!bone) return null;
    const col = new VRMSpringBoneCollider(
      new VRMSpringBoneColliderShapeSphere({ radius, offset: new THREE.Vector3() }),
    );
    bone.add(col);
    return col;
  };
  const clean = (a: (VRMSpringBoneCollider | null)[]) =>
    a.filter((c): c is VRMSpringBoneCollider => !!c);

  const thighL = capsule('leftUpperLeg', 0.072);
  const thighR = capsule('rightUpperLeg', 0.072);
  const shinL = capsule('leftLowerLeg', 0.05);
  const shinR = capsule('rightLowerLeg', 0.05);
  // Small, LOW collider fills the crotch gap without poofing the skirt (on many rigs
  // the `hips` bone sits low near the crotch; fall back to `spine`).
  const pelvis = sphere('hips', 0.07) ?? sphere('spine', 0.07);
  const chest = sphere('upperChest', 0.13) ?? sphere('chest', 0.13);
  const head = sphere('head', 0.1);

  const legGroup: VRMSpringBoneColliderGroup = {
    name: 'legs',
    colliders: clean([thighL, thighR, shinL, shinR, pelvis]),
  };
  const bodyGroup: VRMSpringBoneColliderGroup = {
    name: 'body',
    colliders: clean([head, chest, pelvis, thighL, thighR, shinL, shinR]),
  };

  const down = new THREE.Vector3(0, -1, 0);
  const addChain = (
    match: RegExp,
    settingsFor: VRMSpringBoneJointSettings | ((name: string) => VRMSpringBoneJointSettings),
    groups: VRMSpringBoneColliderGroup[],
  ) => {
    let n = 0;
    vrm.scene.traverse((o) => {
      if (!(o as THREE.Bone).isBone || !match.test(o.name)) return;
      const child = o.children.find((c) => match.test(c.name)) ?? null;
      const settings = typeof settingsFor === 'function' ? settingsFor(o.name) : settingsFor;
      sbm.addJoint(new VRMSpringBoneJoint(o, child, settings, groups));
      n++;
    });
    return n;
  };

  // Skirt: waistband (segment 0) firm to hold an even ring; segments below near-ZERO
  // stiffness so gravity drops the hem straight down onto the legs (any stiffness there
  // restores the flared A-line bind shape → the skirt sticks out / poofs).
  const skirtStiff = [0.8, 0.14, 0.08, 0.05, 0.04];
  addChain(
    SKIRT_RE,
    (name) => {
      const m = SKIRT_SEG_RE.exec(name);
      const seg = m ? Math.min(4, parseInt(m[1], 10)) : 3;
      return {
        stiffness: skirtStiff[seg],
        gravityPower: 0.55,
        gravityDir: down,
        dragForce: 0.5,
        hitRadius: 0.04,
      };
    },
    [legGroup],
  );
  // Hair: floppier, lighter gravity so twin-tails/ponytails flow.
  addChain(
    HAIR_RE,
    { stiffness: 0.55, gravityPower: 0.28, gravityDir: down, dragForce: 0.42, hitRadius: 0.03 },
    [bodyGroup],
  );

  sbm.setInitState();
}
