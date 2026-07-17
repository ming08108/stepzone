/**
 * DanceBrain — the motor-control layer of the physics dancer. Every tick it
 * looks at the body's real state (centre of mass, velocity, which feet are
 * on the floor) plus the musical beat, and decides what each muscle should
 * TRY to do. It never sets a pose: it emits muscle targets, and the ragdoll's
 * torque-limited PD muscles fight gravity to satisfy them.
 *
 * The control scheme is a SIMBICON-style biped controller adapted to dancing
 * on a 4-panel pad:
 *  - continuous balance: the stance ankle steers the centre of pressure
 *    toward the ground projection of a desired CoM point (ankle strategy),
 *    while the stance hip rights the pelvis in world frame (hip strategy —
 *    torque on the pelvis, reaction on the stance thigh, always internal);
 *  - a beat-locked step machine: each beat one foot is chosen to swing to a
 *    panel; the swing hip/knee follow a lift-and-reach trajectory computed by
 *    target-space IK, with the classic cd·d + cv·v landing-offset feedback so
 *    the step itself is a balance actuator;
 *  - a groove layer: weight sways, knee bounce, arm opposition, torso twist —
 *    all expressed only as muscle targets;
 *  - a recovery reflex: if the CoM runs away (a shove), the nearest foot
 *    abandons choreography and steps toward the capture point.
 */
import * as THREE from 'three/webgpu';
import type { JointName, PoseTargets, RigSkeleton, RigState } from './rig';

/** Panel → floor position (metres). Viewer looks down −z at the dancer, so
 *  panel L sits at −x; U is the far row (−z), D the near row (+z). */
export const PHYS_PANEL: readonly THREE.Vector3[] = [
  new THREE.Vector3(-0.26, 0, 0), // L
  new THREE.Vector3(0, 0, 0.26), // D
  new THREE.Vector3(0, 0, -0.26), // U
  new THREE.Vector3(0.26, 0, 0), // R
];

/** One bar of choreography: which panel to hit on each beat and with which
 *  foot ('neg' = the foot whose home is on −x, i.e. the one nearest panel L).
 *  null = rest beat (groove in place). */
export interface PatternStep {
  panel: number;
  foot: 'neg' | 'pos';
}
export const DEFAULT_PATTERN: (PatternStep | null)[] = [
  { panel: 0, foot: 'neg' },
  { panel: 2, foot: 'pos' },
  { panel: 1, foot: 'neg' },
  { panel: 3, foot: 'pos' },
  { panel: 0, foot: 'neg' },
  { panel: 1, foot: 'pos' },
  { panel: 2, foot: 'neg' },
  null,
  { panel: 3, foot: 'pos' },
  { panel: 2, foot: 'neg' },
  { panel: 1, foot: 'pos' },
  { panel: 0, foot: 'neg' },
  { panel: 3, foot: 'pos' },
  { panel: 2, foot: 'neg' },
  null,
  null,
];

export interface BrainKnobs {
  /** Ankle-strategy gains: CoP shift per metre of CoM error / per m/s. */
  balKp: number;
  balKd: number;
  /** Landing-offset feedback (SIMBICON cd/cv). */
  stepCd: number;
  stepCv: number;
  /** Swing arc peak height, metres. */
  stepLift: number;
  /** Groove amplitudes. */
  sway: number; // CoM weight sway, m
  bounce: number; // knee-bounce dip as a FRACTION of leg length
  armSwing: number; // shoulder swing, rad
  twist: number; // torso twist, rad
  /** CoM speed (m/s) beyond which the recovery reflex fires. */
  panicVel: number;
}

export const DEFAULT_KNOBS: BrainKnobs = {
  balKp: 2.2,
  balKd: 1.0,
  stepCd: 0.35,
  stepCv: 0.18,
  stepLift: 0.1,
  sway: 0.045,
  bounce: 0.02,
  armSwing: 0.35,
  twist: 0.18,
  panicVel: 0.55,
};

interface ActiveStep {
  foot: 0 | 1;
  target: THREE.Vector3;
  from: THREE.Vector3;
  startBeat: number;
  endBeat: number;
  recovery: boolean;
}

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);

export class DanceBrain {
  readonly knobs: BrainKnobs = { ...DEFAULT_KNOBS };
  private readonly targets: PoseTargets = new Map();
  private readonly l1: [number, number]; // thigh lengths
  private readonly l2: [number, number]; // shin lengths
  private readonly thighRest: [THREE.Vector3, THREE.Vector3];
  private readonly socketLocal: [THREE.Vector3, THREE.Vector3]; // rel pelvis centre
  private readonly ankleY: number;
  /** Which side (0=model left, 1=model right) homes on −x. */
  private readonly negFoot: 0 | 1;
  private readonly home: [THREE.Vector3, THREE.Vector3];
  private step: ActiveStep | null = null;
  private lastStepBeat = -1;
  private planted: [THREE.Vector3, THREE.Vector3];
  /** Where the balance layer wants the CoM this tick (world, y included) —
   *  read by the sim's stabilizer assist. */
  readonly comDesire = new THREE.Vector3();
  private restComY = 0;

  // scratch
  private readonly _v1 = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();
  private readonly _v3 = new THREE.Vector3();
  private readonly _v4 = new THREE.Vector3();
  private readonly _q1 = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();

  constructor(
    skel: RigSkeleton,
    private readonly pattern: readonly (PatternStep | null)[] = DEFAULT_PATTERN,
  ) {
    const v = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);
    const hips = v(skel.hips);
    this.l1 = [
      v(skel.hipSocket[0]).distanceTo(v(skel.knee[0])),
      v(skel.hipSocket[1]).distanceTo(v(skel.knee[1])),
    ];
    this.l2 = [
      v(skel.knee[0]).distanceTo(v(skel.ankle[0])),
      v(skel.knee[1]).distanceTo(v(skel.ankle[1])),
    ];
    this.thighRest = [
      v(skel.knee[0]).sub(v(skel.hipSocket[0])).normalize(),
      v(skel.knee[1]).sub(v(skel.hipSocket[1])).normalize(),
    ];
    this.socketLocal = [v(skel.hipSocket[0]).sub(hips), v(skel.hipSocket[1]).sub(hips)];
    this.ankleY = (skel.ankle[0].y + skel.ankle[1].y) / 2;
    this.negFoot = skel.ankle[0].x < skel.ankle[1].x ? 0 : 1;
    this.home = [v(skel.ankle[0]), v(skel.ankle[1])];
    // Keep home stance a touch inside the L/R panels so steps read as steps.
    for (const h of this.home) h.x = Math.sign(h.x) * Math.min(Math.abs(h.x), 0.13);
    this.planted = [this.home[0].clone(), this.home[1].clone()];
  }

  /** The foot currently planned to be swinging, for debug UIs. */
  get activeStep(): { foot: 0 | 1; target: THREE.Vector3; recovery: boolean } | null {
    return this.step
      ? { foot: this.step.foot, target: this.step.target, recovery: this.step.recovery }
      : null;
  }

  /**
   * Produce this tick's muscle targets. `beat` is musical time; the sim may
   * call this at substep rate — it's cheap and stateless between beats apart
   * from the step machine.
   */
  update(st: RigState, beat: number): PoseTargets {
    const K = this.knobs;
    const t = this.targets;
    for (const [, arr] of t) arr.length = 0; // fresh goals every tick
    const phase = beat - Math.floor(beat);

    // ------------------------------------------------ step machine
    // Commit a new pattern step at each integer beat; steps run [.05, .95] of
    // the beat so there's always a moment of double support around the beat
    // itself (that's when a dancer "hits" the move).
    const beatIdx = Math.floor(beat);
    if (!this.step && beatIdx > this.lastStepBeat && phase >= 0.05) {
      this.lastStepBeat = beatIdx;
      const n = this.pattern.length;
      const pat = n ? this.pattern[((beatIdx % n) + n) % n] : null;
      if (pat) {
        const foot: 0 | 1 = pat.foot === 'neg' ? this.negFoot : ((1 - this.negFoot) as 0 | 1);
        const target = PHYS_PANEL[pat.panel].clone();
        // L/R panels are owned by their natural foot; centre panels (U/D) keep
        // the foot on its own half so the legs never cross at home.
        if (pat.panel === 1 || pat.panel === 2) {
          target.x = this.home[foot].x * 0.55;
        }
        target.y = this.ankleY;
        this.step = {
          foot,
          target,
          from: st.feet[foot].pos.clone(),
          startBeat: beatIdx + 0.05,
          endBeat: beatIdx + 0.95,
          recovery: false,
        };
      }
    }
    // Recovery reflex: CoM running away in double support → catch step.
    const vXZ = Math.hypot(st.comVel.x, st.comVel.z);
    if (!this.step && vXZ > K.panicVel) {
      // Step with the foot on the side we're falling toward.
      const foot: 0 | 1 = st.comVel.x * (this.home[1].x - this.home[0].x) > 0 ? 1 : 0;
      const cap = this._v1.copy(st.com).addScaledVector(st.comVel, 0.32).sub(st.feet[foot].pos);
      cap.y = 0;
      cap.clampLength(0, 0.45);
      const target = st.feet[foot].pos.clone().add(cap);
      target.y = this.ankleY;
      this.step = {
        foot,
        target,
        from: st.feet[foot].pos.clone(),
        startBeat: beat,
        endBeat: beat + 0.5,
        recovery: true,
      };
    }
    if (this.step && beat >= this.step.endBeat) {
      // Anchor halfway between where the foot ACTUALLY landed and where the
      // panel wanted it — the stance leg then gently pulls the plant onto
      // the arrow, so placement errors don't compound across steps.
      this.planted[this.step.foot].copy(st.feet[this.step.foot].pos).lerp(this.step.target, 0.5);
      this.planted[this.step.foot].y = this.ankleY;
      this.step = null;
    }

    const swing = this.step;
    const swingFoot = swing ? swing.foot : -1;
    const stanceFoot: 0 | 1 = swing ? ((1 - swing.foot) as 0 | 1) : 0;

    // ------------------------------------------------ desired CoM point
    // Double support: between the feet, swaying with the music. Single
    // support: over the stance foot (slightly inside edge).
    // Reference the REMEMBERED plant points, not live foot positions — if a
    // foot gets nudged, balance must not chase the nudge (that's a positive
    // feedback loop; the leg pulls the foot back to its anchor instead).
    const ramp = Math.min(1, beat / 3); // ease the groove in from stand-up
    const comDes = this._v2;
    if (swing) {
      // Mostly over the stance foot, biased a little toward where the swing
      // foot will land — a dancer flows through steps, not lurch-by-lurch.
      comDes.copy(this.planted[stanceFoot]).multiplyScalar(0.78);
      comDes.addScaledVector(swing.target, 0.22);
      comDes.x *= 0.92;
    } else {
      comDes.copy(this.planted[0]).add(this.planted[1]).multiplyScalar(0.5);
      comDes.x += ramp * K.sway * Math.sin(Math.PI * beat);
    }
    // A small forward bias keeps the CoM on the toe side of the ankle — the
    // side with the long lever, where the ankle has real authority.
    comDes.z += 0.01;
    if (this.restComY === 0) this.restComY = st.com.y; // first tick = standing rest
    this.comDesire.copy(comDes);
    const errX = st.com.x - comDes.x;
    const errZ = st.com.z - comDes.z;

    // ------------------------------------------------ hip strategy / torso
    // The stance hip rights the pelvis in WORLD frame, leaning AGAINST the
    // CoM error (bend away from the fall — the human hip strategy). Signs
    // matter enormously here: leaning INTO the error turns the strongest
    // servo in the body into a positive feedback loop.
    const leanRoll = clamp(0.35 * errX + 0.12 * st.comVel.x, -0.12, 0.12);
    const leanPitch = clamp(-0.3 * errZ - 0.1 * st.comVel.z, -0.12, 0.1);
    // leanRoll tilts the pelvis top toward −x for a +x error (R_z(+) takes
    // +y toward −x), leanPitch toward −z for a +z error.
    const pelvisTarget = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 0, 1), leanRoll)
      .multiply(this._q1.setFromAxisAngle(X, leanPitch));
    for (let f = 0 as 0 | 1; f <= 1; f++) {
      if (f === swingFoot) continue;
      set(t, f === 0 ? 'hipL' : 'hipR', pelvisTarget.clone(), 'worldParent', swing ? 1 : 0.6);
    }

    // ------------------------------------------------ stance legs
    // Each planted leg is IK'd from its hip socket to where its ankle
    // actually is; the groove bounce shortens the effective leg on the beat,
    // so the dip is the knees genuinely giving way under the body's weight.
    const dip = Math.sin(Math.PI * phase);
    const shorten = ramp * K.bounce * dip * dip;
    for (let f = 0 as 0 | 1; f <= 1; f++) {
      if (f === swingFoot) continue;
      // The knee targets the DESIRED leg extension (nominal length minus the
      // groove dip), never the current one — targeting current geometry is a
      // positive feedback loop (sink → shorter leg → deeper flexion target →
      // sink). With a fixed extension target, sinking below it produces a
      // restoring push.
      // Full-strength thigh aim: this is the hip extensor holding the body
      // up — without it the body folds at the hip ("sits"). The stance KNEE
      // is soft (0.35): a standing human's knee rests near its extension
      // stop almost passively; a stiff knee servo fighting the ankles' tiny
      // CoP budget is what marched the body forward.
      // Differential leg extension is the double-support LATERAL balance
      // actuator: falling toward −x → the −x leg extends (pushes the body
      // back up-right) while the +x leg gives. Ankle roll alone has only a
      // few cm of sole to work with; this uses the whole stance width.
      const lat = clamp(-(0.45 * errX + 0.28 * st.comVel.x), -0.05, 0.05);
      const side = this.home[f].x < 0 ? 1 : -1;
      const extension = (this.l1[f] + this.l2[f]) * (1 - shorten) * (1 + lat * side);
      this.solveLeg(st, f, this.planted[f], extension, 1.0, 0.35);
    }
    // The assist supports the body at the groove's intended height, so the
    // dip stays visible even under full stabilization.
    this.comDesire.y = this.restComY * (1 - shorten);

    // ------------------------------------------------ swing leg
    if (swing) {
      const u = clamp((beat - swing.startBeat) / (swing.endBeat - swing.startBeat), 0, 1);
      // Landing point + capture-point feedback: step where balance needs it.
      // Balance feedback nudges the landing, but only a little — choreography
      // accuracy beats offset authority (the recovery reflex handles real
      // trouble with full capture-point steps).
      const land = this._v3.copy(swing.target);
      const stAnk = st.feet[stanceFoot].pos;
      land.x += clamp(K.stepCd * (st.com.x - stAnk.x) + K.stepCv * st.comVel.x, -0.06, 0.06);
      land.z += clamp(K.stepCd * (st.com.z - stAnk.z) + K.stepCv * st.comVel.z, -0.06, 0.06);
      if (swing.recovery) {
        land.copy(swing.target); // recovery target IS the capture point
      }
      // Minimum-ish jerk horizontal path, sine lift arc.
      const s = u * u * (3 - 2 * u);
      const pos = this._v4.copy(swing.from).lerp(land, s);
      pos.y = this.ankleY + K.stepLift * Math.sin(Math.PI * u);
      // Swing tracking gets extra gain (still under the inertia cap): a slow
      // swing leg is what misses panels.
      this.solveLeg(st, swing.foot, pos, undefined, 1.6);
    }

    // ------------------------------------------------ ankle strategy
    // Feet stay flat via the base angle solveLeg recorded (compensating the
    // shin's tilt), and the PLANTED ankles add the balance term: CoM drifting
    // forward (+z) → press the toes (+pitch) so the centre of pressure moves
    // ahead of the CoM and the ground pushes the body back. This is the
    // strongest continuous balance actuator a standing human has.
    // POSTURAL ankle stiffness — the classic inverted-pendulum ankle: hold
    // the shin at a slight forward world-lean, plantarflexing (+, pressing
    // the toes → centre of pressure moves ahead of the CoM) when the CoM
    // runs forward. Swing feet track the measured shin tilt compliantly so
    // they land sole-first wherever the leg is.
    const pitchBal = clamp(K.balKp * errZ + K.balKd * st.comVel.z, -0.4, 0.4);
    const rollBal = clamp(-(K.balKp * errX + K.balKd * st.comVel.x), -0.35, 0.35);
    for (let f = 0 as 0 | 1; f <= 1; f++) {
      // Stance is the CONTROLLER's decision, never the contact sensor's — a
      // flickering contact flag would thrash the ankle target at 240 Hz and
      // kick the foot around.
      const stance = f !== swingFoot;
      if (stance) {
        setAngle(t, f === 0 ? 'ankleL' : 'ankleR', -0.015 + pitchBal);
        setAngle(t, f === 0 ? 'ankleRollL' : 'ankleRollR', rollBal);
      } else {
        setAngle(t, f === 0 ? 'ankleL' : 'ankleR', -st.shinPitch[f]);
        setAngle(t, f === 0 ? 'ankleRollL' : 'ankleRollR', 0);
      }
    }

    // ------------------------------------------------ groove upper body
    const tw = ramp * K.twist * Math.sin(Math.PI * beat);
    const sideLean = ramp * 0.35 * K.sway * Math.sin(Math.PI * beat + 0.6);
    const waistQ = new THREE.Quaternion()
      .setFromAxisAngle(Y, tw)
      .multiply(this._q1.setFromAxisAngle(new THREE.Vector3(0, 0, 1), sideLean));
    set(t, 'waist', waistQ, 'local');
    // No forward-pitch bias here: every steady forward component in an
    // upper-body target rectifies into a forward walk through the ankles.
    set(t, 'upperBack', new THREE.Quaternion().setFromAxisAngle(Y, tw * 0.7), 'local');
    set(t, 'neckJ', new THREE.Quaternion().setFromAxisAngle(Y, -tw * 0.6), 'local');

    // Arms: opposition swing from an arms-down rest (the rig binds in T-pose,
    // so "down" is itself a muscle posture — she pulls her arms down on spawn).
    for (let sIdx = 0 as 0 | 1; sIdx <= 1; sIdx++) {
      const sign = sIdx === 0 ? -1 : 1; // left arm rotates −z to drop, right +z
      const osc = Math.sin(Math.PI * beat + (sIdx === 0 ? 0 : Math.PI));
      const down = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), sign * 1.25);
      const fwd = this._q2.setFromAxisAngle(X, -K.armSwing * osc);
      down.premultiply(fwd);
      set(t, sIdx === 0 ? 'shoulderL' : 'shoulderR', down, 'local');
    }
    // Elbows: constant relaxed flex (an in-phase elbow pump is a common-mode
    // forward driver — see the upperBack note).
    setAngle(t, 'elbowL', 0.5);
    setAngle(t, 'elbowR', 0.5);

    return t;
  }

  /**
   * Target-space 2-link IK: turn a desired ankle position into hip + knee
   * muscle targets. The REAL leg only gets there if the muscles are strong
   * and balance allows — this computes intent, not pose. `extension` fixes
   * the hip→ankle distance the knee should realise (stance legs pass the
   * desired standing length; swing legs use the live target distance);
   * `aimScale` softens the thigh-aim gain for stance legs (balance owns them
   * more than pose).
   */
  private solveLeg(
    st: RigState,
    foot: 0 | 1,
    anklePos: THREE.Vector3,
    extension: number | undefined,
    aimScale: number,
    kneeScale = 1,
  ): void {
    const t = this.targets;
    const hipW = this._v1
      .copy(this.socketLocal[foot])
      .applyQuaternion(st.pelvisQ)
      .add(st.pelvisPos);
    const toT = this._v2.copy(anklePos).sub(hipW);
    const L1 = this.l1[foot];
    const L2 = this.l2[foot];
    const d = clamp(extension ?? toT.length(), Math.abs(L1 - L2) + 0.01, (L1 + L2) * 0.999);
    toT.normalize();
    const cosKnee = clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1);
    const kneeFlex = Math.PI - Math.acos(cosKnee);
    const cosHip = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
    const hipOff = Math.acos(cosHip);
    // Tilt the thigh forward of the hip→ankle line so the knee points forward.
    const thighDir = this._v3.copy(toT).applyAxisAngle(X, -hipOff);
    const q = new THREE.Quaternion().setFromUnitVectors(this.thighRest[foot], thighDir);
    set(t, foot === 0 ? 'hipL' : 'hipR', q, 'worldChild', aimScale);
    setAngle(t, foot === 0 ? 'kneeL' : 'kneeR', kneeFlex, kneeScale);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const IDENTITY = new THREE.Quaternion();

/** Append a hinge-angle goal (knees/elbows — driven by the implicit motor). */
function setAngle(t: PoseTargets, j: JointName, angle: number, kpScale?: number): void {
  let arr = t.get(j);
  if (!arr) {
    arr = [];
    t.set(j, arr);
  }
  arr.push({ q: IDENTITY, frame: 'local', angle, kpScale });
}

/** Append a goal for a joint this tick (joints may hold several — the rig
 *  sums their torques under one strength clamp). */
function set(
  t: PoseTargets,
  j: JointName,
  q: THREE.Quaternion,
  frame: 'local' | 'worldChild' | 'worldParent',
  kpScale?: number,
): void {
  let arr = t.get(j);
  if (!arr) {
    arr = [];
    t.set(j, arr);
  }
  arr.push({ q: q.clone(), frame, kpScale });
}
