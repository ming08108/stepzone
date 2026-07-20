/**
 * IsaacVrmDancer — drive a VRM humanoid avatar from the Isaac Lab pose stream so
 * one dancer slot in ?isaacviewer renders as a Miku-style anime character instead
 * of a ball-and-tube capsule skeleton.
 *
 * ── Retarget: position swing + quat twist ───────────────────────────────────
 * Base layer (always on): each VRM bone is *aimed* from its joint toward its child
 * joint using the 15 streamed POSITIONS (a look-at / swing retarget). This is
 * self-calibrating — the VRM rest reference and the streamed target are built from
 * real geometry with identical formulas — so the classic failure modes can't occur:
 *   - mirrored L/R      : impossible; we use the actual left/right joint 3D coords.
 *   - 180° yaw flip      : impossible; hips yaw is pinned by the thigh-to-thigh axis.
 *   - candy-wrapper roll : the swing carries no twist of its own.
 *
 * Twist layer (added when the relay forwards quats — the additive "quat" field on
 * pose_relay.py, wxyz world orientations): we recover the axial roll the swing
 * can't — the dancer's FACING (hips/trunk/head yaw through mocap-style turns) and
 * limb pronation. To dodge the calibration hazard (humanoid_28 body axes vs VRM
 * bone axes differ), twist is NOT taken absolutely: for each bone we track the
 * CHANGE in its roll RELATIVE TO ITS PARENT body since a one-time calibration frame
 * (child-vs-parent cancels whole-body yaw, so a limb can't pick up a body spin as a
 * spurious candy-wrapper), and apply only that swing–twist component about the
 * bone's own axis (clamped by TWIST_MAX). The hips take the pelvis's full world
 * orientation via a constant offset calibrated once off the position basis, so
 * facing stays clean even when the legs close mid-spin. `?twist=off` disables the
 * whole layer -> swing-only fallback. Older relays (no quat field) fall back the
 * same way automatically. Fingers/toes/face remain undriven — expected.
 *
 * ── Asset / license ─────────────────────────────────────────────────────────
 * Default avatar is /models/Miku4.vrm — an edited Tda "Hatsune Miku V4X" MMD→VRM
 * derivative under the Piapro Character License (NON-COMMERCIAL personal use),
 * already shipped in this repo (see public/models/MODELS_LICENSE.md). That license
 * is fine for a local dev viewer. To swap in any other .vrm, drop it in
 * public/models/ and pass ?vrmurl=/models/YourModel.vrm (or a full URL). No
 * legitimately-downloadable *official* Miku VRM was needed — the repo already
 * carries a licensed Miku.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  VRMLoaderPlugin,
  VRMUtils,
  MToonMaterialLoaderPlugin,
  type VRM,
  type VRMHumanBoneName,
} from '@pixiv/three-vrm';
import { MToonNodeMaterial } from '@pixiv/three-vrm/nodes';
import { buildClothPhysics } from './vrmCloth';

export const DEFAULT_VRM_URL = '/models/Miku4.vrm';

// Canonical humanoid_28 reduced 15-body order (verified against IsaacViewer's BONES
// table + pose_stream_format.py). Indices into the streamed per-body position array.
const B_PELVIS = 0;
const B_TORSO = 1;
const B_HEAD = 2;
const B_R_UPPER_ARM = 3;
const B_R_LOWER_ARM = 4;
const B_R_HAND = 5;
const B_L_UPPER_ARM = 6;
const B_L_LOWER_ARM = 7;
const B_L_HAND = 8;
const B_R_THIGH = 9;
const B_R_SHIN = 10;
const B_R_FOOT = 11;
const B_L_THIGH = 12;
const B_L_SHIN = 13;
const B_L_FOOT = 14;

/** One aim-driven VRM bone: point it from `parentBody` toward `childBody`. The rig
 *  child node (first existing of `rigChild`, else the bone's first child) supplies
 *  the rest direction the aim rotates away from. */
interface AimSpec {
  bone: VRMHumanBoneName;
  parentBody: number; // stream body at the bone's proximal joint (aim tail)
  childBody: number; // stream body at the bone's distal joint (aim head / direction)
  rigChild: VRMHumanBoneName[];
  // Relative-twist source: the axial roll of `twistOwn` measured RELATIVE TO
  // `twistParent` (child-vs-parent cancels whole-body yaw, so a limb twist never
  // picks up a body spin as spurious candy-wrapper). Referenced to the calibration
  // frame, so only the CHANGE in roll is applied on top of the position swing.
  twistOwn: number;
  twistParent: number;
  // Whether to apply quat twist to this bone. All on by default; flip a bone off
  // (ship it swing-only) if verification shows its twist axis reads wrong.
  twist: boolean;
}

// Parent-before-child order so each bone's parent world orientation is current when
// we aim it. Torso: aim the lower spine at the torso body and the neck at the head.
const AIM_SPECS: readonly AimSpec[] = [
  // trunk / head: twist = trunk & head FACING (the primary win of adding quats)
  {
    bone: 'spine',
    parentBody: B_PELVIS,
    childBody: B_TORSO,
    rigChild: ['chest', 'upperChest', 'neck', 'head'],
    twistOwn: B_TORSO,
    twistParent: B_PELVIS,
    twist: true,
  },
  {
    bone: 'neck',
    parentBody: B_TORSO,
    childBody: B_HEAD,
    rigChild: ['head'],
    twistOwn: B_HEAD,
    twistParent: B_TORSO,
    twist: true,
  },
  // arms: forearm twist = pronation (relative to upper arm); upper arm relative to torso
  {
    bone: 'rightUpperArm',
    parentBody: B_R_UPPER_ARM,
    childBody: B_R_LOWER_ARM,
    rigChild: ['rightLowerArm'],
    twistOwn: B_R_UPPER_ARM,
    twistParent: B_TORSO,
    twist: true,
  },
  {
    bone: 'rightLowerArm',
    parentBody: B_R_LOWER_ARM,
    childBody: B_R_HAND,
    rigChild: ['rightHand'],
    twistOwn: B_R_LOWER_ARM,
    twistParent: B_R_UPPER_ARM,
    twist: true,
  },
  {
    bone: 'leftUpperArm',
    parentBody: B_L_UPPER_ARM,
    childBody: B_L_LOWER_ARM,
    rigChild: ['leftLowerArm'],
    twistOwn: B_L_UPPER_ARM,
    twistParent: B_TORSO,
    twist: true,
  },
  {
    bone: 'leftLowerArm',
    parentBody: B_L_LOWER_ARM,
    childBody: B_L_HAND,
    rigChild: ['leftHand'],
    twistOwn: B_L_LOWER_ARM,
    twistParent: B_L_UPPER_ARM,
    twist: true,
  },
  // legs: shin twist relative to thigh; thigh relative to pelvis
  {
    bone: 'rightUpperLeg',
    parentBody: B_R_THIGH,
    childBody: B_R_SHIN,
    rigChild: ['rightLowerLeg'],
    twistOwn: B_R_THIGH,
    twistParent: B_PELVIS,
    twist: true,
  },
  {
    bone: 'rightLowerLeg',
    parentBody: B_R_SHIN,
    childBody: B_R_FOOT,
    rigChild: ['rightFoot'],
    twistOwn: B_R_SHIN,
    twistParent: B_R_THIGH,
    twist: true,
  },
  {
    bone: 'leftUpperLeg',
    parentBody: B_L_THIGH,
    childBody: B_L_SHIN,
    rigChild: ['leftLowerLeg'],
    twistOwn: B_L_THIGH,
    twistParent: B_PELVIS,
    twist: true,
  },
  {
    bone: 'leftLowerLeg',
    parentBody: B_L_SHIN,
    childBody: B_L_FOOT,
    rigChild: ['leftFoot'],
    twistOwn: B_L_SHIN,
    twistParent: B_L_THIGH,
    twist: true,
  },
];

// Safety clamp on the per-bone twist so one bad frame can't fling a candy-wrapper.
// Generous enough for real head/trunk turns and forearm pronation.
const TWIST_MAX = (150 * Math.PI) / 180;

// ── Foot grounding ──────────────────────────────────────────────────────────
// The VRM's leg length differs from the streamed skeleton's, so pinning her hips
// to the source pelvis HEIGHT leaves her feet floating (straight pose, VRM legs
// shorter) or sunk. We instead detect which source foot is planted and drop the
// hips so the VRM's lowest foot bone rests where the source's planted foot is.
//
// Source foot height (Isaac z, metres, == three-space y after isaacToThree) sampled
// off the LIVE stream: the lower foot sits at ~0.05 while planted, climbs past ~0.15
// only during hops (observed p50 minFoot 0.065, max 0.199). Thresholds picked there:
const PLANT_H = 0.09; // a foot at/under this source height counts as planted
const HOP_H = 0.15; // BOTH feet above this => clear hop; skip grounding, keep pelvis
const GROUND_MAX = 0.3; // clamp the vertical hip correction (m)
const GROUND_TAU = 0.1; // grounding lerp time-constant (~100 ms) — no popping

/** Isaac world (x, y, z=up) -> three (x, z=up, -y). Handedness-preserving (verified),
 *  identical to the mapping IsaacViewer uses for the capsule joints. */
function isaacToThree(ix: number, iy: number, iz: number, out: THREE.Vector3): void {
  out.set(ix, iz, -iy);
}

interface ResolvedAim {
  node: THREE.Object3D;
  parentBody: number;
  childBody: number;
  cLocal: THREE.Vector3; // rest child-direction in the bone's local frame (unit)
  twistOwn: number;
  twistParent: number;
  twist: boolean;
  rrel0: THREE.Quaternion; // reference relative orientation (own vs parent) at calibration
}

export class IsaacVrmDancer {
  vrm: VRM | null = null;
  ready = false;
  failed = false;
  error: string | null = null;

  private readonly scene: THREE.Scene;
  private readonly url: string;
  private groundOffset = 0;
  private readonly footIK: boolean;

  // rest references (captured once at bind)
  private readonly restHips = new THREE.Vector3();
  private readonly upRest = new THREE.Vector3(0, 1, 0);
  private readonly leftRest = new THREE.Vector3(1, 0, 0);
  private hipsNode: THREE.Object3D | null = null;
  private rUpperLeg: THREE.Object3D | null = null;
  private lUpperLeg: THREE.Object3D | null = null;
  private rLowerLeg: THREE.Object3D | null = null;
  private lLowerLeg: THREE.Object3D | null = null;
  private rFootNode: THREE.Object3D | null = null;
  private lFootNode: THREE.Object3D | null = null;
  private resolved: ResolvedAim[] = [];
  private allBoneKeys: VRMHumanBoneName[] = [];

  // Foot grounding: smoothed vertical hip correction and its current target (held
  // through the transitional band between planted and hop so it never pops).
  private groundCorr = 0;
  private groundTargetCorr = 0;

  // quat / twist state
  private calibrated = false; // set on the first stable frame that carries quats
  private readonly oHips = new THREE.Quaternion(); // const body->bone offset for the pelvis
  private readonly qThree: THREE.Quaternion[] = Array.from(
    { length: 15 },
    () => new THREE.Quaternion(),
  ); // per-body world orientation in three-space, this frame

  // scratch (no per-frame allocation)
  private readonly p3: THREE.Vector3[] = Array.from({ length: 15 }, () => new THREE.Vector3());
  private readonly vWorld = new THREE.Vector3();
  private readonly vLocal = new THREE.Vector3();
  private readonly tmpU = new THREE.Vector3();
  private readonly tmpV = new THREE.Vector3();
  private readonly upT = new THREE.Vector3();
  private readonly leftT = new THREE.Vector3();
  private readonly vFoot = new THREE.Vector3(); // scratch: VRM foot bone world pos
  private readonly pQuat = new THREE.Quaternion();
  private readonly rHips = new THREE.Quaternion();
  private readonly mRest = new THREE.Matrix4();
  private readonly mTarget = new THREE.Matrix4();
  private readonly e1 = new THREE.Vector3();
  private readonly e2 = new THREE.Vector3();
  private readonly e3 = new THREE.Vector3();
  private readonly qb = new THREE.Quaternion(); // scratch body quat
  private readonly rrel = new THREE.Quaternion(); // scratch relative orientation
  private readonly drel = new THREE.Quaternion(); // scratch relative delta since calibration
  private readonly qTwist = new THREE.Quaternion(); // scratch twist rotation
  private readonly axisP = new THREE.Vector3(); // bone axis expressed in the parent-body frame
  // Isaac Z-up -> three Y-up basis change for ROTATIONS: C = Rx(-90). q_three = C q_isaac C^-1.
  private readonly cIsaacToThree = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    -Math.PI / 2,
  );
  private readonly cInv = this.cIsaacToThree.clone().invert();

  // ── Foot IK scratch (no per-frame allocation) ──
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly ikA = new THREE.Vector3(); // hip world
  private readonly ikB = new THREE.Vector3(); // knee world
  private readonly ikC = new THREE.Vector3(); // ankle world
  private readonly ikDir = new THREE.Vector3(); // hip->target unit
  private readonly ikPole = new THREE.Vector3(); // bend-plane pole (perp to dir)
  private readonly ikBdes = new THREE.Vector3(); // desired knee world
  private readonly ikTmp = new THREE.Vector3();
  private readonly ikTmp2 = new THREE.Vector3();
  private readonly ikPQuat = new THREE.Quaternion(); // parent world (inverse) for local set
  private readonly ikWorld = new THREE.Quaternion(); // bone world quat scratch
  private readonly ikDelta = new THREE.Quaternion(); // world-space swing delta

  constructor(scene: THREE.Scene, url = DEFAULT_VRM_URL, groundOffset = 0, footIK = false) {
    this.scene = scene;
    this.url = url;
    this.groundOffset = groundOffset;
    // Two-bone foot IK: plant the VRM ankle on the SOURCE foot world position (the same
    // spot the pads/pad-glow are drawn at) so shorter/differently-proportioned VRM legs
    // don't land the feet inboard of the marks. Default OFF (live ?isaacviewer keeps the
    // pure rotation retarget); the ?replaydancer showcase turns it ON.
    this.footIK = footIK;
  }

  /** Kick off async VRM load; resolves ready/failed flags. Never throws to caller. */
  async load(): Promise<void> {
    try {
      const loader = new GLTFLoader();
      loader.register(
        (parser) =>
          new VRMLoaderPlugin(parser, {
            mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser, {
              materialType: MToonNodeMaterial,
            }),
          }),
      );
      const gltf = await loader.loadAsync(this.url);
      const vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm || !vrm.humanoid) throw new Error('no VRM humanoid in ' + this.url);
      this.vrm = vrm;
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineMorphs?.(vrm);
      VRMUtils.rotateVRM0(vrm); // face +Z (VRM0 models); no-op for VRM1
      vrm.scene.traverse((o) => {
        (o as THREE.Mesh).frustumCulled = false;
      });
      // MMD→VRM Miku ships no spring bones — build skirt/hair cloth physics.
      if (!vrm.springBoneManager || vrm.springBoneManager.joints.size === 0) {
        try {
          buildClothPhysics(vrm);
        } catch {
          /* physics is optional flourish; ignore */
        }
      }
      this.bindRest();
      this.scene.add(vrm.scene);
      this.ready = true;
    } catch (err) {
      this.failed = true;
      this.error = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[isaacVrm] load failed', err);
    }
  }

  /** Capture rest-pose references from the normalized humanoid rig (identity pose). */
  private bindRest(): void {
    const vrm = this.vrm!;
    const humanoid = vrm.humanoid!;
    // list of every mapped humanoid bone (for the per-frame reset to rest)
    this.allBoneKeys = [];
    const humanBones = humanoid.humanBones as Record<string, unknown>;
    for (const key in humanBones) this.allBoneKeys.push(key as VRMHumanBoneName);

    // Rest pose: all normalized bones identity, scene at origin.
    for (const b of this.allBoneKeys) humanoid.getNormalizedBoneNode(b)?.quaternion.identity();
    vrm.scene.position.set(0, 0, 0);
    vrm.scene.quaternion.identity();
    vrm.scene.updateMatrixWorld(true);

    const node = (b: VRMHumanBoneName) => humanoid.getNormalizedBoneNode(b);
    this.hipsNode = node('hips');
    this.rUpperLeg = node('rightUpperLeg');
    this.lUpperLeg = node('leftUpperLeg');
    this.rLowerLeg = node('rightLowerLeg');
    this.lLowerLeg = node('leftLowerLeg');
    this.rFootNode = node('rightFoot');
    this.lFootNode = node('leftFoot');
    if (this.hipsNode) this.hipsNode.getWorldPosition(this.restHips);

    // Rest up axis: hips -> first existing of chest/upperChest/spine/neck (torso-ish).
    const upRef =
      node('chest') ?? node('upperChest') ?? node('spine') ?? node('neck') ?? node('head');
    if (upRef && this.hipsNode) {
      this.upRest.copy(upRef.getWorldPosition(this.tmpU)).sub(this.restHips).normalize();
    }
    // Rest lateral axis: right thigh -> left thigh.
    if (this.rUpperLeg && this.lUpperLeg) {
      this.leftRest
        .copy(this.lUpperLeg.getWorldPosition(this.tmpU))
        .sub(this.rUpperLeg.getWorldPosition(this.tmpV))
        .normalize();
    }

    // Resolve aim bones + cache each bone's rest child-direction in its local frame.
    this.resolved = [];
    for (const spec of AIM_SPECS) {
      const boneNode = node(spec.bone);
      if (!boneNode) continue;
      let childNode: THREE.Object3D | undefined;
      for (const rc of spec.rigChild) {
        const n = node(rc);
        if (n) {
          childNode = n;
          break;
        }
      }
      // Fall back to the first geometric child if no mapped humanoid child exists.
      if (!childNode) childNode = boneNode.children[0];
      if (!childNode) continue;
      const cLocal = childNode.position.clone();
      if (cLocal.lengthSq() < 1e-10) continue;
      cLocal.normalize();
      this.resolved.push({
        node: boneNode,
        parentBody: spec.parentBody,
        childBody: spec.childBody,
        cLocal,
        twistOwn: spec.twistOwn,
        twistParent: spec.twistParent,
        twist: spec.twist,
        rrel0: new THREE.Quaternion(),
      });
    }
  }

  /** Body world orientation (Isaac wxyz stored as XYZW at `off`) in three-space:
   *  q_three = C · q_isaac · C⁻¹, with C = Rx(-90). */
  private bodyQuatThree(
    quat: Float32Array,
    base4: number,
    body: number,
    out: THREE.Quaternion,
  ): void {
    const o = base4 + body * 4;
    out.set(quat[o], quat[o + 1], quat[o + 2], quat[o + 3]); // XYZW
    out.premultiply(this.cIsaacToThree).multiply(this.cInv);
  }

  /** Signed rotation angle of `dq` about unit `axis` (swing–twist twist component). */
  private twistAngle(dq: THREE.Quaternion, axis: THREE.Vector3): number {
    let w = dq.w,
      x = dq.x,
      y = dq.y,
      z = dq.z;
    if (w < 0) {
      w = -w;
      x = -x;
      y = -y;
      z = -z;
    } // shortest arc
    const d = x * axis.x + y * axis.y + z * axis.z; // vector part projected on axis
    let ang = 2 * Math.atan2(d, w);
    if (ang > Math.PI) ang -= 2 * Math.PI;
    else if (ang < -Math.PI) ang += 2 * Math.PI;
    return Math.max(-TWIST_MAX, Math.min(TWIST_MAX, ang));
  }

  /**
   * Retarget one dancer's 15 streamed body positions onto the VRM and settle it.
   * @param pos    the interpolated snapshot (Float32Array, k*15*3, Isaac world Z-up).
   * @param dancer which dancer slot in `pos`.
   * @param slotX  three-space X offset of this dancer's grid slot.
   * @param slotZ  three-space Z offset of this dancer's grid slot.
   * @param dt     seconds since last frame (for spring bone stepping).
   * @param quat   optional slerped per-body world quats (k*15*4, XYZW, Isaac Z-up)
   *               enabling the twist/facing layer; null -> swing-only.
   */
  update(
    pos: Float32Array,
    dancer: number,
    slotX: number,
    slotZ: number,
    dt: number,
    quat: Float32Array | null = null,
  ): void {
    if (!this.ready || !this.vrm) return;
    const vrm = this.vrm;
    const humanoid = vrm.humanoid!;
    const base = dancer * 15 * 3;
    if (base + 15 * 3 > pos.length) return;
    const base4 = dancer * 15 * 4;
    const hasQuat = !!quat && base4 + 15 * 4 <= quat.length;

    // 1) Unpack the 15 joints into three-space, offset onto the grid slot (x,z only).
    for (let j = 0; j < 15; j++) {
      const o = base + j * 3;
      isaacToThree(pos[o], pos[o + 1], pos[o + 2], this.p3[j]);
      this.p3[j].x += slotX;
      this.p3[j].z += slotZ;
    }
    // 1b) Per-body world orientations (three-space) for the quat-driven twist/facing.
    if (hasQuat) {
      for (let j = 0; j < 15; j++) this.bodyQuatThree(quat!, base4, j, this.qThree[j]);
    }

    // 2) Reset every mapped bone to rest so undriven bones (fingers, feet, shoulders,
    //    chest, toes) hold a clean rest pose instead of last frame's aim.
    for (const b of this.allBoneKeys) humanoid.getNormalizedBoneNode(b)?.quaternion.identity();

    // 3) Root: stand the avatar so its hips match the streamed pelvis (matches the
    //    capsule pelvis exactly in x/z/height); feet land near the ground.
    const pelvis = this.p3[B_PELVIS];
    // p3 already includes the slot offset; restHips carries no slot. Place the scene so
    // hipsWorld = pelvis: hipsWorld = scene.pos + restHips (rig-local rest offset). The
    // grounding pass (step 7) may drop baseHipY by a smoothed correction so her feet
    // land where the source's planted foot is instead of floating on shorter legs.
    const baseHipY = pelvis.y - this.restHips.y + this.groundOffset;
    vrm.scene.position.set(pelvis.x - this.restHips.x, baseHipY, pelvis.z - this.restHips.z);

    // 4) Hips orientation. Base = a two-axis position basis (up = pelvis->torso,
    //    left = R->L thigh). This already turns with the body, but the thigh axis gets
    //    short/noisy when the legs close during a spin. So when quats are available we
    //    take the pelvis's FULL world orientation (clean facing through turns) via a
    //    constant body->bone offset O_hips calibrated ONCE off the position basis.
    this.upT.copy(this.p3[B_TORSO]).sub(pelvis);
    this.leftT.copy(this.p3[B_L_THIGH]).sub(this.p3[B_R_THIGH]);
    const basisValid = this.upT.lengthSq() > 1e-8 && this.leftT.lengthSq() > 1e-8;
    if (basisValid) {
      this.basis(this.mRest, this.upRest, this.leftRest);
      this.basis(this.mTarget, this.upT.normalize(), this.leftT.normalize());
      this.mRest.transpose();
      this.mTarget.multiply(this.mRest); // R_basis = Mtarget * Mrest^T
      this.rHips.setFromRotationMatrix(this.mTarget);
    }
    // Calibrate the constant offsets on the first stable quat frame.
    if (hasQuat && !this.calibrated && basisValid) {
      this.oHips.copy(this.rHips).multiply(this.qb.copy(this.qThree[B_PELVIS]).invert());
      for (const r of this.resolved) {
        // reference relative orientation: parent^-1 * own
        r.rrel0
          .copy(this.qb.copy(this.qThree[r.twistParent]).invert())
          .multiply(this.qThree[r.twistOwn]);
      }
      this.calibrated = true;
    }
    if (basisValid || (hasQuat && this.calibrated)) {
      // hips world orientation: quat path when calibrated, else the position basis.
      if (hasQuat && this.calibrated) this.rHips.copy(this.oHips).multiply(this.qThree[B_PELVIS]);
      const hips = this.hipsNode;
      if (hips) {
        hips.parent?.getWorldQuaternion(this.pQuat);
        this.pQuat.invert(); // local = parentWorld^-1 * R_world
        hips.quaternion.copy(this.pQuat).multiply(this.rHips);
      }
    }
    vrm.scene.updateMatrixWorld(true);

    // 5) Aim each limb/spine bone toward its child joint (position swing), then ADD the
    //    axial twist from the quats (child-vs-parent relative roll, referenced to the
    //    calibration frame — cancels whole-body yaw so a limb never candy-wraps).
    const doTwist = hasQuat && this.calibrated;
    for (const r of this.resolved) {
      this.vWorld.copy(this.p3[r.childBody]).sub(this.p3[r.parentBody]);
      if (this.vWorld.lengthSq() < 1e-10) continue;
      this.vWorld.normalize();
      // swing: local q = fromUnitVectors(cLocal, parentWorld^-1 * v)
      r.node.parent?.getWorldQuaternion(this.pQuat);
      this.pQuat.invert();
      this.vLocal.copy(this.vWorld).applyQuaternion(this.pQuat);
      r.node.quaternion.setFromUnitVectors(r.cLocal, this.vLocal);
      // twist: rotate the bone about its own long axis by the tracked roll change
      if (doTwist && r.twist) {
        this.qb.copy(this.qThree[r.twistParent]).invert(); // parent^-1 (reused below)
        this.rrel.copy(this.qb).multiply(this.qThree[r.twistOwn]); // parent^-1 * own
        this.drel.copy(this.rrel).multiply(this.qTwist.copy(r.rrel0).invert()); // Δ since ref
        this.axisP.copy(this.vWorld).applyQuaternion(this.qb).normalize(); // axis in parent frame
        const theta = this.twistAngle(this.drel, this.axisP);
        this.qTwist.setFromAxisAngle(r.cLocal, theta);
        r.node.quaternion.multiply(this.qTwist); // post-multiply = pure twist about the bone axis
      }
      r.node.updateWorldMatrix(false, false); // so this bone's child reads a fresh parent world
    }

    // 6) Settle: normalized rig -> raw bones, world matrices.
    humanoid.update();
    vrm.scene.updateMatrixWorld(true);

    // 7) Foot grounding. With the hips still at the raw streamed height (baseHipY), the
    //    VRM's lowest foot bone sits at `vrmFootY`. Determine which source foot is
    //    planted from the STREAMED foot heights (three-space y == Isaac z, in metres):
    //      - at least one planted -> drop the hips so that lowest VRM foot lands where
    //        the source's lower (planted) foot is (matches the capsule foot exactly).
    //      - both feet clearly airborne (hop) -> target 0, preserving the pelvis height
    //        so jumps still read.
    //      - in between -> hold the last target (no pop across the transition).
    //    Smoothed with a ~100 ms lerp and clamped to +-GROUND_MAX.
    if (this.rFootNode && this.lFootNode) {
      const srcFootR = this.p3[B_R_FOOT].y;
      const srcFootL = this.p3[B_L_FOOT].y;
      const srcMinFoot = Math.min(srcFootR, srcFootL);
      const vrmFootY = Math.min(
        this.rFootNode.getWorldPosition(this.vFoot).y,
        this.lFootNode.getWorldPosition(this.vFoot).y,
      );
      if (srcMinFoot < PLANT_H) {
        // planted: lowest VRM foot -> source planted foot height (correction is a
        // vertical hip delta, and vrmFootY was measured at baseHipY with corr = 0)
        this.groundTargetCorr = Math.max(-GROUND_MAX, Math.min(GROUND_MAX, srcMinFoot - vrmFootY));
      } else if (srcMinFoot > HOP_H) {
        this.groundTargetCorr = 0; // clear hop: keep the streamed pelvis height
      }
      // else: transitional band -> keep the previous target, just keep lerping to it.
      const a = 1 - Math.exp(-Math.max(dt, 0) / GROUND_TAU);
      this.groundCorr += (this.groundTargetCorr - this.groundCorr) * a;
      vrm.scene.position.y = baseHipY + this.groundCorr;
      vrm.scene.updateMatrixWorld(true);
    }

    // 7.5) Foot IK (opt-in). The rotation retarget copies the source JOINT ANGLES, so
    //      Miku's shorter legs — adopting those angles — land her feet INBOARD of the true
    //      Isaac foot positions, while the pads + pad-glow are drawn at the real source foot
    //      spots. Solve a two-bone analytic IK per leg so the ANKLE reaches the source foot
    //      world position (this.p3[foot], identical to the pad target), preserving the
    //      retargeted knee-bend plane as the pole. Runs AFTER grounding (which set a hip
    //      height the shorter legs can reach) and re-syncs raw bones below.
    if (
      this.footIK &&
      this.rUpperLeg &&
      this.rLowerLeg &&
      this.rFootNode &&
      this.lUpperLeg &&
      this.lLowerLeg &&
      this.lFootNode
    ) {
      const plantR = this.p3[B_R_FOOT].y < PLANT_H;
      const plantL = this.p3[B_L_FOOT].y < PLANT_H;
      this.solveLegIK(this.rUpperLeg, this.rLowerLeg, this.rFootNode, this.p3[B_R_FOOT], plantR);
      this.solveLegIK(this.lUpperLeg, this.lLowerLeg, this.lFootNode, this.p3[B_L_FOOT], plantL);
      // propagate the normalized-bone edits to the raw skeleton + world matrices
      humanoid.update();
      vrm.scene.updateMatrixWorld(true);
    }

    // 8) Cloth/eyes settle at the final grounded position.
    const step = Math.min(Math.max(dt, 1 / 240), 1 / 30);
    vrm.lookAt?.update(step);
    vrm.expressionManager?.update();
    vrm.springBoneManager?.update(step);
  }

  /** Set a bone node's LOCAL quaternion so its WORLD orientation equals `worldQ`
   *  (parent world matrices must be current). */
  private setWorldQuat(node: THREE.Object3D, worldQ: THREE.Quaternion): void {
    if (node.parent) {
      node.parent.getWorldQuaternion(this.ikPQuat).invert();
      node.quaternion.copy(this.ikPQuat).multiply(worldQ);
    } else {
      node.quaternion.copy(worldQ);
    }
  }

  /**
   * Analytic two-bone IK for one leg: rotate the thigh (hip) then shin (knee) so the
   * ANKLE reaches `target` (world). Sign-safe: bones are AIMED at reconstructed target
   * points via minimal-arc rotations, so the knee can't pop backward. The bend PLANE is
   * taken from the current (retargeted) knee position — the pole — so the existing hinge
   * direction is preserved. Over-extension (target beyond thigh+shin) is CLAMPED to max
   * reach (foot as close as the leg allows) instead of snapping.
   *
   * Operates on the normalized humanoid nodes; caller runs humanoid.update() afterward.
   */
  private solveLegIK(
    hip: THREE.Object3D,
    knee: THREE.Object3D,
    ankle: THREE.Object3D,
    target: THREE.Vector3,
    plantFoot: boolean,
  ): void {
    hip.getWorldPosition(this.ikA);
    knee.getWorldPosition(this.ikB);
    ankle.getWorldPosition(this.ikC);
    const L1 = this.ikA.distanceTo(this.ikB); // thigh length (rigid)
    const L2 = this.ikB.distanceTo(this.ikC); // shin length (rigid)
    if (L1 < 1e-5 || L2 < 1e-5) return;

    this.ikDir.copy(target).sub(this.ikA);
    const dist = this.ikDir.length();
    if (dist < 1e-5) return;
    this.ikDir.multiplyScalar(1 / dist); // hip -> target, unit
    // clamp reach: never fully straighten (avoids a degenerate plane) and never over-extend
    const maxReach = (L1 + L2) * 0.999;
    const minReach = Math.abs(L1 - L2) * 1.001 + 1e-4;
    const cd = Math.min(maxReach, Math.max(minReach, dist)); // reachable hip->ankle distance

    // pole = the current knee's offset perpendicular to the hip->target line (retargeted
    // bend plane). Degenerate (leg dead-straight) -> a stable forward-ish fallback.
    this.ikPole.copy(this.ikB).sub(this.ikA);
    this.ikPole.addScaledVector(this.ikDir, -this.ikPole.dot(this.ikDir));
    if (this.ikPole.lengthSq() < 1e-8) {
      this.ikPole.set(0, 0, 1).addScaledVector(this.ikDir, -this.ikDir.z);
      if (this.ikPole.lengthSq() < 1e-8) this.ikPole.set(1, 0, 0);
    }
    this.ikPole.normalize();

    // desired knee position: law of cosines for the hip interior angle, placed in the
    // (dir, pole) plane at thigh length L1.
    const cosHip = Math.min(1, Math.max(-1, (L1 * L1 + cd * cd - L2 * L2) / (2 * L1 * cd)));
    const sinHip = Math.sqrt(Math.max(0, 1 - cosHip * cosHip));
    this.ikBdes
      .copy(this.ikA)
      .addScaledVector(this.ikDir, L1 * cosHip)
      .addScaledVector(this.ikPole, L1 * sinHip);

    // 1) aim the thigh: map current (knee-A) to desired (Bdes-A) as a world-space swing.
    this.ikTmp.copy(this.ikB).sub(this.ikA).normalize();
    this.ikTmp2.copy(this.ikBdes).sub(this.ikA).normalize();
    this.ikDelta.setFromUnitVectors(this.ikTmp, this.ikTmp2);
    hip.getWorldQuaternion(this.ikWorld);
    this.ikWorld.premultiply(this.ikDelta);
    this.setWorldQuat(hip, this.ikWorld);
    hip.updateWorldMatrix(false, true); // refresh knee/ankle world under the new thigh

    // 2) aim the shin: map current (ankle-knee) to (footTarget-knee). footTarget is the
    //    reachable ankle point along dir at distance cd (== target unless over-extended).
    knee.getWorldPosition(this.ikB);
    ankle.getWorldPosition(this.ikC);
    this.ikTmp2.copy(this.ikA).addScaledVector(this.ikDir, cd); // reachable foot point
    this.ikTmp.copy(this.ikC).sub(this.ikB).normalize();
    this.ikTmp2.sub(this.ikB).normalize();
    this.ikDelta.setFromUnitVectors(this.ikTmp, this.ikTmp2);
    knee.getWorldQuaternion(this.ikWorld);
    this.ikWorld.premultiply(this.ikDelta);
    this.setWorldQuat(knee, this.ikWorld);
    knee.updateWorldMatrix(false, true);

    // 3) foot orientation: a PLANTED foot is levelled so the sole stays flat to the floor
    //    (yaw preserved from the leg) instead of stabbing into the pad at an angle. An
    //    airborne foot keeps whatever the shin gives it.
    if (plantFoot) {
      ankle.getWorldQuaternion(this.ikWorld);
      this.ikTmp.set(0, 0, 1).applyQuaternion(this.ikWorld); // foot forward (rest +Z -> toes)
      const yaw = Math.atan2(this.ikTmp.x, this.ikTmp.z);
      this.ikWorld.setFromAxisAngle(this.worldUp, yaw);
      this.setWorldQuat(ankle, this.ikWorld);
      ankle.updateWorldMatrix(false, true);
    }
  }

  /** Build an orthonormal basis matrix from (u = first axis, v = in-plane hint). */
  private basis(out: THREE.Matrix4, u: THREE.Vector3, v: THREE.Vector3): void {
    this.e1.copy(u).normalize();
    this.e2.copy(v).addScaledVector(this.e1, -this.e1.dot(v)).normalize();
    this.e3.copy(this.e1).cross(this.e2);
    out.makeBasis(this.e1, this.e2, this.e3);
  }

  dispose(): void {
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      try {
        VRMUtils.deepDispose(this.vrm.scene);
      } catch {
        /* ignore */
      }
      this.vrm = null;
    }
    this.ready = false;
  }
}
