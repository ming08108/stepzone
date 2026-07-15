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

const SAMBA_URL = '/threejs-demo/samba.fbx';

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
  private lastSynthBeat = -1;

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
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private footPos = [new THREE.Vector3(), new THREE.Vector3()];
  private bodyShift = new THREE.Vector3();
  private desiredShift = new THREE.Vector3();
  private yaw = 0;
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
      new FBXLoader().loadAsync(SAMBA_URL),
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
    this.baseRotY = vrm.scene.rotation.y;
    this.setupLegs();

    // Renderer — shared device (offscreen) or own device (canvas).
    void format; // reserved: the offscreen RT format three picks is sampleable as-is
    if (device) {
      this.renderer = new THREE.WebGPURenderer({
        canvas: canvas ?? (new OffscreenCanvas(w, h) as unknown as HTMLCanvasElement),
        device,
        antialias: true,
        alpha: true,
      });
      this.rt = new THREE.RenderTarget(w, h, { depthBuffer: true, samples: 4 });
    } else {
      this.renderer = new THREE.WebGPURenderer({ canvas: canvas!, antialias: true });
      this.renderer.setPixelRatio(
        Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1),
      );
    }
    this.renderer.setSize(w, h, false);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    await this.renderer.init();
    if (this.disposed) return;

    this.frameCamera(w, h);
    this.ready = true;
  }

  private raw(n: VRMHumanBoneName): THREE.Object3D {
    return this.vrm.humanoid!.getRawBoneNode(n) as THREE.Object3D;
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
    // foot 0 = LEFT foot = VRM left; foot 1 = RIGHT foot = VRM right (chart convention).
    this.footLeg = [left, right];
    this.ankleY = 0.5 * (wp(left.ankle).y + wp(right.ankle).y);
    this.legLen = left.L1 + left.L2;
    this.socketH = this.ankleY + this.legLen * 0.88;
    for (const h of HOME) h.setY(this.ankleY);
    for (const f of this.feet) {
      f.plant.setY(this.ankleY);
      f.from.setY(this.ankleY);
      f.to.setY(this.ankleY);
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
    const b = Number.isFinite(beat) ? beat : now * 1.4;
    const elapsed = now;

    // Calm groove drives the upper body (slowed); humanoid maps normalized → raw.
    this.mixer.setTime((elapsed * 0.28) % this.clipDur);
    vrm.humanoid?.update();

    // Schedule footwork from the chart (or synth), producing this frame's foot targets.
    this.schedule(b);
    const bodyLift = this.stepFeet(b);

    // Stabilise + servo the pelvis so the sockets sit where the feet can reach, then IK.
    this.hips.quaternion.slerp(this.hipsRestQuat, 0.82);
    vrm.scene.updateMatrixWorld(true);
    const dip = 0.02 * Math.max(0, Math.sin(b * Math.PI));
    const socketY =
      0.5 *
      (this.legs[0].hip.getWorldPosition(this.tmp).y +
        this.legs[1].hip.getWorldPosition(this.tmp2).y);
    vrm.scene.position.y += this.socketH + bodyLift - dip - socketY;

    // Weight shift + crossover yaw.
    const support = this.support;
    const wsum = support[0] + support[1] || 1;
    const comX = (this.footPos[0].x * support[0] + this.footPos[1].x * support[1]) / wsum;
    const comZ = (this.footPos[0].z * support[0] + this.footPos[1].z * support[1]) / wsum;
    this.desiredShift.set(comX * 0.4, 0, comZ * 0.22);
    this.bodyShift.lerp(this.desiredShift, 0.14);
    vrm.scene.position.x = this.bodyShift.x;
    vrm.scene.position.z = this.bodyShift.z;
    const targetYaw = THREE.MathUtils.clamp(-comX * 0.9, -0.5, 0.5);
    this.yaw += (targetYaw - this.yaw) * 0.1;
    vrm.scene.rotation.y = this.baseRotY + this.yaw;
    vrm.scene.updateMatrixWorld(true);

    this.solveLeg(this.footLeg[0], this.footPos[0]);
    this.solveLeg(this.footLeg[1], this.footPos[1]);

    // Settle dependent systems around the FINAL pose (spring bones follow the real legs).
    vrm.scene.updateMatrixWorld(true);
    vrm.lookAt?.update(dt);
    vrm.expressionManager?.update();
    vrm.nodeConstraintManager?.update();
    vrm.springBoneManager?.update(dt);

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
      const lift = land - 1;
      const jump = (row.lCol ?? -1) >= 0 && (row.rCol ?? -1) >= 0;
      if ((row.lCol ?? -1) >= 0) this.assignFoot(0, row.lCol as number, lift, land);
      if ((row.rCol ?? -1) >= 0) this.assignFoot(1, row.rCol as number, lift, land);
      if (jump) {
        this.jumpWin.t0 = lift;
        this.jumpWin.t1 = land;
      }
    }
  }

  /** Placeholder groove when no chart: alternate feet through the panels, w/ occasional jump. */
  private synth(beat: number): void {
    const ib = Math.floor(beat);
    if (ib <= this.lastSynthBeat) return;
    this.lastSynthBeat = ib;
    const PATTERN = [0, 3, 2, 1, 3, 0, 1, 2]; // L R U D R L D U (panels)
    const idx = ((ib % PATTERN.length) + PATTERN.length) % PATTERN.length;
    if (idx === 4) {
      // a jump every 8 beats
      this.assignFoot(0, 0, ib, ib + 1);
      this.assignFoot(1, 3, ib, ib + 1);
      this.jumpWin.t0 = ib;
      this.jumpWin.t1 = ib + 1;
    } else {
      const foot = (ib % 2) as 0 | 1;
      this.assignFoot(foot, PATTERN[idx], ib, ib + 1);
      // the other foot recovers toward home (keeps the stance narrow → clean skirt)
      const other = (1 - foot) as 0 | 1;
      const st = this.feet[other];
      st.from.copy(st.plant);
      st.to.copy(HOME[other]);
      st.t0 = ib;
      st.t1 = ib + 1;
    }
  }

  private assignFoot(foot: 0 | 1, panel: number, t0: number, t1: number): void {
    const st = this.feet[foot];
    st.from.copy(st.plant);
    st.to.copy(PANEL[panel]).setY(this.ankleY);
    st.t0 = t0;
    st.t1 = t1;
    this.litPanel[panel] = t1;
  }

  /** Per-foot swing/plant → footPos + support weights; returns extra hip lift for jumps. */
  private stepFeet(beat: number): number {
    const inJump = beat >= this.jumpWin.t0 && beat < this.jumpWin.t1;
    for (let f = 0; f < 2; f++) {
      const st = this.feet[f];
      if (beat >= st.t1) {
        st.plant.copy(st.to);
        this.footPos[f].copy(st.plant);
        this.support[f] = 1;
      } else if (beat < st.t0) {
        this.footPos[f].copy(st.plant);
        this.support[f] = 1;
      } else {
        const u = (beat - st.t0) / (st.t1 - st.t0 || 1);
        this.footPos[f].copy(st.from).lerp(st.to, this.minJerk(u));
        const arc = Math.sin(u * Math.PI);
        this.footPos[f].y += arc * (inJump ? 0.12 : 0.05);
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
    const x1 = child.clone();
    const y1 = ref.clone().addScaledVector(x1, -ref.dot(x1)).normalize();
    const z1 = new THREE.Vector3().crossVectors(x1, y1);
    this.mL.makeBasis(x1, y1, z1);
    const X = aimWorld.clone().normalize();
    const sec = this.FWD.clone();
    if (Math.abs(sec.dot(X)) > 0.98) sec.set(0, 1, 0);
    const Y = sec.addScaledVector(X, -sec.dot(X)).normalize();
    const Z = new THREE.Vector3().crossVectors(X, Y);
    this.mW.makeBasis(X, Y, Z);
    this.qW
      .setFromRotationMatrix(this.mW)
      .multiply(this.qLl.setFromRotationMatrix(this.mL).invert());
    bone.parent!.getWorldQuaternion(this.qP);
    bone.quaternion.copy(this.qP.invert().multiply(this.qW));
  }

  private solveLeg(leg: Leg, targetWorld: THREE.Vector3): void {
    leg.hip.updateWorldMatrix(true, false);
    leg.hip.getWorldPosition(this.hipPos);
    const toT = targetWorld.clone().sub(this.hipPos);
    const d = THREE.MathUtils.clamp(
      toT.length(),
      Math.abs(leg.L1 - leg.L2) + 1e-3,
      leg.L1 + leg.L2 - 1e-3,
    );
    const n = toT.clone().normalize();
    const cosHip = THREE.MathUtils.clamp(
      (leg.L1 * leg.L1 + d * d - leg.L2 * leg.L2) / (2 * leg.L1 * d),
      -1,
      1,
    );
    const hipAngle = Math.acos(cosHip);
    const pole = this.FWD.clone().sub(n.clone().multiplyScalar(this.FWD.dot(n)));
    if (pole.lengthSq() < 1e-6) pole.set(0, 0, 1);
    pole.normalize();
    const axis = new THREE.Vector3().crossVectors(n, pole).normalize();
    const kneeDir = n.clone().applyAxisAngle(axis, hipAngle);
    this.kneePos.copy(this.hipPos).addScaledVector(kneeDir, leg.L1);
    this.orient(leg.hip, leg.hipChild, leg.hipRef, this.kneePos.clone().sub(this.hipPos));
    leg.hip.updateWorldMatrix(true, false);
    leg.knee.getWorldPosition(this.kneePos);
    this.orient(leg.knee, leg.kneeChild, leg.kneeRef, targetWorld.clone().sub(this.kneePos));
    leg.knee.updateWorldMatrix(true, false);
    leg.ankle.parent!.getWorldQuaternion(this.qP);
    leg.ankle.quaternion.copy(this.qP.invert().multiply(leg.footBind));
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
    this.renderer?.setSize(w, h, false);
    this.rt?.setSize(w, h);
  }

  dispose(): void {
    this.disposed = true;
    this.rt?.dispose();
    this.renderer?.dispose();
  }
}
