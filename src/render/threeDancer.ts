/**
 * ThreeVrmDancer — a VRM avatar dancing on a 4-panel dancepad, driven by a chart's
 * StepParity foot stream (which foot steps which arrow, and jumps), with a foot-IK
 * layer planting the feet on the arrows on the beat. A retargeted Mixamo groove drives
 * the upper body; VRM spring bones (built on the fly for MMD→VRM models that shipped
 * without physics) animate skirt + hair.
 *
 * Rendering is dual-mode:
 *   - standalone: pass a real `canvas`; three owns its own device and renders to screen
 *     (used by the ?vrm proving ground, src/ui/VrmTest.tsx).
 *   - in-game: pass the game's `device` + `format` + a size; renders into an offscreen
 *     RenderTarget whose GPUTexture the note-field renderer composites (attractGpu).
 *
 * three/webgpu + @pixiv/three-vrm (MToon node material).
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import {
  VRMLoaderPlugin,
  VRMUtils,
  MToonMaterialLoaderPlugin,
  type VRM,
  type VRMHumanBoneName,
} from '@pixiv/three-vrm';
import { MToonNodeMaterial } from '@pixiv/three-vrm/nodes';
import { buildClothPhysics } from './vrmCloth';
import { retargetMixamoToVrm } from '../ui/mixamoToVrm';
import {
  buildChartTimeline,
  buildSynthTimeline,
  sampleFeet,
  makeSampledFeet,
  type FootTimeline,
} from './dancerFootwork';

/** One chart row of footwork: which panel each foot lands on this beat (−1 = no step);
 *  a row with BOTH feet set is a jump. Panel 0=L,1=D,2=U,3=R (StepParity convention). */
export interface DancerStep {
  beat: number;
  cols: number;
  lCol?: number;
  rCol?: number;
}

export interface DancerCamera {
  fovY?: number;
  eye?: readonly [number, number, number];
  target?: readonly [number, number, number];
}

// Panel → floor position (metres). L/R straddle x; U far (−z), D near (+z). Kept fairly narrow:
// a 60 cm L↔R split reads as an unnatural sumo stance AND stretches long garments (a jacket/coat
// hem skinned to the legs tents out into a "skirt" on the a/b/c samples). ~48 cm looks natural.
const PANEL = [
  new THREE.Vector3(-0.24, 0, 0), // 0 L
  new THREE.Vector3(0, 0, 0.26), //  1 D
  new THREE.Vector3(0, 0, -0.26), // 2 U
  new THREE.Vector3(0.24, 0, 0), //  3 R
];
const PANEL_COL = [0xff3fa0, 0x8f6bff, 0x4fd6ff, 0xffa63f];
const HOME = [new THREE.Vector3(-0.09, 0, 0.05), new THREE.Vector3(0.09, 0, 0.05)]; // L/R rest
// Signs for this VRM0-mirrored rig (the retarget flips x/z, so the correct sign is verified by
// eye in ?vrm, not derived on paper): contrapposto hip hike vs. loaded side, and the weight-lean
// roll/pitch vs. travel direction.
const PELVIS_ROLL_SIGN = 1;
const PELVIS_PITCH_SIGN = -1;
const LEAN_ROLL_SIGN = 1;
const LEAN_PITCH_SIGN = 1;
const ARM_OPP_SIGN = 1; // chest counter-twist direction vs. the stepping foot (mirror-verified)
const GAZE_SIGN = 1; // head-turn direction toward the next step
// How far the knees splay OUTWARD (per leg, relative to the forward bend direction). A
// slightly turned-out stance keeps the two thighs from converging and clipping when the
// feet come close or cross — real legs don't bend in perfectly parallel planes.
const KNEE_OUT = 0.34;

// Upper-body groove clip (Mixamo, mixamorig rig → retargeted to the VRM humanoid). Only the
// arms/torso/head read through; the legs are overridden by the chart foot-IK. The samba clip
// has continuous full-body hip/torso sway, which reads livelier than the arm-isolation hip-hop.
const GROOVE_URL = '/threejs-demo/samba.fbx';

/** Cap the offscreen dancer render height (keep aspect) — she's a background element
 *  composited (upscaled) behind the field, so full 4K per frame is wasted GPU. */
const MAX_OFFSCREEN_H = 960;
function capOffscreen(w: number, h: number): [number, number] {
  const s = Math.min(1, MAX_OFFSCREEN_H / Math.max(1, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

interface Leg {
  hip: THREE.Object3D;
  knee: THREE.Object3D;
  ankle: THREE.Object3D;
  L1: number;
  L2: number;
  hipChild: THREE.Vector3;
  kneeChild: THREE.Vector3;
  hipRef: THREE.Vector3;
  kneeRef: THREE.Vector3;
  footBind: THREE.Quaternion;
}

export interface ThreeVrmDancerOpts {
  modelUrl: string;
  canvas?: HTMLCanvasElement;
  device?: GPUDevice;
  format?: GPUTextureFormat;
  width?: number;
  height?: number;
  bpm?: number;
  /** Mixamo FBX whose upper body drives the groove (defaults to the shipped hip-hop clip). */
  animUrl?: string;
}

export class ThreeVrmDancer {
  private opts: ThreeVrmDancerOpts;
  private renderer!: THREE.WebGPURenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private rt: THREE.RenderTarget | null = null;
  private vrm!: VRM;
  private mixer!: THREE.AnimationMixer;
  private clipDur = 1;
  private legs!: [Leg, Leg];
  private footLeg!: [Leg, Leg]; // foot index (0=left,1=right) → VRM leg
  private hips!: THREE.Object3D;
  private arrowMats: THREE.MeshBasicNodeMaterial[] = [];
  private keyLight!: THREE.DirectionalLight;
  private rimLight!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;

  // grounding / stance
  private ankleY = 0.07;
  private socketH = 0.8;
  private legLen = 0.8;
  private baseRotY = 0;

  // footwork — a pure, stateless timeline sampled by beat (see dancerFootwork.ts). No cursor
  // to exhaust, so a song loop/seek/restart can never freeze the feet.
  private chartTl: FootTimeline | null = null; // built from the chart; null → use the synth
  private synthTl: FootTimeline | null = null; // the looping no-chart routine
  private sampled = makeSampledFeet();
  private litPanel: number[] = [-9, -9, -9, -9];

  ready = false;
  private disposed = false;

  // scratch
  private readonly FWD = new THREE.Vector3(0, 0, 1);
  private mL = new THREE.Matrix4();
  private mW = new THREE.Matrix4();
  private qW = new THREE.Quaternion();
  private qLl = new THREE.Quaternion();
  private qP = new THREE.Quaternion();
  private hipPos = new THREE.Vector3();
  private kneePos = new THREE.Vector3();
  // IK hot-path scratch (solveLeg 2×/frame, orient 4×/frame) — reused, never allocated.
  private sToT = new THREE.Vector3();
  private sN = new THREE.Vector3();
  private sPole = new THREE.Vector3();
  private sAxis = new THREE.Vector3();
  private sKneeDir = new THREE.Vector3();
  private sAim = new THREE.Vector3();
  private oX1 = new THREE.Vector3();
  private oY1 = new THREE.Vector3();
  private oZ1 = new THREE.Vector3();
  private oX = new THREE.Vector3();
  private oSec = new THREE.Vector3();
  private oZ = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private footPos = [new THREE.Vector3(), new THREE.Vector3()];
  private footPitch = [0, 0]; // per-foot ankle pitch (toe articulation) — from the sampler
  private qFoot = new THREE.Quaternion();
  private qFootYaw = new THREE.Quaternion();
  private footYaw = [0, 0]; // per-foot world yaw; only eases toward the body facing while AIRBORNE
  private readonly footAxis = new THREE.Vector3(1, 0, 0);
  private readonly upAxis = new THREE.Vector3(0, 1, 0);
  private yaw = 0;

  // ---- Centre-of-mass / balance state — the ONE physical system the whole body follows.
  // Every visible motion (pelvis shift/roll/pitch/yaw, torso S-curve, head, bounce, travel) is
  // a consequence of these, so the upper body can never be "detached" from the feet: the feet
  // are its only excitation. Each spring is a [position, velocity] pair; sp2() integrates them
  // dt-correctly. The `tune` knobs are read live every frame (the ?vrm UI writes to them), so
  // the dancer can be dialed in without a rebuild. clipBeats beat-locks the 18.2 s arm clip to
  // ~authored speed at 128 BPM (2.13 beats/s × 18.2 s ≈ 39 beats/loop).
  tune = {
    clipBeats: 39,
    clipTwist: 0, // how much of the clip's own Y-rotation to keep (0 = no samba spin; 1 = full)
    clipLean: 0.5, // how much of the clip's torso LEAN (roll/pitch tilt) to keep (0 = none)
    yawAmp: 0.5, // turn on a SINGLE cross (one leg over the line)
    crossTurn: 1.8, // turn on a FULL double-cross (both feet swapped) — up to π = a full spin around
    yawSign: 1, // which way the crossover pivot turns (±1) — flip on the VRM0-mirrored rig
    yawRate: 6, // turn snappiness — drives the yaw spring stiffness AND the teleport-backstop cap
    commitX: 0.6, // how far the pelvis shifts toward the weight-bearing foot
    commitZ: 0.5, // fore/aft weight shift
    comStiff: 9, // CoM spring stiffness (higher = snappier weight transfer)
    leanRoll: 0.45, // upper-body lean into lateral travel
    leanPitch: 0.35, // upper-body lean into fore/aft travel
    pelvisRoll: 0.09, // contrapposto hip hike over the loaded leg
    bounce: 1.0, // vertical impact-bounce scale
    kneeSplit: 4.0, // crossover knee depth-split strength (anti-clip)
    // ---- naturalness layers (additive, small) ----
    armSwing: 0.5, // torso counter-twist coupled to the stepping foot (opposition) → arms follow
    gaze: 0.5, // head leads toward the foot she's about to step
    breath: 0.5, // slow breathing rise/fall (strongest during holds)
    idleSway: 0.5, // subtle non-repeating body drift when she's not busy stepping
    kneeSoft: 0.5, // plié — she sinks onto the weight-bearing leg (knees soften under load)
    preLoad: 0.5, // a small anticipatory dip just before she launches into a step
    footRoll: 1.0, // heel-toe articulation of the swinging foot (push off the ball, heel-strike)
  };
  private prevBeat = 0;
  private bps = 2.13; // smoothed tempo (beats/sec ≈ 128 BPM) — scales the spring stiffness
  private holdBeats = 0; // beats since any foot landed (idle-groove gain)
  private lastLand0 = -1e9;
  private lastLand1 = -1e9;
  private loadLP = 0; // smoothed loadedness (which leg carries weight), −1..1
  private sComX = [0, 0]; // horizontal CoM (world x)
  private sComZ = [0, 0]; // horizontal CoM (world z)
  private sComY = [0, 0]; // vertical CoM offset (impacts push it down, spring recovers)
  private sYaw = [0, 0]; // body yaw
  private sLeanR = [0, 0]; // upper-body lean INTO lateral travel (roll) — "commit, catch, settle"
  private sLeanP = [0, 0]; // upper-body lean into fore/aft travel (pitch)
  private sHeadR = [0, 0]; // head stabilization roll
  private sHeadY = [0, 0]; // head gaze yaw toward the next step
  private sChestY = [0, 0]; // torso opposition twist (arms follow the stepping foot)
  private _breath = 0; // current breathing offset (for the spine write)
  private sSep = [0, 0]; // smoothed crossover front/back split direction (+1 foot0 in front)
  private sepFb = 0; // closed-loop knee-separation feedback (from last frame's measured gap)
  private sepAmtPrev = 0; // last frame's split amount → this frame's crouch coupling
  private spine: THREE.Object3D | null = null;
  private chest: THREE.Object3D | null = null;
  private upperChest: THREE.Object3D | null = null;
  private head: THREE.Object3D | null = null;
  private eSway = new THREE.Euler();
  private qSway = new THREE.Quaternion();
  private eChest = new THREE.Euler();
  private qChest = new THREE.Quaternion();
  private _center: [number, number, number] = [0, 1, 0];
  private _radius = 1;

  constructor(opts: ThreeVrmDancerOpts) {
    this.opts = opts;
    const w = opts.width ?? opts.canvas?.clientWidth ?? 512;
    const h = opts.height ?? opts.canvas?.clientHeight ?? 720;
    this.camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 50);
  }

  async init(): Promise<void> {
    const { canvas, device, format } = this.opts;
    const w = this.opts.width ?? canvas?.clientWidth ?? 512;
    const h = this.opts.height ?? canvas?.clientHeight ?? 720;

    // Load VRM (+ MToon node material) and the shared Mixamo groove clip.
    const loader = new GLTFLoader();
    loader.register(
      (parser) =>
        new VRMLoaderPlugin(parser, {
          mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser, {
            materialType: MToonNodeMaterial,
          }),
        }),
    );
    const [gltf, sourceFbx] = await Promise.all([
      loader.loadAsync(this.opts.modelUrl),
      new FBXLoader().loadAsync(this.opts.animUrl ?? GROOVE_URL),
    ]);
    if (this.disposed) return;
    const vrm = gltf.userData.vrm as VRM;
    this.vrm = vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineMorphs?.(vrm);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => {
      (o as THREE.Mesh).frustumCulled = false;
    });
    // Only build cloth physics if the model shipped none (MMD→VRM conversions);
    // proper VRM/VRoid exports already carry their own spring bones.
    if (!vrm.springBoneManager || vrm.springBoneManager.joints.size === 0) buildClothPhysics(vrm);

    // Lights (mutated by setTint/setEnv to match the scene in-game).
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x334433, 2.2);
    this.scene.add(this.hemi);
    this.keyLight = new THREE.DirectionalLight(0xfff9ea, 2.6);
    this.keyLight.position.set(3, 5, 3);
    this.scene.add(this.keyLight);
    this.rimLight = new THREE.DirectionalLight(0xbfd0ff, 1.4);
    this.rimLight.position.set(-2, 4, -5);
    this.scene.add(this.rimLight);

    // Dancepad: dark slab + four glowing arrow tiles.
    const pad = new THREE.Group();
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.02, 0.95),
      new THREE.MeshStandardNodeMaterial({ color: 0x0a0a14, roughness: 0.6 }),
    );
    slab.position.y = -0.01;
    pad.add(slab);
    for (let p = 0; p < 4; p++) {
      const mat = new THREE.MeshBasicNodeMaterial({
        color: PANEL_COL[p],
        transparent: true,
        opacity: 0.35,
      });
      const tile = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.008, 0.26), mat);
      tile.position.copy(PANEL[p]).setY(0.006);
      pad.add(tile);
      this.arrowMats[p] = mat;
    }
    this.scene.add(pad);
    // Upcoming-step markers (?vrm debug): one per foot, a glowing tile that DESCENDS onto the pad
    // it's about to hit, landing on the beat — foot 0 cyan, foot 1 pink. Hidden by default.
    for (let f = 0; f < 2; f++) {
      const mat = new THREE.MeshBasicNodeMaterial({
        color: f === 0 ? 0x4fd6ff : 0xff5fb0,
        transparent: true,
        opacity: 0.85,
      });
      const mk = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 0.22), mat);
      mk.visible = false;
      this.scene.add(mk);
      this.noteMarks.push(mk);
    }
    this.scene.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);

    // ---- Spring-bone stabilisation (two independent fixes; done here so the world matrices are
    // current for setInitState) ----
    if (vrm.springBoneManager) {
      for (const joint of vrm.springBoneManager.joints) {
        const j = joint as unknown as {
          bone: THREE.Object3D;
          center: THREE.Object3D | null;
          settings: { dragForce: number; stiffness: number };
        };
        // (1) CENTER = scene root: physics relative to the moving body, so the ~2 m/s weight-shift
        //     travel + crossover yaw don't fling TORSO/HEAD-anchored cloth (that flung A's cardigan
        //     hem into a fake floor-length skirt). Leg-anchored cloth is deliberately NOT absorbed.
        j.center = vrm.scene;
        // (2) DRAG FLOOR everywhere: VRoid ships several chains with dragForce 0 (undamped); a floor
        //     is inert at rest, it just lets cloth settle instead of ringing. (VRoid's own hair ≈0.4.)
        j.settings.dragForce = Math.max(j.settings.dragForce, 0.35);
        // (3) PIN leg-anchored cloth. VRoid parents the coat-tail chains (J_Sec_*_CoatSkirt*) to the
        //     LOWER-LEG bones with drag 0 — and the foot-IK pumps the knees every beat, driving them
        //     to a ~176° flail = a floor-length fake "skirt" (AvatarSample_C, and A's residual). The
        //     centre can't help (the excitation is leg-local). Measured: at 165° flail it's a full
        //     bell; even stiffness 8/drag 0.9 leaves ~35° (still a skirt) — it only reads as PANTS
        //     when the panels hang near-flush (rigid, following the leg). Detect by walking up to a
        //     leg bone and pin hard so the coat rides the shin instead of resonating. Hair
        //     (head/neck-anchored) is untouched.
        let anc: THREE.Object3D | null = joint.bone?.parent ?? null;
        for (let k = 0; k < 6 && anc; k++, anc = anc.parent) {
          if (/(?:upper|lower)?leg|knee|shin|thigh/i.test(anc.name)) {
            j.settings.stiffness = Math.max(j.settings.stiffness, 40);
            j.settings.dragForce = Math.max(j.settings.dragForce, 0.96);
            break;
          }
        }
      }
      vrm.springBoneManager.setInitState(); // seed verlet state in centre space, matrices current
    }

    // Retarget the groove onto the VRM humanoid with a per-bone GAIN map. The clip drives the
    // arms/hands and the SPINE/CHEST at full strength — that authored samba torso sway is what
    // reads as real dancing — with the hips damped (the procedural contrapposto + weight-lean
    // layer rides on top) and the legs dropped (foot-IK owns them). The balance model composes
    // as clipPose·Δ each frame (post-multiply, one writer per bone), so there's no slerp-fight —
    // the old mistake was stripping the clip's torso and trying to re-synthesise it procedurally,
    // which could only manage ~0.04 rad and read as a rigid plank.
    const vrmClip = retargetMixamoToVrm(sourceFbx.animations[0], vrm, sourceFbx, {
      hips: 0.75,
      spine: 1,
      chest: 1,
      upperChest: 1,
      neck: 0.9,
      head: 0.75,
      leftShoulder: 1,
      leftUpperArm: 1,
      leftLowerArm: 1,
      leftHand: 1,
      rightShoulder: 1,
      rightUpperArm: 1,
      rightLowerArm: 1,
      rightHand: 1,
    });
    this.clipDur = vrmClip.duration;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.mixer.clipAction(vrmClip).play();

    // Centre-line bones the balance Δ post-multiplies onto the clip pose each frame.
    this.hips = this.raw('hips');
    this.spine = this.rawOpt('spine');
    this.chest = this.rawOpt('chest');
    this.upperChest = this.rawOpt('upperChest');
    this.head = this.rawOpt('head');
    this.baseRotY = vrm.scene.rotation.y;
    this.setupLegs();
    // The looping no-chart routine (ankleY/legLen are final after setupLegs).
    this.synthTl = buildSynthTimeline(PANEL, HOME, this.ankleY);

    // Renderer — shared device (offscreen) or own device (canvas).
    void format; // reserved: the offscreen RT format three picks is sampleable as-is
    if (device) {
      // Cap the OFFSCREEN render resolution — the dancer is a background element and
      // the composite upscales with a linear sampler, so rendering the ~25k-tri VRM at
      // full 4K every frame is wasted GPU. Big saving on high-DPI, invisible in motion.
      const [cw, ch] = capOffscreen(w, h);
      this.renderer = new THREE.WebGPURenderer({
        canvas: canvas ?? (new OffscreenCanvas(cw, ch) as unknown as HTMLCanvasElement),
        device,
        antialias: true,
        alpha: true,
      });
      this.rt = new THREE.RenderTarget(cw, ch, { depthBuffer: true, samples: 4 });
      this.renderer.setSize(cw, ch, false);
    } else {
      this.renderer = new THREE.WebGPURenderer({ canvas: canvas!, antialias: true });
      this.renderer.setPixelRatio(
        Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1),
      );
      this.renderer.setSize(w, h, false);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    await this.renderer.init();
    if (this.disposed) return;

    this.frameCamera(w, h);
    // We drive the VRM's world matrices manually every frame (the pose pipeline ends with an
    // updateMatrixWorld before the spring bones, which themselves keep their chains current).
    // Turn OFF the renderer's automatic per-frame sweep at the ROOT scene so it doesn't
    // redundantly re-traverse all ~240 VRM nodes on top of ours. The pad/lights are static
    // (updated once). NOTE: the flag must be on the ROOT, not vrm.scene — with it on vrm.scene,
    // `vrm.scene.updateMatrixWorld(true)` skips recomputing vrm.scene's OWN world matrix, so
    // `vrm.scene.position` (the whole-body CoM translation) never reached the rendered bones.
    this.scene.updateMatrixWorld(true);
    this.scene.matrixWorldAutoUpdate = false;
    this.ready = true;
  }

  private raw(n: VRMHumanBoneName): THREE.Object3D {
    return this.vrm.humanoid!.getRawBoneNode(n) as THREE.Object3D;
  }
  private rawOpt(n: VRMHumanBoneName): THREE.Object3D | null {
    return (this.vrm.humanoid!.getRawBoneNode(n) as THREE.Object3D | null) ?? null;
  }

  private setupLegs(): void {
    const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
    const fwdLocal = (o: THREE.Object3D) =>
      this.FWD.clone()
        .applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()).invert())
        .normalize();
    const mk = (hn: VRMHumanBoneName, kn: VRMHumanBoneName, an: VRMHumanBoneName): Leg => {
      const hip = this.raw(hn);
      const knee = this.raw(kn);
      const ankle = this.raw(an);
      return {
        hip,
        knee,
        ankle,
        L1: wp(hip).distanceTo(wp(knee)),
        L2: wp(knee).distanceTo(wp(ankle)),
        hipChild: knee.position.clone().normalize(),
        kneeChild: ankle.position.clone().normalize(),
        hipRef: fwdLocal(hip),
        kneeRef: fwdLocal(knee),
        footBind: ankle.getWorldQuaternion(new THREE.Quaternion()),
      };
    };
    const left = mk('leftUpperLeg', 'leftLowerLeg', 'leftFoot');
    const right = mk('rightUpperLeg', 'rightLowerLeg', 'rightFoot');
    this.legs = [left, right];
    // MIRROR mapping: the dancer FACES the viewer, so her anatomical left leg is on the
    // viewer's RIGHT. The chart's left foot (index 0, home at −x/screen-left) must
    // therefore drive the VRM's RIGHT leg (whose hip is on the screen-left side) — else
    // the legs scissor into an X to reach the arrows (worst on a wide jump).
    this.footLeg = [right, left];
    this.ankleY = 0.5 * (wp(left.ankle).y + wp(right.ankle).y);
    this.legLen = left.L1 + left.L2;
    this.socketH = this.ankleY + this.legLen * 0.88;
    for (const h of HOME) h.setY(this.ankleY);
    for (let f = 0; f < 2; f++) this.footPos[f].copy(HOME[f]); // seed at rest, not (0,0,0)
  }

  private frameCamera(w: number, h: number): void {
    this.mixer.setTime(0);
    this.vrm.update(1 / 60);
    this.vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.vrm.scene);
    box.expandByPoint(new THREE.Vector3(0.5, 0, 0.5));
    box.expandByPoint(new THREE.Vector3(-0.5, 0, -0.5));
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    this._center = [0, c.y, 0];
    this._radius = 0.5 * Math.max(size.y, size.x, size.z);
    const dist =
      (Math.max(size.y, size.x * (h / w)) * 1.15) /
      (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.camera.position.set(0, c.y + 0.05, dist);
    this.camera.lookAt(0, c.y - 0.1, 0);
  }

  /** The render camera + its look target — for the ?vrm orbit controls. */
  get cam(): THREE.PerspectiveCamera {
    return this.camera;
  }
  get orbitTarget(): readonly [number, number, number] {
    return [0, this._center[1] - 0.1, 0];
  }

  setSteps(steps: readonly DancerStep[]): void {
    // Precompute the whole footwork timeline once; empty → fall back to the looping synth routine.
    this.chartTl = steps.length ? buildChartTimeline(steps, PANEL, HOME, this.ankleY) : null;
  }

  get center(): readonly [number, number, number] {
    return this._center;
  }
  get radius(): number {
    return this._radius;
  }

  setTint(r: number, g: number, b: number): void {
    if (!this.keyLight) return;
    this.keyLight.color.setRGB(r * 0.95, g * 0.93, b * 0.9);
    this.hemi.color.setRGB(r * 0.5, g * 0.5, b * 0.55);
  }
  setEnv(r: number, g: number, b: number, strength = 0.7): void {
    if (!this.rimLight) return;
    this.rimLight.color.setRGB(r, g, b);
    this.rimLight.intensity = 1.0 + strength;
  }

  /** The offscreen result as a GPUTextureView to composite (in-game). Null until the
   *  first render completes (three compiles pipelines async on first use). Cached —
   *  the underlying GPUTexture is stable between resizes, so the view is only rebuilt
   *  when three swaps it (avoids a per-frame createView in the composite). */
  get colorView(): GPUTextureView | null {
    if (!this.rt) return null;
    const data = (
      this.renderer.backend as unknown as { get(t: unknown): { texture?: GPUTexture } }
    ).get(this.rt.texture);
    const tex = data?.texture ?? null;
    if (!tex) return null;
    if (tex !== this.cachedTex) {
      this.cachedTex = tex;
      this.cachedView = tex.createView();
    }
    return this.cachedView;
  }
  private cachedTex: GPUTexture | null = null;
  private cachedView: GPUTextureView | null = null;
  private skelHelper: THREE.SkeletonHelper | null = null;
  private noteMarks: THREE.Mesh[] = [];
  private showNotes = false;

  /** Toggle the descending upcoming-step markers (?vrm debug aid). */
  setShowNotes(on: boolean): void {
    this.showNotes = on;
    if (!on) for (const m of this.noteMarks) m.visible = false;
  }

  /** Toggle a bone-skeleton overlay (drawn over the mesh) — a ?vrm debug aid to see the twist. */
  showSkeleton(on: boolean): void {
    if (!this.ready) return;
    if (on && !this.skelHelper) {
      this.skelHelper = new THREE.SkeletonHelper(this.vrm.scene);
      const m = this.skelHelper.material as THREE.Material & { depthTest?: boolean };
      m.depthTest = false;
      m.transparent = true;
      this.scene.add(this.skelHelper);
    }
    if (this.skelHelper) this.skelHelper.visible = on;
  }

  private qTwist = new THREE.Quaternion();
  private qSwing = new THREE.Quaternion();
  private qScaled = new THREE.Quaternion();

  /** Scale a bone's Y-axis TWIST (facing rotation) to `keep`× the clip's, leaving roll/pitch.
   *  Tames the samba clip's fast upper-body spin (the "instant twist") without flattening sway. */
  private dampTwist(bone: THREE.Object3D | null, keep: number): void {
    if (!bone || keep >= 0.999) return;
    const q = bone.quaternion;
    this.qTwist.set(0, q.y, 0, q.w).normalize(); // full Y-twist T
    this.qSwing.copy(this.qTwist).invert().premultiply(q); // swing S = q · T⁻¹  (roll/pitch only)
    this.qScaled.identity().slerp(this.qTwist, keep); // scaled twist
    q.copy(this.qSwing).multiply(this.qScaled); // S · (keep·T)
  }

  /** Scale a bone's SWING (roll/pitch = the LEAN/tilt) to `keep`× the clip's, leaving the twist.
   *  Cancels the samba clip's torso lean, which can read oddly against the balance model's lean. */
  private dampSwing(bone: THREE.Object3D | null, keep: number): void {
    if (!bone || keep >= 0.999) return;
    const q = bone.quaternion;
    this.qTwist.set(0, q.y, 0, q.w).normalize(); // Y-twist T
    this.qSwing.copy(this.qTwist).invert().premultiply(q); // swing S = q · T⁻¹
    this.qScaled.identity().slerp(this.qSwing, keep); // scaled swing S^keep
    q.copy(this.qScaled).multiply(this.qTwist); // (keep·S) · T
  }

  /** One semi-implicit spring step for a [position, velocity] pair. dt-correct (identical
   *  trajectory at 60/144 Hz); a `cut` (song seek/loop) snaps to the target instead. */
  private sp2(s: number[], target: number, w: number, z: number, dt: number, cut: boolean): void {
    if (cut) {
      s[0] = target;
      s[1] = 0;
      return;
    }
    const a = w * w * (target - s[0]) - 2 * z * w * s[1];
    s[1] += a * dt;
    s[0] += s[1] * dt;
  }

  /** Post-multiply the weight-lean Δ onto a centre-line bone's CLIP pose (bone = clip · Δ). The
   *  lean is distributed up the spine (cumulative 1.0 at the top) so the shoulders lead — the body
   *  reaches into its travel. No rest quat: humanoid.update() already deposited the clip pose. */
  private writeSpine(bone: THREE.Object3D | null, wgt: number): void {
    if (!bone) return;
    // pitch = weight-lean + breathing (chest opens on the inhale); yaw = step-opposition twist.
    this.eChest.set(
      (LEAN_PITCH_SIGN * this.sLeanP[0] + PELVIS_PITCH_SIGN * this._breath) * wgt,
      this.sChestY[0] * wgt,
      LEAN_ROLL_SIGN * this.sLeanR[0] * wgt,
    );
    bone.quaternion.multiply(this.qChest.setFromEuler(this.eChest));
  }

  /** Advance one frame: the balance model + arm clip + foot-IK + spring bones. */
  build(now: number, beat: number, dt: number): void {
    if (!this.ready) return;
    const vrm = this.vrm;
    // Guard the clock inputs: a NaN/negative from a song seek/glitch would poison every
    // downstream position. The feet are a pure function of beat, so they can't freeze; the
    // body springs just need finite dt.
    if (!Number.isFinite(now)) now = 0;
    if (!Number.isFinite(dt) || dt < 0) dt = 1 / 60;
    dt = Math.min(dt, 1 / 20);
    const b = Number.isFinite(beat) ? beat : now * 1.4;

    // Beat delta → cut detection. A cut snaps every spring to its target this frame (so she
    // doesn't GLIDE across the pad after a song restart). Only a BACKWARD jump counts as a cut
    // (a loop/seek/restart): a big FORWARD jump is almost always a frame hitch (GC, tab blur) —
    // the wall-clock beat leaps but it's not a real seek, and snapping on it caused the body to
    // "instantly twist" at random. Forward jumps just let the springs ease to the new pose.
    const db = b - this.prevBeat;
    const cut = db < -0.25;
    this._lastCut = cut;
    if (!cut && dt > 1e-5) {
      this.bps += (THREE.MathUtils.clamp(db / dt, 0.3, 8) - this.bps) * 0.03;
    }
    this.prevBeat = b;
    const tempo = THREE.MathUtils.clamp(Math.sqrt(this.bps / 2.13), 0.8, 1.3);

    // ---- Upper body: the groove clip, BEAT-LOCKED, arms only ----
    // The clip drives only shoulders/arms/hands; its phase is locked to the song beat so arm
    // accents land on the music at any tempo (it used to run on wall time, unrelated to the
    // beat — half of why the body read as detached). humanoid.update() resets the centre-line
    // bones to rest; the balance model writes them below. Arms are children of upperChest, so
    // they automatically ride the procedural torso wave with no extra code.
    const cb = this.tune.clipBeats;
    this.mixer.setTime(((((b % cb) + cb) % cb) / cb) * this.clipDur);
    vrm.humanoid?.update();
    // Strip the clip's own Y-rotation (default) — the samba spins the hips AND twists the torso
    // hard, which is the "instant twisting" seen from the side. The whole-body TURN comes from the
    // scene-yaw crossover pivot instead; the clip keeps only its roll/pitch sway (swing-twist
    // decomposition leaves those). clipTwist>0 dials the samba rotation back in if wanted.
    const tt = this.tune.clipTwist;
    const cl = this.tune.clipLean;
    this.dampTwist(this.hips, tt);
    this.dampTwist(this.spine, tt);
    this.dampTwist(this.chest, tt);
    this.dampTwist(this.upperChest, tt);
    // Cancel/scale the clip's torso LEAN (roll/pitch) on the spine — it can read oddly against the
    // balance model's own lean. (Hips keep their sway; only the upper torso tilt is scaled.)
    this.dampSwing(this.spine, cl);
    this.dampSwing(this.chest, cl);
    this.dampSwing(this.upperChest, cl);

    // ---- Feet: pure function of beat (never freezes across a loop/seek) ----
    const tl = this.chartTl ?? this.synthTl!;
    const S = this.sampled;
    sampleFeet(tl, b, S);
    for (let f = 0; f < 2; f++) {
      this.footPos[f].copy(S.pos[f]);
      this.support[f] = S.support[f];
      this.footPitch[f] = S.pitch[f] * this.tune.footRoll; // heel-toe articulation strength
    }
    this.litPanel = S.litPanel;
    const jumpLift = S.jumpLift * this.legLen;

    // Both feet converging on one arrow would clip — spread them to a minimum stance width,
    // each toward its own hip's side (foot 0 → −x, foot 1 → +x).
    const FOOT_GAP = 0.16;
    const sepX = this.footPos[1].x - this.footPos[0].x;
    const sep = Math.hypot(sepX, this.footPos[1].z - this.footPos[0].z);
    if (sep < FOOT_GAP) {
      const push = 0.5 * (FOOT_GAP - sep);
      this.footPos[0].x -= push;
      this.footPos[1].x += push;
    }

    // ---- Centre of mass / balance: the pelvis ROCKS onto the weight-bearing foot ----
    // A dancer's hips sit OVER the foot they're standing on and transfer to the next as they step
    // — they do not hover at the midpoint. Targeting the support-weighted centroid did exactly
    // that: with the feet on opposite panels the centroid IS the centre, so the pelvis looked
    // stuck there. Instead target the ACTIVE foot: during a step, transfer from the planted
    // (stance) foot to the swinging foot's destination (commit late, u²); between steps hold over
    // the most-recently-landed foot; on a jump aim for the midpoint of the two landing spots.
    const u0 = S.swingU[0];
    const u1 = S.swingU[1];
    let tgtX: number;
    let tgtZ: number;
    if (u0 > 0.05 && u1 > 0.05) {
      tgtX = 0.5 * (S.dest[0].x + S.dest[1].x); // jump — fly toward the landing midpoint
      tgtZ = 0.5 * (S.dest[0].z + S.dest[1].z);
    } else if (u0 > 0.05 || u1 > 0.05) {
      const sw = u0 >= u1 ? 0 : 1; // the swinging foot
      const st = sw === 0 ? 1 : 0; // the planted stance foot bearing weight
      const k = S.swingU[sw] * S.swingU[sw]; // commit late — weight arrives ~at the land
      tgtX = this.footPos[st].x * (1 - k) + S.dest[sw].x * k;
      tgtZ = this.footPos[st].z * (1 - k) + S.dest[sw].z * k;
    } else {
      const act = b - S.landBeat[0] <= b - S.landBeat[1] ? 0 : 1; // most-recently-landed foot
      tgtX = this.footPos[act].x;
      tgtZ = this.footPos[act].z;
    }
    // PARTIAL commit (~0.6): the pelvis leans TOWARD the weight foot without stacking directly
    // over it — full commit read as over-exaggerated once the translation actually rendered. She
    // stays inside her support base (both feet), so it's a natural weight shift, not a topple.
    // Soft spring (ω≈9) so the pelvis FLOWS foot to foot instead of snapping. ζ=0.75 settles.
    const comTgtX = tgtX * this.tune.commitX;
    const comTgtZ = tgtZ * this.tune.commitZ;
    this.sp2(this.sComX, comTgtX, this.tune.comStiff * tempo, 0.75, dt, cut);
    this.sp2(this.sComZ, comTgtZ, this.tune.comStiff * tempo, 0.75, dt, cut);

    // Lean-and-catch: the upper body leans INTO the travel (velocity) and toward the not-yet-
    // reached target (error), then settles as the CoM arrives — a fast shift reads as a committed
    // lean, not a rigid slide. Distributed up the spine (shoulders lead) in writeSpine below.
    const errX = comTgtX - this.sComX[0];
    const errZ = comTgtZ - this.sComZ[0];
    this.sp2(
      this.sLeanR,
      THREE.MathUtils.clamp(0.12 * this.sComX[1] + this.tune.leanRoll * errX, -0.22, 0.22),
      10,
      1,
      dt,
      cut,
    );
    this.sp2(
      this.sLeanP,
      THREE.MathUtils.clamp(0.1 * this.sComZ[1] + this.tune.leanPitch * errZ, -0.15, 0.18),
      10,
      1,
      dt,
      cut,
    );

    // Vertical CoM — a small pre-beat pump (dancers entrain even between steps) plus a downward
    // IMPULSE on every foot land, scaled by how far that foot travelled: a big crossover sinks
    // deep, an 8th run rolls continuously, a hold idles gently. This is the single biggest
    // "she's dancing to THIS chart" signal — the bounce is a function of the actual footwork.
    const land0 = S.landBeat[0] !== this.lastLand0 && S.landBeat[0] > -1e8;
    const land1 = S.landBeat[1] !== this.lastLand1 && S.landBeat[1] > -1e8;
    if (!cut) {
      const bn = this.tune.bounce;
      if (land0 && land1 && Math.abs(S.landBeat[0] - S.landBeat[1]) < 1e-6) {
        const d = Math.max(S.stepDist[0], S.stepDist[1]);
        this.sComY[1] -= THREE.MathUtils.clamp(0.25 + 1.2 * d, 0.25, 0.8) * 1.6 * bn; // jump hit
        this.holdBeats = 0;
      } else {
        if (land0) {
          this.sComY[1] -= THREE.MathUtils.clamp(0.25 + 1.2 * S.stepDist[0], 0.25, 0.8) * bn;
          this.holdBeats = 0;
        }
        if (land1) {
          this.sComY[1] -= THREE.MathUtils.clamp(0.25 + 1.2 * S.stepDist[1], 0.25, 0.8) * bn;
          this.holdBeats = 0;
        }
      }
    }
    this.lastLand0 = S.landBeat[0];
    this.lastLand1 = S.landBeat[1];
    if (!land0 && !land1) this.holdBeats = Math.min(4, this.holdBeats + Math.max(0, db));
    const phi = b - Math.floor(b);
    const pulse = (p: number): number => Math.exp(-4 * (p - Math.floor(p)));
    const pumpAmp = this.legLen * (0.015 + 0.015 * (Math.min(this.holdBeats, 2) / 2));
    // Crouch when the knees are tight (last frame's split amount): sinking bends BOTH knees,
    // which gives the depth-split poles more travel to separate them — so the pelvis can groove
    // freely (hip clip at full) without the busier hips tightening the legs into a clip.
    const crouch = this.legLen * 0.07 * this.sepAmtPrev;
    // Plié: sink onto the weight-bearing leg (knees soften under load). Uses last frame's loadLP.
    const kneeSoft = this.tune.kneeSoft * Math.abs(this.loadLP) * this.legLen * 0.05;
    // Anticipatory pre-load: a small dip just BEFORE a planted foot launches into its step (a
    // dancer loads the support leg to push off). Peaks ~0.6 beat ahead, gone by the swing.
    let imminent = 0;
    for (let f = 0; f < 2; f++) {
      if (S.swingU[f] < 0.01) {
        const ttl = S.nextLand[f] - b;
        if (ttl > 0 && ttl < 1)
          imminent = Math.max(imminent, Math.max(0, 1 - Math.abs(ttl - 0.62) / 0.22));
      }
    }
    const preLoad = this.tune.preLoad * imminent * this.legLen * 0.03;
    this.sp2(
      this.sComY,
      -pumpAmp * pulse(phi + 0.12) - crouch - kneeSoft - preLoad,
      22,
      0.55,
      dt,
      cut,
    );
    const comY = this.sComY[0];

    // Loadedness: which leg carries the weight (support-weighted), smoothed. Drives contrapposto.
    const s0 = S.support[0];
    const s1 = S.support[1];
    const Lraw = (s1 - s0) / (s1 + s0 || 1); // +1 → weight on the +x (screen-right, VRM-left) foot
    this.loadLP += (Lraw - this.loadLP) * (cut ? 1 : 1 - Math.exp(-dt / 0.08));

    // ---- Naturalness layers (small, additive) ----
    // How "calm" she is — 0 while stepping, →1 during a hold. Breathing and idle drift are idle
    // behaviours, so they fade IN when the footwork quiets down and fade out when she's busy.
    const calm = THREE.MathUtils.clamp((this.holdBeats - 0.4) / 1.8, 0, 1);
    // Breathing: a slow rise/fall (~4 s), always a little, more when calm.
    this._breath = this.tune.breath * (0.35 + 0.65 * calm) * Math.sin(now * ((2 * Math.PI) / 4.1));
    // Idle drift: two incommensurate sines (never exactly repeats) so a held pose keeps micro-
    // moving instead of freezing. Deterministic (no RNG), tiny amplitude, gated by calm.
    const idle = this.tune.idleSway * calm;
    const idleYaw = idle * 0.05 * (Math.sin(now * 0.61) + 0.5 * Math.sin(now * 1.13 + 2.1));
    const idleRoll = idle * 0.045 * (Math.sin(now * 0.47 + 1.3) + 0.5 * Math.sin(now * 0.89 + 0.4));
    // Opposition: the SWINGING foot pulls the opposite shoulder forward (the natural arm/torso
    // counter-twist of a step). Ties the clip's arms to the ACTUAL footwork — otherwise they just
    // play the loop regardless of where she steps. eased so it flows.
    const opp = (1 - s1) * u1 - (1 - s0) * u0; // >0 → right foot swinging
    this.sp2(this.sChestY, ARM_OPP_SIGN * this.tune.armSwing * 0.5 * opp, 8, 1, dt, cut);
    // Gaze: the head leads toward the foot she's about to step, ramping in over the last ~1.2 beats.
    const gAhead = Math.min(S.nextLand[0] - b, S.nextLand[1] - b);
    const gi = S.nextLand[0] - b <= S.nextLand[1] - b ? 0 : 1;
    let gazeTgt = 0;
    if (S.nextPanel[gi] >= 0 && gAhead >= 0 && gAhead < 1.2) {
      gazeTgt =
        GAZE_SIGN *
        this.tune.gaze *
        THREE.MathUtils.clamp(PANEL[S.nextPanel[gi]].x / 0.3, -1, 1) *
        (1 - gAhead / 1.2) *
        0.35;
    }
    this.sp2(this.sHeadY, gazeTgt, 5, 1, dt, cut);

    // ---- Pelvis Δ: contrapposto + weight-lean, post-multiplied onto the clip's hip sway.
    // The clip (hips gain 0.55) supplies the samba groove; this adds the foot-coupled physics.
    const pelvisRoll = PELVIS_ROLL_SIGN * this.tune.pelvisRoll * this.loadLP; // hip hike, loaded leg
    // Slight forward lean at rest + more as she crouches — a dancer's posture. PELVIS_PITCH_SIGN
    // is negative on this VRM0-mirrored rig (a +X pitch tilts BACK here); without the flip she
    // leaned backward, which showed the moment the clip's own forward lean was dialed down.
    const pelvisPitch =
      PELVIS_PITCH_SIGN * (0.03 + Math.min(0.12, (0.9 * Math.max(0, -comY)) / this.legLen)); // crouch
    const pelvisYaw = THREE.MathUtils.clamp(
      (0.4 * (this.footPos[0].z - this.footPos[1].z)) / 0.6,
      -0.25,
      0.25,
    ); // hips open toward the forward foot
    this.eSway.set(
      pelvisPitch + 0.35 * LEAN_PITCH_SIGN * this.sLeanP[0],
      pelvisYaw + idleYaw,
      pelvisRoll + 0.35 * LEAN_ROLL_SIGN * this.sLeanR[0] + idleRoll,
    );
    this.hips.quaternion.multiply(this.qSway.setFromEuler(this.eSway));
    this._pelvisPitch = pelvisPitch;
    this._pelvisYaw = pelvisYaw;

    // ---- Spine/chest: the weight-lean, distributed spine→chest→upperChest (cumulative 1.0 so
    // the shoulders lead the pelvis into the travel). The clip owns the torso's dance sway; this
    // only adds the reach, composed multiplicatively (bone = clip · Δ), so it can't fight the clip.
    this.writeSpine(this.spine, 0.3);
    this.writeSpine(this.chest, 0.3);
    this.writeSpine(this.upperChest, 0.4);

    // ---- Head: vestibular stabilization (eyes level) + beat nod + GAZE toward the next step.
    this.sp2(this.sHeadR, -0.4 * LEAN_ROLL_SIGN * this.sLeanR[0], 7, 1, dt, cut);
    if (this.head) {
      this.eChest.set(0.03 * pulse(phi + 0.12), this.sHeadY[0], this.sHeadR[0]);
      this.head.quaternion.multiply(this.qChest.setFromEuler(this.eChest));
    }

    // Only the two hip sockets are read for the grounding servo — update just those two chains.
    this.legs[0].hip.updateWorldMatrix(true, false);
    this.legs[1].hip.updateWorldMatrix(true, false);
    const socketY =
      0.5 *
      (this.legs[0].hip.getWorldPosition(this.tmp).y +
        this.legs[1].hip.getWorldPosition(this.tmp2).y);
    vrm.scene.position.y += this.socketH + jumpLift + comY - socketY;

    // Body travels with the CoM (the samba retarget dropped the clip's hip-position track, so
    // all horizontal travel comes from here — she moves OVER her planted feet).
    vrm.scene.position.x = this.sComX[0];
    vrm.scene.position.z = this.sComZ[0];

    // ---- Crossedness, measured in the BODY frame ----
    // A leg is "crossed" when its foot is past the body's own centreline — measured relative to
    // the CoM TRANSLATION only (footPos.x − comX), NOT rotated by the current yaw. Rotating by yaw
    // fed back on itself: with the body turned and a foot on the U/D pad (fore/aft), the rotation
    // term made that foot falsely read as crossed, pushing the yaw further the SAME way — she
    // turned the wrong way. Translation-only has no feedback: a U/D step reads c≈0 (no turn), an
    // L/R crossover reads a clean ±0.3.
    const bodyX = this.sComX[0];
    const lx0 = this.footPos[0].x - bodyX;
    const lx1 = this.footPos[1].x - bodyX;
    const c0 = Math.max(0, lx0); // VRM right leg (hip −x) reaching past centre to +x
    const c1 = Math.max(0, -lx1); // VRM left leg (hip +x) reaching past centre to −x

    // ---- Body yaw: pivot INTO crossovers, provably continuous + rate-limited ----
    // Two terms, both C¹ (no thresholds), summed inside one tanh so the whole thing is smooth and
    // soft-saturating; a hard per-frame cap makes teleporting impossible:
    //  • SINGLE cross (one leg over the line): (c0−c1) turns toward the crossed side.
    //  • DOUBLE cross (BOTH legs swapped — left foot on the right pad and vice-versa): (c0−c1)≈0
    //    so the first term does nothing and she'd stay forward-facing in a full X. Add a term of
    //    magnitude min(c0,c1) (how double-crossed she is) whose DIRECTION is the front-foot choice
    //    sSep (continuous, from the swing destination), so she pivots ~90° to send one leg front
    //    and the other back instead of scissoring. min() and sSep are both continuous → no snap.
    // SINGLE-cross turn (moderate) + DOUBLE-cross turn (up to a full spin). Both C¹, summed then
    // clamped to ±π. The double term ramps with how double-crossed she is, its direction the
    // continuous front-foot choice sSep — so a full swap sends her turning right around and the
    // legs come fully undone instead of scissoring.
    const single = Math.tanh((c0 - c1) / 0.18);
    const dblT = this.sSep[0] * Math.min(1, Math.min(c0, c1) / 0.22);
    const yawTarget =
      this.tune.yawSign *
      THREE.MathUtils.clamp(
        this.tune.yawAmp * single + this.tune.crossTurn * dblT,
        -Math.PI,
        Math.PI,
      );
    const yPrev = this.sYaw[0];
    // yawRate drives BOTH the spring stiffness (the real bottleneck on turn speed) and the hard
    // per-frame cap, so the "Turn speed" knob genuinely controls snappiness. The cap is kept a bit
    // above the spring's own max velocity so it only ever fires as a teleport backstop, never
    // throttling a normal turn.
    const yr = this.tune.yawRate;
    this.sp2(this.sYaw, yawTarget, yr * 2.5, 1, dt, cut);
    if (!cut) {
      const maxStep = yr * 2.5 * dt;
      const dy = this.sYaw[0] - yPrev;
      if (dy > maxStep) this.sYaw[0] = yPrev + maxStep;
      else if (dy < -maxStep) this.sYaw[0] = yPrev - maxStep;
    }
    this.yaw = this.sYaw[0];
    vrm.scene.rotation.y = this.baseRotY + this.yaw;

    // ---- Crossover-safe leg separation: anti-symmetric DEPTH split ----
    // Fade the outward knee-splay to zero as a leg crosses (else the two knees splay INTO each
    // other), and push one knee forward / the other back so they pass at different depths — the
    // separation the (continuity-capped) body yaw can't deliver, and the ONLY thing that works on
    // a symmetric double-cross where the yaw signal cancels. Front foot = the more recently landed
    // (that's what a crossover is); ties fall back to c0−c1, then hysteresis so it never flip-flops.
    // Which foot passes in FRONT — must be STABLE across the whole crossover (a jittery choice
    // leaves sSep≈0 → symmetric poles → no depth separation, the failure on a symmetric double-
    // swing where u0≈u1). Decide by DESTINATION: the foot travelling further to +x passes in
    // front (fixed for the whole swing). Fall back to crossedness, then hysteresis.
    let sepTarget: number;
    const destDx = S.dest[0].x - S.dest[1].x;
    if ((u0 > 0.05 || u1 > 0.05) && Math.abs(destDx) > 0.03) {
      sepTarget = destDx > 0 ? 1 : -1;
    } else if (Math.abs(c0 - c1) > 0.02) {
      sepTarget = c0 > c1 ? 1 : -1;
    } else {
      sepTarget = this.sSep[0] >= 0 ? 1 : -1; // hold (no flip-flop on a symmetric stance)
    }
    this.sp2(this.sSep, sepTarget, 16, 1, dt, cut);
    // Engagement — the split turns on when the knees are about to meet, from three signals:
    //  • lateral proximity: the feet are close in body-x (covers a cross THROUGH centre and a
    //    feet-together stomp — the cases a "both crossed" test misses, which is where it clipped);
    //  • feed-forward: both feet already crossed (a deep double-cross);
    //  • closed-loop feedback from last frame's MEASURED knee gap (catches anything left).
    // DEPTH split only engages on a real CROSS (a leg past centre) — on a close-but-uncrossed
    // stance (both feet near the same spot) a depth split would sweep one knee through the other,
    // so those cases get outward X-SPLAY instead. `crossing` = how far the more-crossed leg is over.
    const crossing = Math.max(c0, c1);
    const crossGate = THREE.MathUtils.clamp(crossing / 0.05, 0, 1);
    const latClose = THREE.MathUtils.clamp((0.3 - Math.abs(lx0 - lx1)) / 0.14, 0, 1);
    // Feed-forward on a single DEEP cross too (a leg reaching across with the other foot on the
    // same side is a clip risk even though only one foot is "crossed"), plus the both-crossed and
    // measured-gap signals.
    const ff = THREE.MathUtils.clamp(Math.max(c0, c1) / 0.18, 0, 1);
    const fbTgt = THREE.MathUtils.clamp((0.16 - this._kneeGap) / 0.05, 0, 1);
    this.sepFb += (fbTgt - this.sepFb) * (cut ? 1 : 1 - Math.exp(-dt / 0.03));
    const sepAmt = crossGate * Math.max(ff, this.sepFb); // depth split, gated to actual crossings
    const closeSplay = latClose * (1 - crossGate); // close + uncrossed → spread the knees sideways
    const front = 0.5 * (1 + this.sSep[0]); // front-ness of foot 0 (0..1)
    this.sepAmtPrev = sepAmt; // fed to next frame's crouch coupling
    const splay0 = -KNEE_OUT * (Math.max(0, 1 - c0 / 0.1) + 0.8 * closeSplay);
    const splay1 = KNEE_OUT * (Math.max(0, 1 - c1 / 0.1) + 0.8 * closeSplay);
    const ks = this.tune.kneeSplit;
    const poleZ0 = Math.max(
      0.3,
      1 + 4.5 * c0 + ks * sepAmt * front - 0.55 * ks * sepAmt * (1 - front),
    );
    const poleZ1 = Math.max(
      0.3,
      1 + 4.5 * c1 + ks * sepAmt * (1 - front) - 0.55 * ks * sepAmt * front,
    );
    // Foot facing: a PLANTED foot can't rotate on the ground (that looked unphysical), so only a
    // foot in the AIR eases its yaw toward the body's current facing — it turns mid-swing and is
    // aligned by the time it lands. Planted feet hold whatever yaw they landed with.
    for (let f = 0; f < 2; f++) {
      const u = S.swingU[f];
      if (u > 0.01) this.footYaw[f] += (this.yaw - this.footYaw[f]) * Math.min(1, u * 1.5);
    }
    this.solveLeg(
      this.footLeg[0],
      this.footPos[0],
      splay0,
      poleZ0,
      this.footPitch[0],
      this.footYaw[0],
    );
    this.solveLeg(
      this.footLeg[1],
      this.footPos[1],
      splay1,
      poleZ1,
      this.footPitch[1],
      this.footYaw[1],
    );

    // Settle dependent systems around the FINAL pose (spring bones follow the real legs).
    vrm.scene.updateMatrixWorld(true);
    // TEMP DIAG: knee/ankle separation for the clipping probe (read after the world update).
    this.legs[0].knee.getWorldPosition(this.tmp);
    this.legs[1].knee.getWorldPosition(this.tmp2);
    this._kneeGap = this.tmp.distanceTo(this.tmp2);
    this.legs[0].ankle.getWorldPosition(this.tmp);
    this.legs[1].ankle.getWorldPosition(this.tmp2);
    this._ankleGap = this.tmp.distanceTo(this.tmp2);
    vrm.lookAt?.update(dt);
    vrm.expressionManager?.update();
    vrm.nodeConstraintManager?.update();
    // Skirt/hair physics: step EVERY frame with a small, clamped dt. The old ~72 Hz accumulate
    // handed the solver steps up to 1/20 s, and VRM spring bones overshoot on a big step — which
    // ballooned long skirts (the a/b/c samples) out into a bell. A fixed small sub-step is the
    // stable, standard way; capped at 1/60 so a frame hitch can't blow the cloth up.
    vrm.springBoneManager?.update(Math.min(dt, 1 / 60));
    // The skeleton overlay (debug) doesn't get the renderer's auto-sweep (root scene has it off),
    // so refresh its bone lines from the now-current bone world matrices.
    if (this.skelHelper?.visible) this.skelHelper.updateMatrixWorld(true);

    for (let p = 0; p < 4; p++) {
      const dbl = b - this.litPanel[p];
      const lit = dbl >= 0 && dbl < 1 ? Math.exp(-3 * dbl) : 0;
      this.arrowMats[p].opacity = 0.28 + 0.7 * lit;
    }

    // Upcoming-step markers: descend onto the target pad over the ~2 beats before the hit, landing
    // on the beat (root scene has auto-sweep off, so place + updateMatrixWorld manually).
    if (this.showNotes) {
      const LOOK = 2;
      for (let f = 0; f < 2; f++) {
        const mk = this.noteMarks[f];
        if (!mk) continue;
        const p = S.nextPanel[f];
        const ahead = S.nextLand[f] - b;
        if (p >= 0 && ahead >= -0.05 && ahead < LOOK) {
          const a = Math.max(0, ahead);
          mk.visible = true;
          mk.position.set(PANEL[p].x, 0.02 + a * 0.5, PANEL[p].z);
          (mk.material as THREE.MeshBasicNodeMaterial).opacity = 0.9 * (1 - a / LOOK) + 0.15;
          mk.updateMatrixWorld(true);
        } else {
          mk.visible = false;
        }
      }
    }
  }

  private support = [1, 1];
  private _kneeGap = 0;
  private _ankleGap = 0;
  private _pelvisPitch = 0;
  private _pelvisYaw = 0;
  private _lastCut = false;

  /** Distance in the XZ plane from (px,pz) to the segment [(ax,az),(bx,bz)]. */
  private static segDist(
    px: number,
    pz: number,
    ax: number,
    az: number,
    bx: number,
    bz: number,
  ): number {
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    const t = THREE.MathUtils.clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1);
    return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
  }

  /** A snapshot of the balance state for the ?vrm verification harness (coupling metrics). */
  debug(): Record<string, number> {
    const S = this.sampled;
    const cx = this.sComX[0];
    const cz = this.sComZ[0];
    // Whole-body scene turn (deg) vs the CLIP's upper-body twist (deg) — the ?vrm readout shows
    // both so we can tell which one is "twisting": the balance yaw or the samba clip's torso.
    const bone = this.upperChest ?? this.chest ?? this.hips;
    let twistDeg = 0;
    if (bone) {
      bone.getWorldQuaternion(this.qW);
      const q = this.qW;
      const cy = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
      twistDeg = ((cy - this.baseRotY - this.yaw) * 180) / Math.PI;
      twistDeg = ((((twistDeg + 180) % 360) + 360) % 360) - 180; // wrap to [-180,180]
    }
    return {
      b: this.prevBeat,
      comX: cx,
      comY: this.sComY[0],
      comZ: cz,
      comVX: this.sComX[1],
      yaw: this.yaw,
      yawDeg: (this.yaw * 180) / Math.PI,
      twistDeg,
      cut: this._lastCut ? 1 : 0,
      load: this.loadLP,
      pelvisRoll: PELVIS_ROLL_SIGN * 0.09 * this.loadLP,
      pelvisPitch: this._pelvisPitch,
      pelvisYaw: this._pelvisYaw,
      leanR: this.sLeanR[0],
      leanP: this.sLeanP[0],
      headR: this.sHeadR[0],
      kneeGap: this._kneeGap,
      ankleGap: this._ankleGap,
      // Balance: CoM distance to the support she's committing to (dest) and standing on (pos).
      balErrDest: ThreeVrmDancer.segDist(
        cx,
        cz,
        S.dest[0].x,
        S.dest[0].z,
        S.dest[1].x,
        S.dest[1].z,
      ),
      balErrNow: ThreeVrmDancer.segDist(cx, cz, S.pos[0].x, S.pos[0].z, S.pos[1].x, S.pos[1].z),
      f0x: this.footPos[0].x,
      f0z: this.footPos[0].z,
      f1x: this.footPos[1].x,
      f1z: this.footPos[1].z,
      s0: this.support[0],
      s1: this.support[1],
      u0: S.swingU[0],
      u1: S.swingU[1],
      l0: S.landBeat[0],
      l1: S.landBeat[1],
    };
  }

  private orient(
    bone: THREE.Object3D,
    child: THREE.Vector3,
    ref: THREE.Vector3,
    aimWorld: THREE.Vector3,
  ): void {
    const x1 = this.oX1.copy(child);
    const y1 = this.oY1.copy(ref).addScaledVector(x1, -ref.dot(x1)).normalize();
    const z1 = this.oZ1.crossVectors(x1, y1);
    this.mL.makeBasis(x1, y1, z1);
    const X = this.oX.copy(aimWorld).normalize();
    const sec = this.oSec.copy(this.FWD);
    if (Math.abs(sec.dot(X)) > 0.98) sec.set(0, 1, 0);
    const Y = sec.addScaledVector(X, -sec.dot(X)).normalize();
    const Z = this.oZ.crossVectors(X, Y);
    this.mW.makeBasis(X, Y, Z);
    this.qW
      .setFromRotationMatrix(this.mW)
      .multiply(this.qLl.setFromRotationMatrix(this.mL).invert());
    bone.parent!.getWorldQuaternion(this.qP);
    bone.quaternion.copy(this.qP.invert().multiply(this.qW));
  }

  private solveLeg(
    leg: Leg,
    targetWorld: THREE.Vector3,
    outX: number,
    fwdZ = 1,
    pitch = 0,
    footYaw = 0,
  ): void {
    leg.hip.updateWorldMatrix(true, false);
    leg.hip.getWorldPosition(this.hipPos);
    const toT = this.sToT.copy(targetWorld).sub(this.hipPos);
    const d = THREE.MathUtils.clamp(
      toT.length(),
      Math.abs(leg.L1 - leg.L2) + 1e-3,
      leg.L1 + leg.L2 - 1e-3,
    );
    const n = this.sN.copy(toT).normalize();
    const cosHip = THREE.MathUtils.clamp(
      (leg.L1 * leg.L1 + d * d - leg.L2 * leg.L2) / (2 * leg.L1 * d),
      -1,
      1,
    );
    const hipAngle = Math.acos(cosHip);
    // Pole aims the knee: forward (fwdZ, boosted for a crossing leg so it bends in FRONT) with
    // a per-leg OUTWARD bias (outX, a natural turned-out stance that keeps thighs from
    // converging). Projected perpendicular to the leg, so it only sets the bend plane.
    const pole = this.sPole.set(outX, 0, fwdZ);
    pole.addScaledVector(n, -pole.dot(n));
    if (pole.lengthSq() < 1e-6) pole.set(0, 0, 1);
    pole.normalize();
    const axis = this.sAxis.crossVectors(n, pole).normalize();
    const kneeDir = this.sKneeDir.copy(n).applyAxisAngle(axis, hipAngle);
    this.kneePos.copy(this.hipPos).addScaledVector(kneeDir, leg.L1);
    this.orient(leg.hip, leg.hipChild, leg.hipRef, this.sAim.copy(this.kneePos).sub(this.hipPos));
    leg.hip.updateWorldMatrix(true, false);
    leg.knee.getWorldPosition(this.kneePos);
    this.orient(
      leg.knee,
      leg.kneeChild,
      leg.kneeRef,
      this.sAim.copy(targetWorld).sub(this.kneePos),
    );
    leg.knee.updateWorldMatrix(true, false);
    // Ankle holds flat in world (footBind) but TURNS with the body yaw so the toes follow her
    // facing (she can spin right around on a full crossover and her feet come with her), then
    // articulates by `pitch` about its own axis — toe leading a swing / rolling on the beat.
    leg.ankle.parent!.getWorldQuaternion(this.qP);
    leg.ankle.quaternion.copy(
      this.qP
        .invert()
        .multiply(this.qFootYaw.setFromAxisAngle(this.upAxis, footYaw))
        .multiply(leg.footBind)
        .multiply(this.qFoot.setFromAxisAngle(this.footAxis, pitch)),
    );
  }

  /** Render the current pose. In-game: pass the dynamic camera; standalone: omit. */
  render(cam?: DancerCamera): void {
    if (!this.ready) return;
    if (cam) {
      if (cam.fovY) this.camera.fov = (cam.fovY * 180) / Math.PI;
      if (cam.eye) this.camera.position.set(cam.eye[0], cam.eye[1], cam.eye[2]);
      if (cam.target) this.camera.lookAt(cam.target[0], cam.target[1], cam.target[2]);
      this.camera.updateProjectionMatrix();
    }
    if (this.rt) {
      this.renderer.setRenderTarget(this.rt);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  setSize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.rt) {
      // Offscreen: render at the capped resolution (see capOffscreen); skip no-op resizes.
      const [cw, ch] = capOffscreen(w, h);
      if (cw !== this.rt.width || ch !== this.rt.height) {
        this.renderer?.setSize(cw, ch, false);
        this.rt.setSize(cw, ch);
      }
    } else {
      this.renderer?.setSize(w, h, false);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.rt?.dispose();
    this.renderer?.dispose();
  }
}
