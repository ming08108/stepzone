import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  buildSynthTimeline,
  buildChartTimeline,
  sampleFeet,
  makeSampledFeet,
  type SampledFeet,
} from '../src/render/dancerFootwork';

const PANEL = [
  new THREE.Vector3(-0.3, 0, 0),
  new THREE.Vector3(0, 0, 0.3),
  new THREE.Vector3(0, 0, -0.3),
  new THREE.Vector3(0.3, 0, 0),
];
const HOME = [new THREE.Vector3(-0.09, 0, 0.05), new THREE.Vector3(0.09, 0, 0.05)];

function snap(s: SampledFeet): number[] {
  return [
    s.pos[0].x,
    s.pos[0].y,
    s.pos[0].z,
    s.pos[1].x,
    s.pos[1].y,
    s.pos[1].z,
    s.support[0],
    s.support[1],
  ];
}

describe('dancerFootwork sampler', () => {
  const synth = buildSynthTimeline(PANEL, HOME, 0.07);

  it('is a pure function of beat — same beat, same result regardless of call history', () => {
    const a = makeSampledFeet();
    const b = makeSampledFeet();
    // Sample `a` walking forward; sample `b` jumping around wildly, then both END exactly on 7.3.
    for (let i = 0; i <= 146; i++) sampleFeet(synth, i * 0.05, a);
    for (const t of [40, -12, 0.1, 999, 3.3]) sampleFeet(synth, t, b);
    sampleFeet(synth, 7.3, a);
    sampleFeet(synth, 7.3, b);
    expect(snap(b)).toEqual(snap(a));
  });

  it('never freezes: the feet keep moving arbitrarily far in the future (loop, not exhaust)', () => {
    const s = makeSampledFeet();
    // The old cursor scheduler would sit at the chart end here; the periodic timeline keeps going.
    const positions = new Set<string>();
    for (let t = 1000; t < 1016; t += 0.5) {
      sampleFeet(synth, t, s);
      positions.add(s.pos[0].x.toFixed(3) + ',' + s.pos[1].x.toFixed(3));
    }
    expect(positions.size).toBeGreaterThan(4); // genuinely moving, not stuck on one pose
  });

  it('is continuous across the loop seam (b = 16) — no teleport', () => {
    const lo = makeSampledFeet();
    const hi = makeSampledFeet();
    const eps = 1e-4;
    // Straddle the seam and several interior beats; a step across ε must be tiny.
    for (const seam of [16, 32, 8.5, 12.25, 5.0]) {
      sampleFeet(synth, seam - eps, lo);
      sampleFeet(synth, seam + eps, hi);
      const d0 = lo.pos[0].distanceTo(hi.pos[0]);
      const d1 = lo.pos[1].distanceTo(hi.pos[1]);
      expect(d0).toBeLessThan(0.01);
      expect(d1).toBeLessThan(0.01);
    }
  });

  it('reports land events and step distance the body model needs', () => {
    const s = makeSampledFeet();
    // Foot 0 lands panel 0 at beat 0.5 (synth). Sample just after: landBeat reflects it.
    sampleFeet(synth, 0.7, s);
    expect(s.landBeat[0]).toBeCloseTo(0.5, 5);
    // A mid-swing foot has reduced support: foot 1 swings toward panel 2 landing on beat 3.0,
    // so at 2.7 it is airborne.
    sampleFeet(synth, 2.7, s);
    expect(s.support[1]).toBeLessThan(1);
    expect(s.swingU[1]).toBeGreaterThan(0);
  });

  it('a finite chart plants at its last step forever (no freeze, just standing)', () => {
    const chart = buildChartTimeline(
      [
        { beat: 1, cols: 4, lCol: 0 },
        { beat: 2, cols: 4, rCol: 3 },
      ],
      PANEL,
      HOME,
      0.07,
    );
    const near = makeSampledFeet();
    const far = makeSampledFeet();
    sampleFeet(chart, 3, near);
    sampleFeet(chart, 500, far);
    // Both feet planted at their last panel; identical whether we ask at beat 3 or 500.
    expect(snap(far)).toEqual(snap(near));
    expect(far.pos[0].x).toBeCloseTo(-0.3, 5); // foot 0 last on panel 0 (L)
    expect(far.pos[1].x).toBeCloseTo(0.3, 5); // foot 1 last on panel 3 (R)
  });
});
