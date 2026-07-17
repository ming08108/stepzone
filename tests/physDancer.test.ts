/**
 * Headless physics-dancer tests: the ragdoll must genuinely balance itself —
 * these run the real Rapier world with muscle torques only, no rendering.
 * If these fail the character physically falls over, so they double as the
 * tuning harness (they print a CoM trace on failure).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import type RAPIER_API from '@dimforge/rapier3d-compat';
import { loadRapier, PhysDanceSim, syntheticSkeleton } from '../src/phys/simulation';

let R: typeof RAPIER_API;
beforeAll(async () => {
  R = await loadRapier();
});

/** Run seconds of sim at 60 fps callers, tracing pelvis height. */
function run(
  sim: PhysDanceSim,
  seconds: number,
  onFrame?: (t: number) => void,
): { minPelvisY: number; trace: string[] } {
  const trace: string[] = [];
  let minPelvisY = Infinity;
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    sim.tick(dt);
    const st = sim.rig.readState();
    minPelvisY = Math.min(minPelvisY, st.pelvisPos.y);
    if (Math.round(t * 60) % 30 === 0) {
      trace.push(
        `t=${t.toFixed(2)} pelvisY=${st.pelvisPos.y.toFixed(3)} ` +
          `com=(${st.com.x.toFixed(3)},${st.com.y.toFixed(3)},${st.com.z.toFixed(3)}) ` +
          `vel=(${st.comVel.x.toFixed(2)},${st.comVel.z.toFixed(2)}) ` +
          `feet=${st.feet[0].contact ? 'L' : '-'}${st.feet[1].contact ? 'R' : '-'}`,
      );
    }
    onFrame?.(t);
  }
  return { minPelvisY, trace };
}

describe('physics dancer', () => {
  it('stands upright for 10 s with no choreography (pure balance)', () => {
    const sim = new PhysDanceSim(R, syntheticSkeleton(), { pattern: [], bpm: 128 });
    sim.brain.knobs.sway = 0;
    sim.brain.knobs.bounce = 0;
    const upright = sim.rig.hipHeight;
    const { minPelvisY, trace } = run(sim, 10);
    if (minPelvisY < upright * 0.6) console.log(trace.join('\n'));
    expect(minPelvisY).toBeGreaterThan(upright * 0.6);
    sim.dispose();
  });

  it('grooves in place (sway + bounce) without falling for 20 s', () => {
    const sim = new PhysDanceSim(R, syntheticSkeleton(), { pattern: [], bpm: 128 });
    const upright = sim.rig.hipHeight;
    const { minPelvisY, trace } = run(sim, 20);
    if (minPelvisY < upright * 0.55) console.log(trace.join('\n'));
    expect(minPelvisY).toBeGreaterThan(upright * 0.55);
    sim.dispose();
  });

  it('dances the default step pattern for 30 s without falling', () => {
    const sim = new PhysDanceSim(R, syntheticSkeleton(), { bpm: 100 });
    const upright = sim.rig.hipHeight;
    const { minPelvisY, trace } = run(sim, 30);
    if (minPelvisY < upright * 0.5) console.log(trace.join('\n'));
    expect(minPelvisY).toBeGreaterThan(upright * 0.5);
    sim.dispose();
  });

  it('feet actually reach their panels while dancing', () => {
    const sim = new PhysDanceSim(R, syntheticSkeleton(), { bpm: 100 });
    // Track how close the swing foot gets to its target by the time each
    // CHOREOGRAPHY step ends (recovery steps target capture points, not
    // panels). The controller intentionally offsets landings up to ±0.12 m
    // for balance feedback, so judge the MEAN with a bounded worst case.
    let worst = 0;
    let sum = 0;
    let samples = 0;
    let prevStep: {
      foot: 0 | 1;
      target: { x: number; z: number };
      recovery: boolean;
      endBeat: number;
    } | null = null;
    run(sim, 35, () => {
      const cur = sim.brain.activeStep;
      // Measure only steps that RAN TO COMPLETION — the stability gate may
      // abort a step mid-swing (by design), which isn't a landing at all.
      if (prevStep && !cur && !prevStep.recovery && sim.beat >= prevStep.endBeat - 0.02) {
        const st = sim.rig.readState();
        const f = st.feet[prevStep.foot].pos;
        const err = Math.hypot(f.x - prevStep.target.x, f.z - prevStep.target.z);
        worst = Math.max(worst, err);
        sum += err;
        samples++;
      }
      prevStep = cur
        ? {
            foot: cur.foot,
            target: { x: cur.target.x, z: cur.target.z },
            recovery: cur.recovery,
            endBeat: cur.endBeat,
          }
        : null;
    });
    expect(samples).toBeGreaterThan(6);
    const mean = sum / samples;
    console.log(
      `landing error over ${samples} steps: mean ${mean.toFixed(3)} m, worst ${worst.toFixed(3)} m`,
    );
    // Current honest tracking quality of the torque-driven swing leg —
    // a regression guard, not an aspiration (an RL policy would tighten it).
    expect(mean).toBeLessThan(0.15);
    expect(worst).toBeLessThan(0.45);
    sim.dispose();
  });

  it('recovers from a shove instead of falling', () => {
    const sim = new PhysDanceSim(R, syntheticSkeleton(), { pattern: [], bpm: 128 });
    const upright = sim.rig.hipHeight;
    let shoved = false;
    const { minPelvisY, trace } = run(sim, 12, (t) => {
      if (!shoved && t > 3) {
        shoved = true;
        sim.rig.shove(2.2, 0, 1.5); // a firm sideways push at the chest
      }
    });
    if (minPelvisY < upright * 0.5) console.log(trace.join('\n'));
    expect(minPelvisY).toBeGreaterThan(upright * 0.5);
    sim.dispose();
  });
});
