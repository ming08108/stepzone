/**
 * Pure footwork sampler — the dancer's feet as a STATELESS function of beat.
 *
 * The old scheduler advanced a monotonic cursor through the chart each frame; when the
 * song looped/seeked/retried (the beat going backward), the cursor sat at the end and the
 * feet froze forever. This replaces it with a precomputed per-foot timeline of placements
 * that is *sampled* by binary search every frame — a loop, seek, or restart just samples a
 * different beat, so a freeze is structurally impossible (there is no state to exhaust).
 *
 * A `Placement` is "this foot lands on this panel at this beat". Between placements the foot
 * is planted at the previous one; in the SWING_BEATS window before a land it swings from the
 * previous placement to the next (min-jerk + a lift arc). The synth routine is a *periodic*
 * timeline (loops every 16 beats); a chart is finite (plants at its last step after the end).
 *
 * The sampler also returns everything the body's centre-of-mass model needs (swing
 * destination, progress, land beat, step distance, jump lift) so the whole rig can be a
 * consequence of the feet — see threeDancer.ts.
 */
import * as THREE from 'three/webgpu';
import type { DancerStep } from './threeDancer';

// A step is a QUICK move at the end of the beat: the foot HOLDS its arrow, then steps and
// plants ON the beat. Beats of swing before the landing beat.
export const SWING_BEATS = 0.55;

export interface Placement {
  land: number; // beat this foot plants
  pos: THREE.Vector3; // ankle-height floor position it plants on
  panel: number; // 0=L,1=D,2=U,3=R; -1 = home/rest sentinel
  jump: boolean; // landed as half of a two-foot jump
}

export interface FootTimeline {
  feet: [Placement[], Placement[]]; // sorted by land; finite charts get a home sentinel first
  period: number; // >0 → loops with this beat period (synth); 0 → finite (chart)
}

/** Per-frame foot state — all the body model consumes. Vectors are reused scratch. */
export interface SampledFeet {
  pos: [THREE.Vector3, THREE.Vector3]; // current foot position
  dest: [THREE.Vector3, THREE.Vector3]; // where a swinging foot is going (else = pos)
  support: [number, number]; // 0..1 weight this foot can bear (1 planted, →0.15 mid-swing)
  pitch: [number, number]; // ankle articulation (toe lead)
  swingU: [number, number]; // 0 planted, else swing progress 0..1
  landBeat: [number, number]; // beat the current plant landed on (changes = a land event)
  stepDist: [number, number]; // distance of the step that produced the current plant
  jumpLift: number; // normalized whole-body hop (× legLen by the caller)
  litPanel: [number, number, number, number]; // most-recent land beat per panel (or -9)
  nextLand: [number, number]; // beat of each foot's UPCOMING step (Infinity if none) — for note markers
  nextPanel: [number, number]; // panel of each foot's upcoming step (-1 if none)
}

export function makeSampledFeet(): SampledFeet {
  return {
    pos: [new THREE.Vector3(), new THREE.Vector3()],
    dest: [new THREE.Vector3(), new THREE.Vector3()],
    support: [1, 1],
    pitch: [0, 0],
    swingU: [0, 0],
    landBeat: [-1e9, -1e9],
    stepDist: [0, 0],
    jumpLift: 0,
    litPanel: [-9, -9, -9, -9],
    nextLand: [Infinity, Infinity],
    nextPanel: [-1, -1],
  };
}

function minJerk(u: number): number {
  return u * u * u * (10 - 15 * u + 6 * u * u);
}

// Per-step variation (deterministic hash of the land beat) so steps aren't identical stamps.
function vary(land: number): number {
  const h = Math.sin(land * 49.17) * 7845.31;
  return 0.75 + 0.5 * (h - Math.floor(h));
}

function pAt(panels: readonly THREE.Vector3[], ankleY: number, p: number): THREE.Vector3 {
  return panels[p].clone().setY(ankleY);
}

/** Build a finite timeline from a chart's foot stream. Each foot plants at its home spot
 *  until its first step; after the last step it stays planted there. */
export function buildChartTimeline(
  steps: readonly DancerStep[],
  panels: readonly THREE.Vector3[],
  home: readonly THREE.Vector3[],
  ankleY: number,
): FootTimeline {
  const feet: [Placement[], Placement[]] = [[], []];
  for (let f = 0; f < 2; f++) {
    feet[f].push({ land: -1e9, pos: home[f].clone().setY(ankleY), panel: -1, jump: false });
  }
  const sorted = [...steps].sort((a, b) => a.beat - b.beat);
  for (const row of sorted) {
    const l = row.lCol ?? -1;
    const r = row.rCol ?? -1;
    const jump = l >= 0 && r >= 0;
    if (l >= 0) feet[0].push({ land: row.beat, pos: pAt(panels, ankleY, l), panel: l, jump });
    if (r >= 0) feet[1].push({ land: row.beat, pos: pAt(panels, ankleY, r), panel: r, jump });
  }
  return { feet, period: 0 };
}

/** Placeholder choreography (the ?vrm proving ground / no-chart fallback): a 16-beat routine
 *  at 8th-note resolution — alternating quarters, fast runs, crossovers, jumps, a feet-together
 *  stomp — that LOOPS. As a periodic timeline it samples cleanly across the wrap. */
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
  // beats 13-16 — STAGGERED crossovers, split back out. (Steps here are deliberately one-foot-
  // at-a-time: a perfectly simultaneous, symmetric two-foot cross forces both knees through the
  // centreline at once — the one stance no IK depth-split can separate. Real charts step one foot
  // at a time, so the demo does too.)
  { foot: 1, panel: 0 },
  'hold',
  { foot: 0, panel: 3 },
  'hold',
  { foot: 1, panel: 2 },
  { foot: 0, panel: 1 },
  { foot: 0, panel: 0 },
  { foot: 1, panel: 3 },
];

export function buildSynthTimeline(
  panels: readonly THREE.Vector3[],
  home: readonly THREE.Vector3[],
  ankleY: number,
): FootTimeline {
  const feet: [Placement[], Placement[]] = [[], []];
  for (let hb = 0; hb < SYNTH.length; hb++) {
    const step = SYNTH[hb];
    if (step === 'hold') continue;
    const land = (hb + 1) / 2;
    if ('l' in step) {
      feet[0].push({ land, pos: pAt(panels, ankleY, step.l), panel: step.l, jump: true });
      feet[1].push({ land, pos: pAt(panels, ankleY, step.r), panel: step.r, jump: true });
    } else {
      feet[step.foot].push({
        land,
        pos: pAt(panels, ankleY, step.panel),
        panel: step.panel,
        jump: false,
      });
    }
  }
  // A foot with no steps in the routine would have no neighbours to sample — give it a home
  // sentinel so it simply stands (never happens with the routine above, but keeps sampling total).
  for (let f = 0; f < 2; f++) {
    if (feet[f].length === 0) {
      feet[f].push({ land: 0, pos: home[f].clone().setY(ankleY), panel: -1, jump: false });
    }
  }
  return { feet, period: 16 };
}

// Logical placement lookup over an unbounded index j. For a periodic timeline j wraps and the
// land unwraps by whole periods, so lands are monotonic in j across the loop seam; for a finite
// timeline j is clamped to the array (out of range → null).
function landOf(A: Placement[], period: number, j: number): number {
  if (period > 0) {
    const len = A.length;
    const k = Math.floor(j / len);
    const idx = ((j % len) + len) % len;
    return A[idx].land + k * period;
  }
  return A[j].land;
}
function placeOf(A: Placement[], period: number, j: number): Placement {
  if (period > 0) {
    const len = A.length;
    const idx = ((j % len) + len) % len;
    return A[idx];
  }
  return A[j];
}

/** Sample both feet at beat `b`, writing into `out` (zero-alloc). Pure — same `b` always
 *  gives the same result regardless of call history. */
export function sampleFeet(tl: FootTimeline, b: number, out: SampledFeet): SampledFeet {
  out.litPanel[0] = out.litPanel[1] = out.litPanel[2] = out.litPanel[3] = -9;
  const gbp = b - Math.floor(b); // global beat phase — drives the planted-foot ankle roll
  const period = tl.period;

  // per-foot swing bookkeeping for jump detection
  let sw0 = false;
  let sw1 = false;
  let nl0 = 0;
  let nl1 = 0;
  let jb0 = false;
  let jb1 = false;

  for (let f = 0; f < 2; f++) {
    const A = tl.feet[f];
    const len = A.length;

    // jPrev = largest logical index with land ≤ b (the placement the foot is standing on / left).
    let jPrev: number;
    if (period > 0) {
      const k = Math.floor(b / period);
      const bm = b - k * period;
      let i = -1;
      let lo = 0;
      let hi = len - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (A[mid].land <= bm) {
          i = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      jPrev = k * len + i; // i === -1 → last placement of the previous period
    } else {
      let i = 0;
      let lo = 0;
      let hi = len - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (A[mid].land <= b) {
          i = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      jPrev = i;
    }

    const prev = placeOf(A, period, jPrev);
    const prevLand = landOf(A, period, jPrev);
    const hasNext = period > 0 || jPrev + 1 < len;
    const hasPrevPrev = period > 0 || jPrev - 1 >= 0;

    // Panel glow from the current plant.
    if (prev.panel >= 0 && b - prevLand >= 0 && b - prevLand < 1) {
      out.litPanel[prev.panel] = Math.max(out.litPanel[prev.panel], prevLand);
    }

    // Step distance of the step that produced this plant (for the vertical land impulse).
    out.stepDist[f] = hasPrevPrev ? prev.pos.distanceTo(placeOf(A, period, jPrev - 1).pos) : 0;
    out.landBeat[f] = prevLand;

    if (!hasNext) {
      // Past the chart's last step — plant forever.
      out.pos[f].copy(prev.pos);
      out.dest[f].copy(prev.pos);
      out.support[f] = 1;
      out.pitch[f] = 0.035 * Math.sin(2 * Math.PI * gbp + f * Math.PI);
      out.swingU[f] = 0;
      out.nextLand[f] = Infinity;
      out.nextPanel[f] = -1;
      continue;
    }

    const next = placeOf(A, period, jPrev + 1);
    const nextLand = landOf(A, period, jPrev + 1);
    out.nextLand[f] = nextLand; // the upcoming step — for the note markers
    out.nextPanel[f] = next.panel;
    // Swing duration: SWING_BEATS, but capped to 70% of the gap so there's always a brief PLANT
    // between steps. Fast/dense footwork (8th-16th notes) used to fill the whole gap with one
    // continuous swing — the foot never settled, so quick sections read as a floaty glide instead
    // of crisp steps. Leaving ~30% of the gap planted makes fast transitions snap.
    const gap = nextLand - prevLand;
    const swingDur = Math.min(SWING_BEATS, 0.7 * gap);
    const t0 = nextLand - swingDur;

    if (b < t0) {
      // Planted, holding the arrow; a small ankle roll keeps the standing leg alive.
      out.pos[f].copy(prev.pos);
      out.dest[f].copy(prev.pos);
      out.support[f] = 1;
      out.pitch[f] = 0.035 * Math.sin(2 * Math.PI * gbp + f * Math.PI);
      out.swingU[f] = 0;
    } else {
      const denom = nextLand - t0 || 1;
      const u = Math.min(1, Math.max(0, (b - t0) / denom));
      const vv = vary(nextLand);
      out.pos[f].copy(prev.pos).lerp(next.pos, minJerk(u));
      const arc = Math.sin(u * Math.PI);
      out.pos[f].y += arc * (next.jump ? 0.14 : 0.09) * vv; // pick the foot up
      // A crossing step (heading to the far side of its own hip) swings IN FRONT of the
      // standing leg (a +z bulge) instead of scissoring through it.
      const crossing = f === 0 ? next.pos.x > 0.05 : next.pos.x < -0.05;
      if (crossing) out.pos[f].z += arc * 0.2;
      out.dest[f].copy(next.pos);
      // Heel-toe roll: PUSH OFF the ball early (strong toe-down as she leaves the ground), swing
      // through toe-leading, then bring the HEEL down just before the landing — a real foot roll
      // rather than a flat slab gliding. (Caller scales this by tune.footRoll.)
      const pushoff = u < 0.28 ? (0.28 - u) * 2.1 : 0; // toe-down kick off the ball
      const heelStrike = u > 0.72 ? (u - 0.72) * 1.4 : 0; // heel leads down into the plant
      out.pitch[f] = (arc * 0.5 + pushoff - heelStrike) * vv;
      out.support[f] = 1 - 0.85 * arc;
      out.swingU[f] = u;
      if (f === 0) {
        sw0 = true;
        nl0 = nextLand;
        jb0 = next.jump;
      } else {
        sw1 = true;
        nl1 = nextLand;
        jb1 = next.jump;
      }
    }
  }

  // A jump: both feet swinging toward a jump landing on the same beat → whole body hops.
  out.jumpLift = 0;
  if (sw0 && sw1 && jb0 && jb1 && Math.abs(nl0 - nl1) < 1e-6) {
    const jt0 = nl0 - SWING_BEATS;
    const uj = Math.min(1, Math.max(0, (b - jt0) / SWING_BEATS));
    const arc = Math.sin(uj * Math.PI);
    const anticip = uj < 0.2 ? -(0.2 - uj) * 0.4 : 0; // crouch before the leap
    out.jumpLift = arc * 0.16 + anticip;
  }

  return out;
}
