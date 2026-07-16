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
// A step is a QUICK move at the end of the beat, not a slow glide across the whole beat
// — the foot HOLDS its arrow, then steps and plants on the beat (a real step, not a
// floaty drift). Beats of swing before the landing beat.
const SWING_BEATS = 0.55;
// How far the knees splay OUTWARD (per leg, relative to the forward bend direction). A
// slightly turned-out stance keeps the two thighs from converging and clipping when the
// feet come close or cross — real legs don't bend in perfectly parallel planes.
const KNEE_OUT = 0.34;

// Upper-body groove clip (Mixamo, mixamorig rig → retargeted to the VRM humanoid). Only the
// arms/torso/head read through; the legs are overridden by the chart foot-IK. The samba clip
// has continuous full-body hip/torso sway, which reads livelier than the arm-isolation hip-hop.
const GROOVE_URL = '/threejs-demo/samba.fbx';

// Placeholder choreography for the ?vrm proving ground / no-chart fallback. A 16-beat
// routine at 8th-note (half-beat) resolution — alternating quarter steps, fast 8th runs,
// crossovers, jumps, and a feet-together stomp — so the dancer shows off complex footwork
// with no chart. Indexed by half-beat; 'hold' = no new step, {l,r} = both feet (a jump),
// {foot,panel} = one foot. Panels 0=L,1=D,2=U,3=R.
type SynthStep = { foot: 0 | 1; panel: number } | { l: number; r: number } | 'hold';
const SYNTH: SynthStep[] = [
  // beats 1-4 — alternating quarters, an 8th flourish on 3
  { foot: 0, panel: 0 },
  'hold',
  { foot: 1, panel: 3 },
  'hold',
  { foot: 0, panel: 1 },
  { foot: 1, panel: 2 },
  { foot: 0, panel: 0 },
  'hold',
  // beats 5-8 — jump out, a double crossover, jump vertical
  { l: 0, r: 3 },
  'hold',
  { foot: 0, panel: 3 },
  { foot: 1, panel: 0 },
  { foot: 0, panel: 1 },
  'hold',
  { l: 1, r: 2 },
  'hold',
  // beats 9-12 — a fast 8th run sweeping the panels
  { foot: 0, panel: 0 },
  { foot: 1, panel: 1 },
  { foot: 0, panel: 2 },
  { foot: 1, panel: 3 },
  { foot: 0, panel: 1 },
  { foot: 1, panel: 2 },
  { foot: 0, panel: 0 },
  'hold',
  // beats 13-16 — crossovers, a feet-together stomp, split back out
  { foot: 1, panel: 0 },
  'hold',
  { foot: 0, panel: 3 },
  'hold',
  { l: 1, r: 1 },
  'hold',
  { foot: 0, panel: 0 },
  { foot: 1, panel: 3 },
];

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

interface FootState {
  plant: THREE.Vector3;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t0: number;
  t1: number;
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

  // footwork
  private steps: DancerStep[] = [];
  private stepCursor = 0;
  private feet: [FootState, FootState];
  private litPanel = [-9, -9, -9, -9];
  private jumpWin = { t0: 0, t1: -1 }; // active jump beat window
  private lastSynthHb = -1;

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
  private footPitch = [0, 0]; // per-foot ankle pitch (toe articulation) — set in stepFeet
  private qFoot = new THREE.Quaternion();
  private readonly footAxis = new THREE.Vector3(1, 0, 0);
  private bodyShift = new THREE.Vector3();
  private desiredShift = new THREE.Vector3();
  private yaw = 0;
  private springAccum = 0; // spring-bone physics runs at a fixed cap, not the full refresh
  // weight / balance layer (contrapposto sway + torso counter, weighty settle)
  private weight = 0; // smoothed lateral weight side, screen space [-1,1]
  private lean = 0; // smoothed fore/aft weight
  private upperChest: THREE.Object3D | null = null;
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
    this.feet = [
      { plant: HOME[0].clone(), from: HOME[0].clone(), to: HOME[0].clone(), t0: 0, t1: 0 },
      { plant: HOME[1].clone(), from: HOME[1].clone(), to: HOME[1].clone(), t0: 0, t1: 0 },
    ];
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

    // Retarget the groove onto the VRM humanoid (normalized bones).
    const vrmClip = retargetMixamoToVrm(sourceFbx.animations[0], vrm, sourceFbx);
    this.clipDur = vrmClip.duration;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.mixer.clipAction(vrmClip).play();

    this.hips = this.raw('hips');
    this.hipsRestQuat.copy(this.hips.quaternion);
    // Torso bone the shoulders counter-sway on (prefer upperChest → chest → spine).
    this.upperChest = this.rawOpt('upperChest') ?? this.rawOpt('chest') ?? this.rawOpt('spine');
    this.baseRotY = vrm.scene.rotation.y;
    this.setupLegs();

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
    for (let f = 0; f < 2; f++) {
      const st = this.feet[f];
      st.plant.setY(this.ankleY);
      st.from.setY(this.ankleY);
      st.to.setY(this.ankleY);
      this.footPos[f].copy(st.plant); // seed so the first swing glides from rest, not (0,0,0)
    }
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
    this.steps = [...steps].sort((a, b) => a.beat - b.beat);
    this.stepCursor = 0;
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

  private minJerk(u: number): number {
    return u * u * u * (10 - 15 * u + 6 * u * u);
  }

  /** Advance one frame: animation + footwork scheduling + foot-IK + spring bones. */
  build(now: number, beat: number, dt: number): void {
    if (!this.ready) return;
    const vrm = this.vrm;
    // Guard the clock inputs: a NaN/negative from a song seek/glitch would poison
    // mixer time and every downstream position, freezing or exploding the pose.
    if (!Number.isFinite(now)) now = 0;
    if (!Number.isFinite(dt) || dt < 0) dt = 1 / 60;
    dt = Math.min(dt, 1 / 20);
    const b = Number.isFinite(beat) ? beat : now * 1.4;
    const elapsed = now < 0 ? 0 : now;

    // The groove clip drives the upper body; humanoid maps normalized → raw. Kept lively
    // (not slo-mo) so the arms read as dancing rather than drifting.
    this.mixer.setTime((elapsed * 0.42) % this.clipDur);
    vrm.humanoid?.update();

    // Schedule footwork from the chart (or synth), producing this frame's foot targets.
    this.schedule(b);
    const bodyLift = this.stepFeet(b);

    // Both feet converging on ONE arrow would occupy the same point and clip. If they get
    // closer than a minimum stance width, spread them — each toward its own hip's side
    // (foot 0 drives the VRM right leg → −x, foot 1 the left → +x) so they sit side by side
    // instead of intersecting. Only fires when genuinely close; a real cross to opposite
    // panels stays wide and is handled by the body pivot below.
    const FOOT_GAP = 0.16;
    const sepX = this.footPos[1].x - this.footPos[0].x;
    const sep = Math.hypot(sepX, this.footPos[1].z - this.footPos[0].z);
    if (sep < FOOT_GAP) {
      const push = 0.5 * (FOOT_GAP - sep);
      this.footPos[0].x -= push;
      this.footPos[1].x += push;
    }

    // ---- Weight & balance ----
    // Where the weight sits: the support-weighted centre of the feet (screen space). As a
    // foot swings out its support drops, so the centre leads onto the PLANTED leg — she
    // commits weight before the step finishes (anticipation), then settles on the land.
    const support = this.support;
    const wsum = support[0] + support[1] || 1;
    const comX = (this.footPos[0].x * support[0] + this.footPos[1].x * support[1]) / wsum;
    const comZ = (this.footPos[0].z * support[0] + this.footPos[1].z * support[1]) / wsum;
    this.weight += (THREE.MathUtils.clamp(comX / 0.28, -1, 1) - this.weight) * 0.2;
    this.lean += (THREE.MathUtils.clamp(comZ / 0.3, -1, 1) - this.lean) * 0.2;

    // Beat-phase vertical: a WEIGHTY settle — the body sinks onto the beat (the loaded leg
    // absorbs into a knee flex) and springs back. Sharper down than up (pow < 1), and
    // deeper while a foot is mid-transfer so a step lands with impact, not a float.
    const bp = b - Math.floor(b);
    const dip = Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * bp), 0.7); // 1 on beat, 0 mid
    const transfer = 1 - Math.min(support[0], support[1]); // 0 both planted → ~0.85 mid-swing
    // Deeper settle so she visibly SINKS onto each step (knees absorb) and rises between —
    // this is what couples the torso to the footwork; too shallow and the body floats at a
    // constant height while the legs move underneath it.
    const groove =
      this.legLen * (0.07 * dip * (1 + 0.6 * transfer) + 0.012 * Math.sin(4 * Math.PI * bp));

    // Pelvis: stabilise toward rest (keeps the IK sane), then add contrapposto — raise the
    // loaded-side hip and lean slightly into the weight, so she stands ON a leg rather than
    // hovering between both. Foot-IK re-plants afterwards, so the feet stay put while the
    // pelvis rides over them.
    // Only PARTLY stabilise toward rest — enough to keep the IK sane, but leaving most of
    // the clip's hip/pelvis sway so the body actually dances (a hard slerp-to-rest froze the
    // core into a rigid plank). The foot-IK re-plants afterwards, so the hips can swing freely.
    this.hips.quaternion.slerp(this.hipsRestQuat, 0.6);
    // Continuous core motion on TOP of the clip + weight-driven contrapposto: a side-to-side
    // hip rock AND a pelvis twist (one cycle/beat) so the whole torso rolls, not just tilts.
    const gp = 2 * Math.PI * bp;
    const hipGroove = 0.08 * Math.sin(gp);
    const hipTwist = 0.05 * Math.sin(gp);
    this.eSway.set(-0.02 - 0.05 * dip + this.lean * 0.06, hipTwist, this.weight * 0.14 + hipGroove);
    this.hips.quaternion.multiply(this.qSway.setFromEuler(this.eSway));
    // Torso: lean into the weight (head tracks over the support base) and counter-sway/twist
    // against the pelvis (the classic S-curve) so the spine flows instead of moving as a plank.
    if (this.upperChest) {
      this.eChest.set(
        0.03 * dip,
        -this.weight * 0.05 - hipTwist * 0.6,
        this.weight * 0.06 - 0.6 * hipGroove,
      );
      this.upperChest.quaternion.multiply(this.qChest.setFromEuler(this.eChest));
    }
    // Only the two hip sockets are read here (for the grounding servo), so update just those
    // two bone chains — not the whole 240-node scene. The final full sweep happens below.
    this.legs[0].hip.updateWorldMatrix(true, false);
    this.legs[1].hip.updateWorldMatrix(true, false);

    const socketY =
      0.5 *
      (this.legs[0].hip.getWorldPosition(this.tmp).y +
        this.legs[1].hip.getWorldPosition(this.tmp2).y);
    vrm.scene.position.y += this.socketH + bodyLift - groove - socketY;

    // Shift the whole body so the centre of mass tracks OVER the support foot (balance) —
    // a strong, quick commit so when she's on one leg the pelvis is genuinely over it, not
    // hovering near centre looking about to topple.
    this.desiredShift.set(comX * 0.55, 0, comZ * 0.36);
    this.bodyShift.lerp(this.desiredShift, 0.2);
    // Continuous groove TRANSLATION on top of the weight shift: the whole body sways side to
    // side (and a slight fore/aft figure-8) with the beat, so she TRAVELS instead of staying
    // rooted to one spot (the samba retarget drops the clip's hip-position track, so without
    // this she never moves her centre). Added after the lerp so it keeps full amplitude; the
    // feet stay IK'd to the arrows, so the body drifts over them.
    const swayX = 0.06 * Math.sin(gp);
    const swayZ = 0.025 * Math.sin(2 * gp);
    vrm.scene.position.x = this.bodyShift.x + swayX;
    vrm.scene.position.z = this.bodyShift.z + swayZ;
    // Body yaw: pivot INTO crossovers so a leg reaching across the centreline swings AROUND
    // the other instead of scissoring through it. A leg is "crossed" when its foot is on the
    // opposite side from its hip (not merely when foot 0 passes foot 1). footPos[0] drives
    // the VRM RIGHT leg (hip on screen-left, −x) → crossed when its foot is on +x; footPos[1]
    // drives the LEFT leg (hip +x) → crossed when its foot is on −x. +yaw turns the −x hip
    // toward the camera so the right leg passes in FRONT of the left; −yaw mirrors it.
    const rightCross = Math.max(0, this.footPos[0].x); // VRM right leg reaching to +x
    const leftCross = Math.max(0, -this.footPos[1].x); // VRM left leg reaching to −x
    let pivot = rightCross - leftCross;
    // Full double-cross (both legs over the line, an X): the difference cancels but the legs
    // are MOST tangled — turn toward one side to send them front/back. Pick the side
    // CONTINUOUSLY: keep turning the way she's already going. A hard `rightCross >= leftCross`
    // sign flips the instant the two crossings swap dominance — that snap read as the body
    // teleporting -180→180. Hysteresis on the current yaw removes the discontinuity.
    if (rightCross > 0.06 && leftCross > 0.06) {
      const dir =
        Math.abs(this.yaw) > 0.06 ? Math.sign(this.yaw) : rightCross >= leftCross ? 1 : -1;
      pivot = (rightCross + leftCross) * dir;
    }
    // Moderate turn + a slower ease so a crossover reads as a smooth pivot, not a snap. The
    // reduced yaw leans on the stronger knee-forward push (below) for depth separation.
    const targetYaw = THREE.MathUtils.clamp(pivot * 2.4, -0.72, 0.72);
    this.yaw += (targetYaw - this.yaw) * 0.1;
    vrm.scene.rotation.y = this.baseRotY + this.yaw;
    // (No full updateMatrixWorld here — solveLeg below updates each leg's hip chain from its
    // ancestors, so it already sees the new scene position/rotation. One fewer 240-node sweep.)

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
      const db = b - this.litPanel[p];
      const lit = db >= 0 && db < 1 ? Math.exp(-3 * db) : 0;
      this.arrowMats[p].opacity = 0.28 + 0.7 * lit;
    }
  }

  private support = [1, 1];

  /** Advance the chart cursor and assign feet to land ON their row's beat. */
  private schedule(beat: number): void {
    if (this.steps.length === 0) {
      this.synth(beat);
      return;
    }
    // Look ahead ~1 beat and schedule any row whose land time is imminent.
    while (this.stepCursor < this.steps.length && this.steps[this.stepCursor].beat <= beat + 1) {
      const row = this.steps[this.stepCursor];
      this.stepCursor++;
      const land = row.beat;
      if (land < beat - 0.25) continue; // missed (seek/lag) — skip cleanly
      const jump = (row.lCol ?? -1) >= 0 && (row.rCol ?? -1) >= 0;
      if ((row.lCol ?? -1) >= 0) this.assignFoot(0, row.lCol as number, land, beat);
      if ((row.rCol ?? -1) >= 0) this.assignFoot(1, row.rCol as number, land, beat);
      if (jump) {
        this.jumpWin.t0 = Math.max(beat, land - SWING_BEATS);
        this.jumpWin.t1 = land;
      }
    }
  }

  /** Placeholder choreography when no chart (the SYNTH routine above): steps on 8th notes,
   *  landing on the next half-beat. A stepping foot moves; the other HOLDS its last arrow
   *  and flows straight to its next step (never yanked back to centre). Panels 0=L,1=D,2=U,3=R. */
  private synth(beat: number): void {
    const hb = Math.floor(beat * 2); // half-beat index (8th-note grid)
    if (hb <= this.lastSynthHb) return;
    this.lastSynthHb = hb;
    const step = SYNTH[((hb % SYNTH.length) + SYNTH.length) % SYNTH.length];
    if (step === 'hold') return;
    const land = (hb + 1) / 2;
    if ('l' in step) {
      // A jump: both feet leave and land together (the whole body hops in stepFeet).
      this.assignFoot(0, step.l, land, beat);
      this.assignFoot(1, step.r, land, beat);
      this.jumpWin.t0 = Math.max(beat, land - SWING_BEATS);
      this.jumpWin.t1 = land;
      return;
    }
    this.assignFoot(step.foot, step.panel, land, beat);
  }

  /** Schedule `foot` to land on `panel` at beat `land`. Starts the swing from where the
   *  foot IS right now (this frame's footPos) with t0 clamped to the present, so a step
   *  scheduled less than a beat early glides in from the current spot instead of
   *  teleporting to the middle of a lerp that "already started" in the past. */
  private assignFoot(foot: 0 | 1, panel: number, land: number, nowBeat: number): void {
    const st = this.feet[foot];
    st.from.copy(this.footPos[foot]);
    st.to.copy(PANEL[panel]).setY(this.ankleY);
    st.t0 = Math.max(nowBeat, land - SWING_BEATS);
    st.t1 = Math.max(st.t0 + 0.05, land);
    this.litPanel[panel] = land;
  }

  /** Per-foot swing/plant → footPos + support weights; returns extra hip lift for jumps. */
  private stepFeet(beat: number): number {
    const inJump = beat >= this.jumpWin.t0 && beat < this.jumpWin.t1;
    const bp = beat - Math.floor(beat);
    for (let f = 0; f < 2; f++) {
      const st = this.feet[f];
      if (beat >= st.t1 || beat < st.t0) {
        if (beat >= st.t1) st.plant.copy(st.to);
        this.footPos[f].copy(st.plant);
        this.support[f] = 1;
        // Planted foot isn't dead-still: a small ankle roll on the beat (weight rolling onto
        // the ball of the foot as she bounces) keeps the standing leg alive.
        this.footPitch[f] = 0.035 * Math.sin(2 * Math.PI * bp + f * Math.PI);
      } else {
        const u = (beat - st.t0) / (st.t1 - st.t0 || 1);
        this.footPos[f].copy(st.from).lerp(st.to, this.minJerk(u));
        const arc = Math.sin(u * Math.PI);
        // Per-step variation (hash of the land beat) so steps aren't identical stamps — the
        // lift height, and a small early/late timing skew, differ each step.
        const h = Math.sin(st.t1 * 49.17) * 7845.31;
        const vary = 0.75 + 0.5 * (h - Math.floor(h));
        this.footPos[f].y += arc * (inJump ? 0.14 : 0.09) * vary; // pick the foot up
        // A crossing step — foot heading to the opposite side of its own hip — swings IN
        // FRONT of the standing leg (a +z bulge) instead of straight through it.
        const crossing = f === 0 ? st.to.x > 0.05 : st.to.x < -0.05;
        if (crossing) this.footPos[f].z += arc * 0.2;
        // Toe leads the swing (foot articulates over the step, not a flat slab gliding) —
        // toe-down through the lift, settling flat on the plant.
        this.footPitch[f] = arc * 0.6 * vary;
        this.support[f] = 1 - 0.85 * arc;
      }
    }
    // Jump: both feet leave together, whole body hops (anticipation dip → rise → land).
    if (inJump) {
      const u = (beat - this.jumpWin.t0) / (this.jumpWin.t1 - this.jumpWin.t0 || 1);
      // −anticipation crouch early, up-and-over arc, settle on land.
      const arc = Math.sin(u * Math.PI);
      const anticip = u < 0.2 ? -(0.2 - u) * 0.4 : 0;
      return this.legLen * (arc * 0.16 + anticip);
    }
    return 0;
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
