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

// Panel → floor position (metres). L/R straddle x; U far (−z), D near (+z).
const PANEL = [
  new THREE.Vector3(-0.3, 0, 0), // 0 L
  new THREE.Vector3(0, 0, 0.3), //  1 D
  new THREE.Vector3(0, 0, -0.3), // 2 U
  new THREE.Vector3(0.3, 0, 0), //  3 R
];
const PANEL_COL = [0xff3fa0, 0x8f6bff, 0x4fd6ff, 0xffa63f];
const HOME = [new THREE.Vector3(-0.09, 0, 0.05), new THREE.Vector3(0.09, 0, 0.05)]; // L/R rest
// Sign of the contrapposto hip hike vs. the loaded side, for this VRM0-mirrored rig (the
// retarget flips x/z, so the correct sign is verified by eye in ?vrm, not derived on paper).
const PELVIS_ROLL_SIGN = 1;
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
  private hipsRestQuat = new THREE.Quaternion();
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
  private readonly footAxis = new THREE.Vector3(1, 0, 0);
  private yaw = 0;
  private springAccum = 0; // spring-bone physics runs at a fixed cap, not the full refresh

  // ---- Centre-of-mass / balance state — the ONE physical system the whole body follows.
  // Every visible motion (pelvis shift/roll/pitch/yaw, torso S-curve, head, bounce, travel) is
  // a consequence of these, so the upper body can never be "detached" from the feet: the feet
  // are its only excitation. Each spring is a [position, velocity] pair; sp2() integrates them
  // dt-correctly. clipBeats beat-locks the 18.2 s arm clip so it plays at ~authored speed at
  // 128 BPM (measured: 2.13 beats/s × 18.2 s ≈ 39 beats/loop); faster/slower songs scale it.
  clipBeats = 39;
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
  private sChestR = [0, 0]; // chest counter-roll
  private sChestY = [0, 0]; // chest counter-yaw
  private sChestP = [0, 0]; // chest pitch
  private sHeadR = [0, 0]; // head stabilization roll
  private sHeadY = [0, 0]; // head stabilization yaw
  private spine: THREE.Object3D | null = null;
  private chest: THREE.Object3D | null = null;
  private upperChest: THREE.Object3D | null = null;
  private head: THREE.Object3D | null = null;
  private spineRest = new THREE.Quaternion();
  private chestRest = new THREE.Quaternion();
  private upperChestRest = new THREE.Quaternion();
  private headRest = new THREE.Quaternion();
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
    this.scene.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);

    // Retarget the groove onto the VRM humanoid — but keep ONLY the arm/shoulder tracks. The
    // centre line (hips/spine/chest/head) and legs are owned outright by the balance model + IK;
    // with no clip tracks there, humanoid.update() resets those bones to rest each frame and we
    // write on top — no clip-vs-model fight (the old cause of the robotic, detached torso).
    const vrmClip = retargetMixamoToVrm(sourceFbx.animations[0], vrm, sourceFbx, [
      'leftShoulder',
      'leftUpperArm',
      'leftLowerArm',
      'leftHand',
      'rightShoulder',
      'rightUpperArm',
      'rightLowerArm',
      'rightHand',
    ]);
    this.clipDur = vrmClip.duration;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.mixer.clipAction(vrmClip).play();

    // Centre-line bones the balance model writes each frame (absolute: rest · Δ). Capture their
    // rest orientations now, before any animation touches them.
    this.hips = this.raw('hips');
    this.hipsRestQuat.copy(this.hips.quaternion);
    this.spine = this.rawOpt('spine');
    this.chest = this.rawOpt('chest');
    this.upperChest = this.rawOpt('upperChest');
    this.head = this.rawOpt('head');
    if (this.spine) this.spineRest.copy(this.spine.quaternion);
    if (this.chest) this.chestRest.copy(this.chest.quaternion);
    if (this.upperChest) this.upperChestRest.copy(this.upperChest.quaternion);
    if (this.head) this.headRest.copy(this.head.quaternion);
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
    // Turn OFF the renderer's automatic per-frame scene sweep so it doesn't redundantly
    // re-traverse all ~240 VRM nodes on top of ours. The pad/lights are static (updated once).
    this.scene.updateMatrixWorld(true);
    vrm.scene.matrixWorldAutoUpdate = false;
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

  /** Write a centre-line bone absolutely (rest · Δ), sharing the chest S-curve across joints. */
  private writeSpine(bone: THREE.Object3D | null, rest: THREE.Quaternion, wgt: number): void {
    if (!bone) return;
    this.eChest.set(this.sChestP[0] * wgt, this.sChestY[0] * wgt, this.sChestR[0] * wgt);
    bone.quaternion.copy(rest).multiply(this.qChest.setFromEuler(this.eChest));
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

    // Beat delta → cut detection (song seek/loop/restart) + a smoothed tempo (beats/sec) that
    // scales the balance springs so the settle stays musical at any BPM. On a cut every spring
    // snaps to its target this frame, so she never GLIDES across the pad after a restart.
    const db = b - this.prevBeat;
    const cut = Math.abs(db) > 0.5;
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
    const cb = this.clipBeats;
    this.mixer.setTime(((((b % cb) + cb) % cb) / cb) * this.clipDur);
    vrm.humanoid?.update();

    // ---- Feet: pure function of beat (never freezes across a loop/seek) ----
    const tl = this.chartTl ?? this.synthTl!;
    const S = this.sampled;
    sampleFeet(tl, b, S);
    for (let f = 0; f < 2; f++) {
      this.footPos[f].copy(S.pos[f]);
      this.support[f] = S.support[f];
      this.footPitch[f] = S.pitch[f];
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

    // ---- Centre of mass / balance: one physical state the whole body follows ----
    // Anticipation: a SWINGING foot pulls weight toward where it's GOING (dest), weighted by
    // swing progress² so the commit builds through the step and is ~¾ done at the land. This is
    // what makes the body LEAD the feet instead of lagging behind them.
    const u0 = S.swingU[0];
    const u1 = S.swingU[1];
    const w0 = u0 > 0 ? 0.25 + 0.75 * u0 * u0 : 1;
    const w1 = u1 > 0 ? 0.25 + 0.75 * u1 * u1 : 1;
    const wsum = w0 + w1 || 1;
    const tgtX = (w0 * S.dest[0].x + w1 * S.dest[1].x) / wsum;
    const tgtZ = (w0 * S.dest[0].z + w1 * S.dest[1].z) / wsum;
    // Horizontal CoM — slightly underdamped (ζ=0.8) so each shift overshoots ~4% and settles
    // (the "weight arrived" cue). G = partial commit (panels are only 0.3 m out).
    this.sp2(this.sComX, tgtX * 0.62, 13 * tempo, 0.8, dt, cut);
    this.sp2(this.sComZ, tgtZ * 0.42, 13 * tempo, 0.8, dt, cut);

    // Vertical CoM — a small pre-beat pump (dancers entrain even between steps) plus a downward
    // IMPULSE on every foot land, scaled by how far that foot travelled: a big crossover sinks
    // deep, an 8th run rolls continuously, a hold idles gently. This is the single biggest
    // "she's dancing to THIS chart" signal — the bounce is a function of the actual footwork.
    const land0 = S.landBeat[0] !== this.lastLand0 && S.landBeat[0] > -1e8;
    const land1 = S.landBeat[1] !== this.lastLand1 && S.landBeat[1] > -1e8;
    if (!cut) {
      if (land0 && land1 && Math.abs(S.landBeat[0] - S.landBeat[1]) < 1e-6) {
        const d = Math.max(S.stepDist[0], S.stepDist[1]);
        this.sComY[1] -= THREE.MathUtils.clamp(0.25 + 1.2 * d, 0.25, 0.8) * 1.6; // jump: one big hit
        this.holdBeats = 0;
      } else {
        if (land0) {
          this.sComY[1] -= THREE.MathUtils.clamp(0.25 + 1.2 * S.stepDist[0], 0.25, 0.8);
          this.holdBeats = 0;
        }
        if (land1) {
          this.sComY[1] -= THREE.MathUtils.clamp(0.25 + 1.2 * S.stepDist[1], 0.25, 0.8);
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
    this.sp2(this.sComY, -pumpAmp * pulse(phi + 0.12), 22, 0.55, dt, cut);
    const comY = this.sComY[0];

    // Loadedness: which leg carries the weight (support-weighted), smoothed. Drives contrapposto.
    const s0 = S.support[0];
    const s1 = S.support[1];
    const Lraw = (s1 - s0) / (s1 + s0 || 1); // +1 → weight on the +x (screen-right, VRM-left) foot
    this.loadLP += (Lraw - this.loadLP) * (cut ? 1 : 1 - Math.exp(-dt / 0.08));

    // ---- Pelvis: consequences of the CoM/foot state (no free oscillators) ----
    const pelvisRoll = PELVIS_ROLL_SIGN * 0.11 * this.loadLP; // hip hikes over the loaded leg
    const pelvisPitch =
      0.03 +
      Math.min(0.12, (0.9 * Math.max(0, -comY)) / this.legLen) + // crouch as the CoM sinks
      0.15 * this.sComZ[1]; // lean into fore/aft travel
    const pelvisYaw = THREE.MathUtils.clamp(
      (0.4 * (this.footPos[0].z - this.footPos[1].z)) / 0.6,
      -0.25,
      0.25,
    ); // hips open toward the forward foot
    this.eSway.set(pelvisPitch, pelvisYaw, pelvisRoll);
    this.hips.quaternion.copy(this.hipsRestQuat).multiply(this.qSway.setFromEuler(this.eSway));

    // ---- Spine/chest: lagged counter-followers (the S-curve), split across 3 joints so the
    // spine curves instead of hinging. ω=9/ζ=1 → ~70 ms behind the pelvis (visible follow-through).
    const oppose = -(1 - s0) * u0 + (1 - s1) * u1; // the swinging foot's side leads the shoulders
    this.sp2(this.sChestR, -0.6 * pelvisRoll, 9, 1, dt, cut);
    this.sp2(this.sChestY, -0.5 * pelvisYaw + 0.12 * oppose, 9, 1, dt, cut);
    this.sp2(this.sChestP, 0.3 * pelvisPitch, 9, 1, dt, cut);
    this.writeSpine(this.spine, this.spineRest, 0.3);
    this.writeSpine(this.chest, this.chestRest, 0.3);
    this.writeSpine(this.upperChest, this.upperChestRest, 0.4);

    // ---- Head: vestibular stabilization (keeps the eyes level) + a small pre-beat nod ----
    this.sp2(this.sHeadR, -0.5 * (pelvisRoll + this.sChestR[0]), 7, 1, dt, cut);
    this.sp2(this.sHeadY, -0.6 * this.sChestY[0], 7, 1, dt, cut);
    if (this.head) {
      this.eChest.set(0.03 * pulse(phi + 0.12), this.sHeadY[0], this.sHeadR[0]);
      this.head.quaternion.copy(this.headRest).multiply(this.qChest.setFromEuler(this.eChest));
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

    // ---- Body yaw: pivot INTO crossovers, provably continuous + rate-limited ----
    // tanh of the crossedness signal (C¹, soft-saturating — no thresholds), a critically-damped
    // spring, then a HARD per-frame cap: |Δyaw| ≤ 3 rad/s·dt. Even a bad upstream value can only
    // make her turn quickly, never teleport (the old sudden-rotation bug is now impossible).
    const rc = Math.max(0, this.footPos[0].x); // VRM right leg reaching to +x
    const lc = Math.max(0, -this.footPos[1].x); // VRM left leg reaching to −x
    const yawTarget = 0.72 * Math.tanh((rc - lc) / 0.15);
    const yPrev = this.sYaw[0];
    this.sp2(this.sYaw, yawTarget, 8, 1, dt, cut);
    if (!cut) {
      const maxStep = 3.0 * dt;
      const dy = this.sYaw[0] - yPrev;
      if (dy > maxStep) this.sYaw[0] = yPrev + maxStep;
      else if (dy < -maxStep) this.sYaw[0] = yPrev - maxStep;
    }
    this.yaw = this.sYaw[0];
    vrm.scene.rotation.y = this.baseRotY + this.yaw;

    // Crossover-safe leg separation. A leg is "crossed" when its foot is on the far side of
    // its own hip (leg 0 / VRM-right hip at −x → crossed as its foot goes +x; leg 1 mirror).
    //  • Fade the outward knee-splay to ZERO as a leg crosses — otherwise splaying each knee
    //    outward drives the two knees straight INTO each other in an X.
    //  • Push the crossing leg's knee FORWARD (+z pole) so it bends in front of the standing
    //    leg — the depth separation the body yaw can't fully deliver down at the (pinned) feet.
    const c0 = Math.max(0, this.footPos[0].x); // VRM right-leg crossedness (metres)
    const c1 = Math.max(0, -this.footPos[1].x); // VRM left-leg crossedness
    const splay0 = -KNEE_OUT * Math.max(0, 1 - c0 / 0.1);
    const splay1 = KNEE_OUT * Math.max(0, 1 - c1 / 0.1);
    this.solveLeg(this.footLeg[0], this.footPos[0], splay0, 1 + c0 * 5.5, this.footPitch[0]);
    this.solveLeg(this.footLeg[1], this.footPos[1], splay1, 1 + c1 * 5.5, this.footPitch[1]);

    // Settle dependent systems around the FINAL pose (spring bones follow the real legs).
    vrm.scene.updateMatrixWorld(true);
    vrm.lookAt?.update(dt);
    vrm.expressionManager?.update();
    vrm.nodeConstraintManager?.update();
    // Skirt/hair physics: cap to ~72 Hz (accumulate dt, step at the cap). Cloth is slow and
    // reads identically at 72 vs 144 Hz — but this halves the priciest CPU phase at high
    // refresh. The spring manager updates its chains' world matrices, so a skipped frame just
    // renders the last settled skirt (the full sweep above already placed every other bone).
    this.springAccum += dt;
    if (this.springAccum >= 1 / 72) {
      vrm.springBoneManager?.update(this.springAccum);
      this.springAccum = 0;
    }

    for (let p = 0; p < 4; p++) {
      const dbl = b - this.litPanel[p];
      const lit = dbl >= 0 && dbl < 1 ? Math.exp(-3 * dbl) : 0;
      this.arrowMats[p].opacity = 0.28 + 0.7 * lit;
    }
  }

  private support = [1, 1];

  /** A snapshot of the balance state for the ?vrm verification harness (coupling metrics). */
  debug(): Record<string, number> {
    const S = this.sampled;
    return {
      b: this.prevBeat,
      comX: this.sComX[0],
      comY: this.sComY[0],
      comZ: this.sComZ[0],
      yaw: this.yaw,
      load: this.loadLP,
      pelvisRoll: PELVIS_ROLL_SIGN * 0.11 * this.loadLP,
      chestR: this.sChestR[0],
      headR: this.sHeadR[0],
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

  private solveLeg(leg: Leg, targetWorld: THREE.Vector3, outX: number, fwdZ = 1, pitch = 0): void {
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
    // Ankle holds flat in world (footBind), then articulates by `pitch` about its own axis —
    // toe leading a swing / rolling on the beat — so the foot reads as a foot, not a slab.
    leg.ankle.parent!.getWorldQuaternion(this.qP);
    leg.ankle.quaternion.copy(
      this.qP
        .invert()
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
