/**
 * PhysDanceSim — glue between the ragdoll (rig), the motor controller
 * (brain), and a caller-driven clock. Fixed-substep accumulator so the
 * physics is deterministic and stable regardless of display frame rate.
 * Headless-friendly: no rendering, no DOM — vitest drives it directly.
 */
import type RAPIER_API from '@dimforge/rapier3d-compat';
import { DanceBrain, type PatternStep } from './controller';
import { PhysRig, type PhysRigOpts, type RigSkeleton, type RigState } from './rig';

let rapierReady: Promise<typeof RAPIER_API> | null = null;

/** Load + init the Rapier WASM module once per process. */
export function loadRapier(): Promise<typeof RAPIER_API> {
  if (!rapierReady) {
    rapierReady = import('@dimforge/rapier3d-compat').then(async (m) => {
      const R = (m.default ?? m) as typeof RAPIER_API;
      await R.init();
      return R;
    });
  }
  return rapierReady;
}

export interface PhysDanceSimOpts extends PhysRigOpts {
  bpm?: number;
  pattern?: readonly (PatternStep | null)[];
}

export class PhysDanceSim {
  readonly rig: PhysRig;
  readonly brain: DanceBrain;
  bpm: number;
  /** Stabilizer assist strength (0 = pure physics, see PhysRig.applyAssist). */
  assist = 1.0;
  /** Musical time in beats — advances with tick(). */
  beat = 0;
  private acc = 0;
  private readonly state: RigState;

  constructor(R: typeof RAPIER_API, skel: RigSkeleton, opts: PhysDanceSimOpts = {}) {
    this.rig = new PhysRig(R, skel, opts);
    this.brain = new DanceBrain(skel, opts.pattern);
    this.bpm = opts.bpm ?? 128;
    this.state = this.rig.readState();
  }

  /** Advance the simulation by dt seconds of wall/song time. */
  tick(dt: number): void {
    const h = this.rig.world.timestep;
    this.acc += Math.min(dt, 0.25); // a hitch never causes a 1000-substep stall
    while (this.acc >= h) {
      this.acc -= h;
      this.beat += (h * this.bpm) / 60;
      const st = this.rig.readState(this.state);
      const targets = this.brain.update(st, this.beat);
      this.rig.applyMuscles(targets);
      this.rig.applyAssist(this.brain.comDesire, this.assist);
      this.rig.step();
    }
  }

  dispose(): void {
    this.rig.dispose();
  }
}

/** A generic ~1.58 m human skeleton for headless tests (T-pose, facing +Z,
 *  feet at the floor; side 0 = anatomical left = +x). */
export function syntheticSkeleton(): RigSkeleton {
  return {
    hips: { x: 0, y: 0.86, z: 0 },
    spine: { x: 0, y: 0.97, z: 0 },
    chest: { x: 0, y: 1.12, z: 0 },
    neck: { x: 0, y: 1.33, z: 0 },
    headTop: { x: 0, y: 1.58, z: 0 },
    shoulder: [
      { x: 0.17, y: 1.29, z: 0 },
      { x: -0.17, y: 1.29, z: 0 },
    ],
    elbow: [
      { x: 0.43, y: 1.29, z: 0 },
      { x: -0.43, y: 1.29, z: 0 },
    ],
    wrist: [
      { x: 0.66, y: 1.29, z: 0 },
      { x: -0.66, y: 1.29, z: 0 },
    ],
    hipSocket: [
      { x: 0.088, y: 0.82, z: 0 },
      { x: -0.088, y: 0.82, z: 0 },
    ],
    knee: [
      { x: 0.092, y: 0.45, z: 0 },
      { x: -0.092, y: 0.45, z: 0 },
    ],
    ankle: [
      { x: 0.096, y: 0.07, z: 0 },
      { x: -0.096, y: 0.07, z: 0 },
    ],
    toe: [
      { x: 0.096, y: 0.02, z: 0.14 },
      { x: -0.096, y: 0.02, z: 0.14 },
    ],
  };
}
