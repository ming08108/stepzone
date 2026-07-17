/**
 * PhysRig — a physically simulated humanoid: 14 rigid bodies with biomechanical
 * mass distribution, joined by ball/hinge joints, actuated ONLY by "muscles"
 * (PD torque motors with per-joint strength limits). Nothing kinematic ever
 * touches the simulated pose: gravity, ground contact, momentum and muscle
 * torques are the sole authors of motion. A controller (src/phys/controller.ts)
 * decides what the muscles *try* to do; whether the body actually does it is
 * physics.
 *
 * This is a from-scratch implementation, deliberately independent of the
 * animation-driven dancer in src/render/threeDancer.ts.
 *
 * Engine: Rapier (@dimforge/rapier3d-compat — WASM inlined, no bundler plugin).
 * Frames: world is three.js right-handed Y-up metres; the character faces +Z
 * (toward the viewer) at rest, feet on the y=0 floor.
 */
import * as THREE from 'three/webgpu';
import type RAPIER_API from '@dimforge/rapier3d-compat';

type RAPIER = typeof RAPIER_API;
type World = RAPIER_API.World;
type RigidBody = RAPIER_API.RigidBody;

export interface RigPoint {
  x: number;
  y: number;
  z: number;
}

/** Anatomical landmarks of the character at rest (world space, facing +Z,
 *  feet on the floor). Side arrays are [left, right] in MODEL terms. */
export interface RigSkeleton {
  hips: RigPoint; // pelvis centre
  spine: RigPoint; // pelvis→abdomen joint
  chest: RigPoint; // abdomen→thorax joint
  neck: RigPoint; // thorax→head joint
  headTop: RigPoint; // crown (sizes the head collider)
  shoulder: [RigPoint, RigPoint];
  elbow: [RigPoint, RigPoint];
  wrist: [RigPoint, RigPoint];
  hipSocket: [RigPoint, RigPoint];
  knee: [RigPoint, RigPoint];
  ankle: [RigPoint, RigPoint];
  toe: [RigPoint, RigPoint]; // forward extent of each foot
}

export type BodyName =
  | 'pelvis'
  | 'abdomen'
  | 'thorax'
  | 'head'
  | 'uarmL'
  | 'uarmR'
  | 'farmL'
  | 'farmR'
  | 'thighL'
  | 'thighR'
  | 'shinL'
  | 'shinR'
  | 'hindfootL'
  | 'hindfootR'
  | 'footL'
  | 'footR';

export type JointName =
  | 'waist'
  | 'upperBack'
  | 'neckJ'
  | 'shoulderL'
  | 'shoulderR'
  | 'elbowL'
  | 'elbowR'
  | 'hipL'
  | 'hipR'
  | 'kneeL'
  | 'kneeR'
  | 'ankleL'
  | 'ankleR'
  | 'ankleRollL'
  | 'ankleRollR';

/** How a muscle interprets its target quaternion:
 *  - 'local': child orientation relative to parent (the normal case).
 *  - 'worldChild': absolute world orientation for the CHILD body (used for
 *    foot-flat and swing-leg targets, so they don't inherit pelvis wobble).
 *  - 'worldParent': absolute world orientation for the PARENT body — the
 *    SIMBICON torso trick: the stance hip rights the pelvis in world frame,
 *    with the reaction pushing on the stance thigh. Still an internal torque.
 */
export type MuscleFrame = 'local' | 'worldChild' | 'worldParent';

export interface JointTarget {
  q: THREE.Quaternion;
  frame: MuscleFrame;
  /** Optional per-tick gain scale (soft limbs during flight etc.). */
  kpScale?: number;
  /** Hinge joints (knee/elbow) take a plain angle — it drives the engine's
   *  IMPLICIT motor, which is unconditionally stable at high stiffness. */
  angle?: number;
  /** Direct world-frame torque (Nm) instead of a PD servo — the ankle balance
   *  strategy uses this: torque computed from the (slow, heavy) CoM signal is
   *  stable feedback, where a stiff servo on the near-massless foot is not. */
  torque?: { x: number; y: number; z: number };
}

/** A joint may pursue several goals at once (e.g. the stance hip rights the
 *  pelvis AND keeps the thigh aimed at the planted ankle); their torques sum
 *  and the single strength clamp applies to the total. */
export type PoseTargets = Map<JointName, JointTarget[]>;

interface MuscleSpec {
  kp: number; // Nm/rad — proportional gain
  kd: number; // Nm·s/rad — damping
  maxNm: number; // strength: the muscle can never exceed this torque
}

interface JointDef {
  name: JointName;
  parent: BodyName;
  child: BodyName;
  anchor: THREE.Vector3; // world at rest
  muscle: MuscleSpec;
  /** Hinge joints (knee/elbow) get a hard mechanical limit — hyperextension
   *  must be impossible no matter what the muscles do. */
  hinge?: { axis: THREE.Vector3; min: number; max: number };
  /** Explicit-PD gains capped by distal inertia so the servo stays below the
   *  integrator's stable frequency — uncapped gains on a light free limb
   *  literally explode the sim. Hinges don't use these (implicit motors). */
  capKp?: number;
  capKd?: number;
  /** The engine joint (hinges drive their implicit motor through it). */
  impulse?: RAPIER_API.ImpulseJoint;
}

/** Per-segment mass fractions (de Leva 1996 anthropometry, hand merged into
 *  forearm, trunk split pelvis/abdomen/thorax). Normalised at build. */
const MASS_FRAC: Record<BodyName, number> = {
  pelvis: 0.112,
  abdomen: 0.16,
  thorax: 0.16,
  head: 0.08,
  uarmL: 0.027,
  uarmR: 0.027,
  farmL: 0.022,
  farmR: 0.022,
  thighL: 0.142,
  thighR: 0.142,
  shinL: 0.043,
  shinR: 0.043,
  // The hindfoot is the ankle's linkage body (pitch hinge meets roll hinge);
  // it carries a real share of foot mass so the solver can transmit ankle
  // torque through it.
  hindfootL: 0.006,
  hindfootR: 0.006,
  footL: 0.008,
  footR: 0.008,
};

/** Muscle strength table, Nm for a 70 kg human (rough physiological maxima —
 *  hips and knees are the powerhouse, ankles strong, arms modest). Scaled by
 *  actual body mass at build. Gains are stiff enough to track a dance but the
 *  clamp keeps everything inside human capability. */
const MUSCLES: Record<JointName, MuscleSpec> = {
  waist: { kp: 900, kd: 90, maxNm: 220 },
  upperBack: { kp: 700, kd: 70, maxNm: 160 },
  neckJ: { kp: 90, kd: 12, maxNm: 40 },
  shoulderL: { kp: 350, kd: 35, maxNm: 110 },
  shoulderR: { kp: 350, kd: 35, maxNm: 110 },
  elbowL: { kp: 250, kd: 25, maxNm: 60 },
  elbowR: { kp: 250, kd: 25, maxNm: 60 },
  hipL: { kp: 1100, kd: 110, maxNm: 290 },
  hipR: { kp: 1100, kd: 110, maxNm: 290 },
  kneeL: { kp: 900, kd: 90, maxNm: 260 },
  kneeR: { kp: 900, kd: 90, maxNm: 260 },
  ankleL: { kp: 450, kd: 40, maxNm: 160 },
  ankleR: { kp: 450, kd: 40, maxNm: 160 },
  ankleRollL: { kp: 300, kd: 25, maxNm: 100 },
  ankleRollR: { kp: 300, kd: 25, maxNm: 100 },
};

/** Rapier's ForceBased motor stiffness is not plain Nm/rad — calibrated
 *  against a 40 kg inverted pendulum, ~10× the nominal gain produces the
 *  intended holding torque at 240 Hz. Strength limits are enforced by
 *  clamping the commanded error (see applyMuscles), not by the motor. */
const MOTOR_SCALE = 10;

const V = (p: RigPoint) => new THREE.Vector3(p.x, p.y, p.z);

export interface RigStateFoot {
  pos: THREE.Vector3; // ankle-ish body centre
  contact: boolean; // touching the floor this step
}

/** Read-back the controller sees each tick. */
export interface RigState {
  com: THREE.Vector3;
  comVel: THREE.Vector3;
  pelvisPos: THREE.Vector3;
  pelvisVel: THREE.Vector3;
  pelvisQ: THREE.Quaternion;
  feet: [RigStateFoot, RigStateFoot]; // [left, right]
  footQ: [THREE.Quaternion, THREE.Quaternion];
  /** Measured world pitch of each shin (rotation about +x; >0 = leaning
   *  forward). The ankle keeps the foot flat against the REAL tilt. */
  shinPitch: [number, number];
  /** Y-component of the THORAX's up vector — the stability signal. (The
   *  pelvis rides tilted under dance loads by design; the trunk is what is
   *  servoed world-upright, so its tilt means genuine trouble.) */
  thoraxUp: number;
}

export interface PhysRigOpts {
  /** Total body mass, kg. Anime-avatar default. */
  massKg?: number;
  /** Global muscle strength scale (1 = human). */
  muscleScale?: number;
}

export class PhysRig {
  readonly world: World;
  private readonly R: RAPIER;
  readonly bodies = new Map<BodyName, RigidBody>();
  private readonly joints: JointDef[] = [];
  private readonly jointByName = new Map<JointName, JointDef>();
  /** Rest world positions of body origins (= segment centres at build). */
  private readonly restCentre = new Map<BodyName, THREE.Vector3>();
  readonly massKg: number;
  muscleScale: number;
  /** Foot contact flags refreshed after each step. */
  private footContact: [boolean, boolean] = [true, true];
  /** Sustained contact (planted): contact held for ≥0.1 s. Gating the full
   *  muscle gains on SUSTAINED contact keeps a bouncing/landing foot on the
   *  soft capped gains — a natural landing absorb — and prevents gain
   *  flapping from contact flicker. */
  private footPlanted: [boolean, boolean] = [true, true];
  private contactRun: [number, number] = [999, 999];
  private readonly footHalf = { x: 0.045, y: 0.035, z: 0.11 };
  /** Ankle position in each foot body's local frame (the foot box centre
   *  sits ahead of the ankle — state readouts report the ankle itself). */
  private readonly ankleLocal: [THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  readonly legLen: number;
  readonly hipHeight: number;
  readonly skel: RigSkeleton;

  // scratch
  private readonly _q1 = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _q3 = new THREE.Quaternion();
  private readonly _v1 = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();
  private readonly _v3 = new THREE.Vector3();

  constructor(R: RAPIER, skel: RigSkeleton, opts: PhysRigOpts = {}) {
    this.R = R;
    this.skel = skel;
    this.massKg = opts.massKg ?? 46;
    this.muscleScale = opts.muscleScale ?? 1;
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    // 480 Hz: stiff muscles on light limbs + torque propagation through the
    // leg chain both demand a fine step (240 Hz leaves the solver visibly
    // under-converged: strong motors read as weak).
    this.world.timestep = 1 / 480;
    // Extra solver iterations: ankle torque must transmit through the light
    // hindfoot linkage and up the leg chain into the heavy trunk — with the
    // default 4 the impulse propagation never converges and strong motors
    // read as weak.
    this.world.numSolverIterations = 48;

    // Floor — one big static slab, high friction like a dance pad.
    const groundDesc = R.RigidBodyDesc.fixed().setTranslation(0, -0.1, 0);
    const ground = this.world.createRigidBody(groundDesc);
    this.world
      .createCollider(R.ColliderDesc.cuboid(20, 0.1, 20).setFriction(0.95), ground)
      .setRestitution(0.0);

    const ankleL = V(skel.ankle[0]);
    const kneeL = V(skel.knee[0]);
    const hipL = V(skel.hipSocket[0]);
    this.legLen = hipL.distanceTo(kneeL) + kneeL.distanceTo(ankleL);
    this.hipHeight = (skel.hipSocket[0].y + skel.hipSocket[1].y) / 2;
    this.pelvisRestY = skel.hips.y;

    this.build();
  }

  // ---------------------------------------------------------------- build

  private capsuleBody(
    name: BodyName,
    a: THREE.Vector3,
    b: THREE.Vector3,
    radius: number,
    frac: number,
    fracNorm: number,
  ): void {
    const R = this.R;
    const centre = a.clone().add(b).multiplyScalar(0.5);
    const dir = b.clone().sub(a);
    const len = Math.max(0.02, dir.length() - 2 * radius);
    // Bodies are created with IDENTITY rotation — the capsule is rotated
    // inside the collider instead. That makes body rotation == world-frame
    // segment rotation, which keeps the VRM write-back a one-liner.
    const q = this._q1.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(centre.x, centre.y, centre.z)
      .setLinearDamping(0.02)
      .setAngularDamping(0.05);
    const body = this.world.createRigidBody(desc);
    const col = R.ColliderDesc.capsule(len / 2, radius)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setFriction(0.7)
      .setMass((this.massKg * frac) / fracNorm);
    this.world.createCollider(col, body);
    this.bodies.set(name, body);
    this.restCentre.set(name, centre);
  }

  private cuboidBody(
    name: BodyName,
    centre: THREE.Vector3,
    hx: number,
    hy: number,
    hz: number,
    frac: number,
    fracNorm: number,
    friction = 0.7,
  ): void {
    const R = this.R;
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(centre.x, centre.y, centre.z)
      .setLinearDamping(0.02)
      .setAngularDamping(0.05);
    const body = this.world.createRigidBody(desc);
    const col = R.ColliderDesc.cuboid(hx, hy, hz)
      .setFriction(friction)
      .setMass((this.massKg * frac) / fracNorm);
    this.world.createCollider(col, body);
    this.bodies.set(name, body);
    this.restCentre.set(name, centre);
  }

  private build(): void {
    const s = this.skel;
    const fracNorm = Object.values(MASS_FRAC).reduce((a, b) => a + b, 0);
    const hips = V(s.hips);
    const spine = V(s.spine);
    const chest = V(s.chest);
    const neck = V(s.neck);
    const headTop = V(s.headTop);
    // Radii scale with the character so tiny/huge avatars still work.
    const scale = this.legLen / 0.72;
    const r = (base: number) => base * scale;

    // Trunk + head.
    const hipSpread = V(s.hipSocket[0]).distanceTo(V(s.hipSocket[1]));
    this.cuboidBody(
      'pelvis',
      hips,
      hipSpread / 2 + r(0.06),
      r(0.085),
      r(0.075),
      MASS_FRAC.pelvis,
      fracNorm,
    );
    this.capsuleBody('abdomen', spine, chest, r(0.075), MASS_FRAC.abdomen, fracNorm);
    this.capsuleBody('thorax', chest, neck, r(0.085), MASS_FRAC.thorax, fracNorm);
    const headC = neck.clone().lerp(headTop, 0.55);
    const headR = Math.max(0.06, (headTop.y - neck.y) * 0.42);
    this.cuboidBody('head', headC, headR * 0.8, headR, headR * 0.85, MASS_FRAC.head, fracNorm);

    // Limbs (side 0 = model left, 1 = model right).
    for (let side = 0 as 0 | 1; side <= 1; side++) {
      const S = side === 0 ? 'L' : 'R';
      this.capsuleBody(
        `uarm${S}` as BodyName,
        V(s.shoulder[side]),
        V(s.elbow[side]),
        r(0.04),
        MASS_FRAC.uarmL,
        fracNorm,
      );
      // Hand is merged into the forearm segment (a touch longer than the wrist).
      const wristPlus = V(s.wrist[side]).lerp(
        V(s.wrist[side]).clone().sub(V(s.elbow[side])).multiplyScalar(1.35).add(V(s.elbow[side])),
        1,
      );
      this.capsuleBody(
        `farm${S}` as BodyName,
        V(s.elbow[side]),
        wristPlus,
        r(0.035),
        MASS_FRAC.farmL,
        fracNorm,
      );
      this.capsuleBody(
        `thigh${S}` as BodyName,
        V(s.hipSocket[side]),
        V(s.knee[side]),
        r(0.062),
        MASS_FRAC.thighL,
        fracNorm,
      );
      this.capsuleBody(
        `shin${S}` as BodyName,
        V(s.knee[side]),
        V(s.ankle[side]),
        r(0.048),
        MASS_FRAC.shinL,
        fracNorm,
      );
      // Foot: a friction-heavy box from behind the heel to the toes.
      const ankle = V(s.ankle[side]);
      const toe = V(s.toe[side]);
      // A real heel: ~7 cm behind the ankle. Backward balance authority is
      // proportional to this lever — with a stubby heel the ankle cannot
      // stop even a slow backward drift.
      const footLen = Math.max(0.16, toe.z - ankle.z + 0.1);
      this.footHalf.z = footLen / 2;
      this.footHalf.y = Math.max(0.02, ankle.y / 2);
      this.footHalf.x = r(0.045);
      const footC = new THREE.Vector3(ankle.x, ankle.y / 2, ankle.z + footLen / 2 - 0.07);
      this.ankleLocal[side].copy(ankle).sub(footC);
      this.cuboidBody(
        `foot${S}` as BodyName,
        footC,
        this.footHalf.x,
        this.footHalf.y,
        this.footHalf.z,
        MASS_FRAC.footL,
        fracNorm,
        0.95,
      );
      this.bodies.get(`foot${S}` as BodyName)!.enableCcd(true);
      // Hindfoot: the linkage body letting the ankle be TWO stacked hinges
      // (pitch then roll) driven by the engine's implicit motors — the only
      // actuation that is BOTH stable and strong on a body this light (an
      // explicit servo strong enough to balance kicks the foot airborne).
      {
        const desc = this.R.RigidBodyDesc.dynamic()
          .setTranslation(ankle.x, ankle.y, ankle.z)
          .setLinearDamping(0.02)
          .setAngularDamping(0.05);
        const body = this.world.createRigidBody(desc);
        const col = this.R.ColliderDesc.ball(0.02)
          .setFriction(0.5)
          .setMass((this.massKg * MASS_FRAC.hindfootL) / fracNorm);
        this.world.createCollider(col, body);
        this.bodies.set(`hindfoot${S}` as BodyName, body);
        this.restCentre.set(`hindfoot${S}` as BodyName, ankle.clone());
      }
    }

    // Joints. Elbow/knee are true hinges with hard limits (hyperextension is
    // mechanically impossible); everything else is a ball joint whose range is
    // governed by muscle targets.
    const X = new THREE.Vector3(1, 0, 0);
    const defs: JointDef[] = [
      { name: 'waist', parent: 'pelvis', child: 'abdomen', anchor: spine, muscle: MUSCLES.waist },
      {
        name: 'upperBack',
        parent: 'abdomen',
        child: 'thorax',
        anchor: chest,
        muscle: MUSCLES.upperBack,
      },
      { name: 'neckJ', parent: 'thorax', child: 'head', anchor: neck, muscle: MUSCLES.neckJ },
    ];
    for (let side = 0 as 0 | 1; side <= 1; side++) {
      const S = side === 0 ? 'L' : 'R';
      const armDir = V(s.elbow[side]).sub(V(s.shoulder[side])).normalize();
      // Elbow flexion axis: perpendicular to the arm, so the forearm swings
      // forward (T-pose arms along ±x → axis ∓y).
      const elbowAxis = armDir
        .clone()
        .cross(new THREE.Vector3(0, 0, 1))
        .normalize();
      if (elbowAxis.lengthSq() < 0.1) elbowAxis.set(0, -1, 0);
      defs.push(
        {
          name: `shoulder${S}` as JointName,
          parent: 'thorax',
          child: `uarm${S}` as BodyName,
          anchor: V(s.shoulder[side]),
          muscle: MUSCLES.shoulderL,
        },
        {
          name: `elbow${S}` as JointName,
          parent: `uarm${S}` as BodyName,
          child: `farm${S}` as BodyName,
          anchor: V(s.elbow[side]),
          muscle: MUSCLES.elbowL,
          hinge: { axis: elbowAxis, min: 0.0, max: 2.5 },
        },
        {
          name: `hip${S}` as JointName,
          parent: 'pelvis',
          child: `thigh${S}` as BodyName,
          anchor: V(s.hipSocket[side]),
          muscle: MUSCLES.hipL,
        },
        {
          // Knee flexion is a positive rotation about +x (shin swings back).
          name: `knee${S}` as JointName,
          parent: `thigh${S}` as BodyName,
          child: `shin${S}` as BodyName,
          anchor: V(s.knee[side]),
          muscle: MUSCLES.kneeL,
          hinge: { axis: X, min: 0.0, max: 2.5 },
        },
        {
          // Ankle pitch (plantar/dorsi-flexion): +angle presses the toes.
          name: `ankle${S}` as JointName,
          parent: `shin${S}` as BodyName,
          child: `hindfoot${S}` as BodyName,
          anchor: V(s.ankle[side]),
          muscle: MUSCLES.ankleL,
          hinge: { axis: X, min: -1.0, max: 0.9 },
        },
        {
          // Ankle roll (inversion/eversion): +angle lifts the +x edge.
          name: `ankleRoll${S}` as JointName,
          parent: `hindfoot${S}` as BodyName,
          child: `foot${S}` as BodyName,
          anchor: V(s.ankle[side]),
          muscle: MUSCLES.ankleRollL,
          hinge: { axis: new THREE.Vector3(0, 0, 1), min: -0.6, max: 0.6 },
        },
      );
    }

    const R = this.R;
    for (const d of defs) {
      const p = this.bodies.get(d.parent)!;
      const c = this.bodies.get(d.child)!;
      const pa = d.anchor.clone().sub(this.restCentre.get(d.parent)!);
      const ca = d.anchor.clone().sub(this.restCentre.get(d.child)!);
      let jd: RAPIER_API.JointData;
      if (d.hinge) {
        jd = R.JointData.revolute(
          { x: pa.x, y: pa.y, z: pa.z },
          { x: ca.x, y: ca.y, z: ca.z },
          { x: d.hinge.axis.x, y: d.hinge.axis.y, z: d.hinge.axis.z },
        );
        jd.limitsEnabled = true;
        jd.limits = [d.hinge.min, d.hinge.max];
      } else {
        jd = R.JointData.spherical({ x: pa.x, y: pa.y, z: pa.z }, { x: ca.x, y: ca.y, z: ca.z });
      }
      // Linked segments overlap at the joint — never collide them.
      const joint = this.world.createImpulseJoint(jd, p, c, true);
      (joint as { setContactsEnabled?: (b: boolean) => void }).setContactsEnabled?.(false);
      d.impulse = joint;
      if (d.hinge) {
        (joint as RAPIER_API.RevoluteImpulseJoint).configureMotorModel(R.MotorModel.ForceBased);
      }
      this.joints.push(d);
      this.jointByName.set(d.name, d);
    }

    // Explicit-PD gain caps for the ball joints. An explicit servo is only
    // stable while its natural frequency stays well under the substep rate;
    // uncapped gains on a light limb ring at hundreds of rad/s and detonate
    // the sim. Cap by the inertia of everything distal to the joint
    // (approximated from rest geometry).
    const children = new Map<BodyName, BodyName[]>();
    for (const d of defs) {
      const arr = children.get(d.parent) ?? [];
      arr.push(d.child);
      children.set(d.parent, arr);
    }
    const OMEGA_MAX = 45; // rad/s — safe servo frequency at 240 Hz
    const h = this.world.timestep;
    for (const d of this.joints) {
      let inertia = 0;
      const stack: BodyName[] = [d.child];
      while (stack.length) {
        const b = stack.pop()!;
        const body = this.bodies.get(b)!;
        const dCentre = this.restCentre.get(b)!.distanceTo(d.anchor);
        inertia += body.mass() * (dCentre * dCentre + 0.02);
        for (const c of children.get(b) ?? []) stack.push(c);
      }
      d.capKp = Math.min(d.muscle.kp, inertia * OMEGA_MAX * OMEGA_MAX);
      d.capKd = Math.min(d.muscle.kd, 0.9 * Math.sqrt(d.capKp * inertia), (0.2 * inertia) / h);
    }
  }

  // ---------------------------------------------------------------- muscles

  /**
   * Fire every muscle once for the current substep. Each muscle is a PD servo
   * toward its target orientation, torque-clamped to its strength — that clamp
   * is what makes the motion read as effortful and weighty rather than servo-
   * perfect. Torques are always internal (equal/opposite on the two linked
   * bodies), so the character can never push on the world except through
   * ground contact.
   */
  applyMuscles(targets: PoseTargets): void {
    const { _q1, _q2, _q3, _v1, _v2, _v3 } = this;
    for (const d of this.joints) {
      const list = targets.get(d.name);
      if (!list || list.length === 0) continue;

      const P = this.bodies.get(d.parent)!;
      const C = this.bodies.get(d.child)!;
      const qp = P.rotation();
      const qc = C.rotation();
      _q1.set(qp.x, qp.y, qp.z, qp.w); // parent world
      _q2.set(qc.x, qc.y, qc.z, qc.w); // child world

      if (d.hinge) {
        // Implicit motor (solver-integrated → stable at full stiffness on
        // even the lightest body, where an explicit servo detonates). The
        // JS API exposes no motor force limit, so the muscle's strength cap
        // is approximated by clamping the COMMANDED error: the motor never
        // sees a target further than the angle at which the nominal-gain
        // muscle would saturate.
        const t = list.find((x) => x.angle !== undefined);
        if (t) {
          // Measured hinge angle = twist of child rel parent about the axis.
          _q3.copy(_q1).invert().multiply(_q2);
          const dot = _q3.x * d.hinge.axis.x + _q3.y * d.hinge.axis.y + _q3.z * d.hinge.axis.z;
          const cur = 2 * Math.atan2(dot, _q3.w);
          const errCap = (d.muscle.maxNm / d.muscle.kp) * 1.3;
          const want = clampNum(t.angle!, d.hinge.min, d.hinge.max);
          const cmd = cur + clampNum(want - cur, -errCap, errCap);
          const kp = d.muscle.kp * MOTOR_SCALE * (t.kpScale ?? 1) * this.muscleScale;
          (d.impulse as RAPIER_API.RevoluteImpulseJoint).configureMotorPosition(cmd, kp, kp * 0.08);
        }
        continue;
      }

      const kpBase = d.capKp! * this.muscleScale;
      const kdBase = d.capKd! * this.muscleScale;
      const wp = P.angvel();
      const wc = C.angvel();

      _v3.set(0, 0, 0);
      for (const t of list) {
        if (t.torque) {
          // Direct muscle effort (world frame) — no state feedback here, so
          // no servo-instability risk on light bodies.
          _v3.x += t.torque.x;
          _v3.y += t.torque.y;
          _v3.z += t.torque.z;
          continue;
        }
        // Orientation error → world-frame axis*angle, with damping matched
        // to the goal's frame: a world-frame goal must damp the ABSOLUTE
        // angular velocity of the body it steers (a falling pelvis and its
        // thigh share the fall, so relative damping would see nothing).
        if (t.frame === 'local') {
          // qRel = qp⁻¹·qc ; err = qTarget·qRel⁻¹ (parent frame) → world.
          _q3.copy(_q1).invert().multiply(_q2).invert().premultiply(t.q);
          errToWorldTorque(_q3, _q1, _v1);
          _v3.addScaledVector(_v1, kpBase * (t.kpScale ?? 1));
          _v2.set(wc.x - wp.x, wc.y - wp.y, wc.z - wp.z);
          _v3.addScaledVector(_v2, -kdBase);
        } else if (t.frame === 'worldChild') {
          _q3.copy(_q2).invert().premultiply(t.q);
          errToWorldTorque(_q3, null, _v1);
          _v3.addScaledVector(_v1, kpBase * (t.kpScale ?? 1));
          _v3.addScaledVector(_v2.set(wc.x, wc.y, wc.z), -kdBase);
        } else {
          // worldParent: right the PARENT body; reaction goes to the child.
          _q3.copy(_q1).invert().premultiply(t.q);
          errToWorldTorque(_q3, null, _v1);
          // Torque is applied to the CHILD below, so flip the whole servo
          // (spring + damping on the parent's absolute velocity).
          _v3.addScaledVector(_v1, -kpBase * (t.kpScale ?? 1));
          _v3.addScaledVector(_v2.set(wp.x, wp.y, wp.z), kdBase);
        }
      }

      const maxNm = d.muscle.maxNm * this.muscleScale;
      const mag = _v3.length();
      if (mag > maxNm) _v3.multiplyScalar(maxNm / mag);

      // Torque IMPULSES (τ·h): rapier's addTorque persists and ACCUMULATES
      // across steps — impulses are one-shot, exactly one muscle firing per
      // substep.
      const h = this.world.timestep;
      C.applyTorqueImpulse({ x: _v3.x * h, y: _v3.y * h, z: _v3.z * h }, true);
      P.applyTorqueImpulse({ x: -_v3.x * h, y: -_v3.y * h, z: -_v3.z * h }, true);
    }
  }

  /** Advance the simulation by one fixed substep (world.timestep). */
  step(): void {
    this.world.step();
    // Refresh foot-contact flags: a foot is "planted" when its sole is at
    // floor level and barely moving vertically.
    for (let side = 0 as 0 | 1; side <= 1; side++) {
      const f = this.bodies.get(side === 0 ? 'footL' : 'footR')!;
      const y = f.translation().y - this.footHalf.y;
      const vy = f.linvel().y;
      const raw = y < 0.03 && Math.abs(vy) < 0.6;
      this.footContact[side] = raw;
      this.contactRun[side] = raw ? this.contactRun[side] + 1 : 0;
      this.footPlanted[side] = this.contactRun[side] >= 24;
    }
  }

  /** External nudge for testing physicality (a shove to the chest). */
  shove(fx: number, fy: number, fz: number): void {
    this.bodies.get('thorax')!.applyImpulse({ x: fx, y: fy, z: fz }, true);
  }

  /**
   * Stabilizer assist — TRAINING WHEELS, not a muscle. An external wrench
   * that holds the PELVIS like a marionette harness: position spring toward
   * the controller's desired point (x,z; y scaled by `comDes.y`, a unitless
   * height factor) plus an upright orientation spring. Hand-tuned torque
   * control alone cannot keep a ragdoll balanced through a dance (that's an
   * RL-policy-sized problem); this stands in for that policy so the rest of
   * the system — real masses, muscle limits, contacts, momentum — can be
   * exercised and seen. strength 0 = pure physics; 1 = firmly held (the
   * harness must actually be firm — a weak harness lets her face-plant and
   * then DRAGS her around the floor, which reads far worse than either
   * extreme).
   */
  applyAssist(comDes: THREE.Vector3, strength: number): void {
    if (strength <= 0) return;
    const pel = this.bodies.get('pelvis')!;
    const h = this.world.timestep;
    const p = pel.translation();
    const v = pel.linvel();
    const targetY = this.pelvisRestY * (comDes.y > 0 ? comDes.y : 1);
    const fx = clampNum(2600 * (comDes.x - p.x) - 380 * v.x, -420, 420) * strength;
    const fz = clampNum(2600 * (comDes.z - p.z) - 380 * v.z, -420, 420) * strength;
    const fy = clampNum(3200 * (targetY - p.y) - 420 * v.y, -420, 750) * strength;
    pel.applyImpulse({ x: fx * h, y: fy * h, z: fz * h }, true);
    // GENTLE upright torque on the pelvis. Deliberately weak: the pelvis
    // must stay free to rotate with the dance (a strong hold acts as a huge
    // angular damper — she tips during a transient and is then calmly PINNED
    // to the floor). The trunk's world-upright muscle servos own the visible
    // posture; this only biases the pelvis.
    const q = pel.rotation();
    this._q1.set(q.x, q.y, q.z, q.w).invert(); // rotation back to identity
    errToWorldTorque(this._q1, null, this._v1);
    const w = pel.angvel();
    this._v1.multiplyScalar(320).sub(this._v2.set(w.x * 42, w.y * 42, w.z * 42));
    this._v1.clampLength(0, 420).multiplyScalar(strength * h);
    pel.applyTorqueImpulse({ x: this._v1.x, y: this._v1.y, z: this._v1.z }, true);
  }

  /** Pelvis rest height (world) — the assist's reference. */
  readonly pelvisRestY: number;

  // ---------------------------------------------------------------- readback

  readState(out?: RigState): RigState {
    const st: RigState =
      out ??
      ({
        com: new THREE.Vector3(),
        comVel: new THREE.Vector3(),
        pelvisPos: new THREE.Vector3(),
        pelvisVel: new THREE.Vector3(),
        pelvisQ: new THREE.Quaternion(),
        feet: [
          { pos: new THREE.Vector3(), contact: true },
          { pos: new THREE.Vector3(), contact: true },
        ],
        footQ: [new THREE.Quaternion(), new THREE.Quaternion()],
        shinPitch: [0, 0],
        thoraxUp: 1,
      } as RigState);
    st.com.set(0, 0, 0);
    st.comVel.set(0, 0, 0);
    let m = 0;
    for (const [, b] of this.bodies) {
      const bm = b.mass();
      const p = b.translation();
      const v = b.linvel();
      st.com.x += p.x * bm;
      st.com.y += p.y * bm;
      st.com.z += p.z * bm;
      st.comVel.x += v.x * bm;
      st.comVel.y += v.y * bm;
      st.comVel.z += v.z * bm;
      m += bm;
    }
    st.com.multiplyScalar(1 / m);
    st.comVel.multiplyScalar(1 / m);
    const pel = this.bodies.get('pelvis')!;
    const pp = pel.translation();
    const pv = pel.linvel();
    const pq = pel.rotation();
    st.pelvisPos.set(pp.x, pp.y, pp.z);
    st.pelvisVel.set(pv.x, pv.y, pv.z);
    st.pelvisQ.set(pq.x, pq.y, pq.z, pq.w);
    for (let side = 0 as 0 | 1; side <= 1; side++) {
      const f = this.bodies.get(side === 0 ? 'footL' : 'footR')!;
      const fp = f.translation();
      const fq = f.rotation();
      st.footQ[side].set(fq.x, fq.y, fq.z, fq.w);
      st.feet[side].pos
        .copy(this.ankleLocal[side])
        .applyQuaternion(st.footQ[side])
        .add(this._v1.set(fp.x, fp.y, fp.z));
      st.feet[side].contact = this.footContact[side];
      const sq = this.bodies.get(side === 0 ? 'shinL' : 'shinR')!.rotation();
      st.shinPitch[side] = 2 * Math.atan2(sq.x, sq.w);
    }
    const tq = this.bodies.get('thorax')!.rotation();
    st.thoraxUp = 1 - 2 * (tq.x * tq.x + tq.z * tq.z);
    return st;
  }

  /** World rotation + rest-centre offset of a body (for write-back/debug). */
  bodyPose(name: BodyName, outQ: THREE.Quaternion, outP: THREE.Vector3): void {
    const b = this.bodies.get(name)!;
    const q = b.rotation();
    const p = b.translation();
    outQ.set(q.x, q.y, q.z, q.w);
    outP.set(p.x, p.y, p.z);
  }

  restCentreOf(name: BodyName): THREE.Vector3 {
    return this.restCentre.get(name)!;
  }

  dispose(): void {
    this.world.free();
  }
}

/** Quaternion error → axis*angle vector (shortest arc), optionally rotated
 *  into world frame by qFrame. */
function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function errToWorldTorque(
  qErr: THREE.Quaternion,
  qFrame: THREE.Quaternion | null,
  out: THREE.Vector3,
): void {
  if (qErr.w < 0) {
    qErr.x = -qErr.x;
    qErr.y = -qErr.y;
    qErr.z = -qErr.z;
    qErr.w = -qErr.w;
  }
  const s = Math.sqrt(Math.max(0, 1 - qErr.w * qErr.w));
  const angle = 2 * Math.acos(Math.min(1, qErr.w));
  if (s < 1e-6 || angle < 1e-6) {
    out.set(0, 0, 0);
    return;
  }
  out.set(qErr.x / s, qErr.y / s, qErr.z / s).multiplyScalar(angle);
  if (qFrame) out.applyQuaternion(qFrame);
}
