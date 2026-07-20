/**
 * Generate a small synthetic replay fixture for ?replaydancer and the batch
 * render verification. Procedurally sways a standing humanoid, plants feet on
 * the DDR pads on the beat, and emits a dozen notes with mixed judgments.
 *
 * Output: tests/fixtures/replay-sample.json (replay format v1, fps 60, pos+quat
 * block layout — see docs/replay-format.md and src/render/replay.ts).
 *
 *   node scripts/genReplayFixture.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'tests', 'fixtures', 'replay-sample.json');

const FPS = 60;
const DUR = 8.0; // seconds
const NFRAMES = Math.round(FPS * DUR) + 1;
const NBODY = 15;

// Body indices (reduced humanoid_28 order).
const PELVIS = 0,
  TORSO = 1,
  HEAD = 2,
  RUA = 3,
  RLA = 4,
  RH = 5,
  LUA = 6,
  LLA = 7,
  LH = 8,
  RT = 9,
  RS = 10,
  RF = 11,
  LT = 12,
  LS = 13,
  LF = 14;

// DDR pad centers in Isaac env-local ground coords (x forward, y left). 0=L,1=R,2=U,3=D.
const PADS = [
  [0, 0.3], // L
  [0, -0.3], // R
  [0.3, 0], // U
  [-0.3, 0], // D
];

// A dozen notes: pad cycle, alternating feet, mixed judgments on the beat.
const BEAT = 0.5; // 120 BPM
const JUDG = ['marvelous', 'marvelous', 'perfect', 'great', 'marvelous', 'miss'];
const notes = [];
for (let i = 0; i < 12; i++) {
  const t = 1.0 + i * BEAT;
  const pad = [0, 3, 2, 1][i % 4]; // L D U R visual cycle
  const foot = i % 2; // 0=left,1=right
  const judgment = JUDG[i % JUDG.length];
  const hit_dt_ms = judgment === 'miss' ? null : Math.round((Math.sin(i) * 18 - 4) * 10) / 10;
  notes.push({ t, pad, foot, judgment, hit_dt_ms, hold_s: 0 });
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function smooth(t) {
  return t * t * (3 - 2 * t);
}

// Which foot is stepping where, at time `t` (returns {x,y,z lift} per foot).
function footState(t, footIdx) {
  // footIdx: 0 = left foot body, 1 = right foot body
  let target = null;
  for (const n of notes) {
    if (n.foot !== footIdx) continue;
    const dt = t - n.t;
    if (dt < -0.28 || dt > 0.35) continue;
    target = { pad: PADS[n.pad], dt };
  }
  const restY = footIdx === 0 ? 0.12 : -0.12; // left foot +y, right foot -y
  if (!target) return { x: 0, y: restY, lift: 0.05 };
  const { pad, dt } = target;
  // approach (-0.28..0): lift + glide toward the pad; land at dt=0; settle after.
  let f, lift;
  if (dt < 0) {
    f = smooth((dt + 0.28) / 0.28); // 0 -> 1 approaching
    lift = 0.16 * Math.sin(f * Math.PI); // arc up then down
  } else {
    f = 1;
    lift = 0.05 * (1 - smooth(Math.min(1, dt / 0.35))); // settle back
  }
  return {
    x: lerp(0, pad[0], f),
    y: lerp(restY, pad[1], f),
    lift: 0.05 + lift,
  };
}

const frames = [];
for (let fi = 0; fi < NFRAMES; fi++) {
  const t = fi / FPS;
  const sway = Math.sin(t * 2 * Math.PI * 0.5); // 0.5 Hz body sway
  const bob = Math.sin(t * 2 * Math.PI * 1.0); // 1 Hz knee bob
  const armSwing = Math.sin(t * 2 * Math.PI * 0.5 + 0.6);

  const hipY = 0.05 * sway; // side-to-side weight shift
  const hipZ = 0.95 - 0.03 * Math.abs(bob); // subtle bob

  const rf = footState(t, 1);
  const lf = footState(t, 0);

  const P = new Array(NBODY);
  // Torso column
  P[PELVIS] = [0, hipY, hipZ];
  P[TORSO] = [0.02 * sway, hipY * 0.7, hipZ + 0.25];
  P[HEAD] = [0.03 * sway, hipY * 0.5, hipZ + 0.6];
  // Arms (relaxed, gentle swing; right = -y, left = +y)
  const shZ = hipZ + 0.45;
  P[RUA] = [0.02 * sway, -0.19, shZ];
  P[RLA] = [0.06 + 0.05 * armSwing, -0.26, shZ - 0.22];
  P[RH] = [0.1 + 0.09 * armSwing, -0.3, shZ - 0.42];
  P[LUA] = [0.02 * sway, 0.19, shZ];
  P[LLA] = [0.06 - 0.05 * armSwing, 0.26, shZ - 0.22];
  P[LH] = [0.1 - 0.09 * armSwing, 0.3, shZ - 0.42];
  // Right leg
  P[RT] = [0, -0.1, hipZ - 0.05];
  P[RF] = [rf.x, rf.y, rf.lift];
  P[RS] = [(P[RT][0] + rf.x) * 0.5 + 0.04, (P[RT][1] + rf.y) * 0.5, (P[RT][2] + rf.lift) * 0.5];
  // Left leg
  P[LT] = [0, 0.1, hipZ - 0.05];
  P[LF] = [lf.x, lf.y, lf.lift];
  P[LS] = [(P[LT][0] + lf.x) * 0.5 + 0.04, (P[LT][1] + lf.y) * 0.5, (P[LT][2] + lf.lift) * 0.5];

  const row = [];
  for (let b = 0; b < NBODY; b++) row.push(P[b][0], P[b][1], P[b][2]);
  // Quaternion block (WXYZ). Identity per body — the position-swing retarget
  // derives facing/limb aim from the joints; the twist layer applies ~0 delta.
  // (Real captures carry meaningful per-body world quats here.)
  for (let b = 0; b < NBODY; b++) row.push(1, 0, 0, 0);
  frames.push(row.map((v) => Math.round(v * 1e5) / 1e5));
}

const replay = {
  version: 1,
  fps: FPS,
  chart: { name: 'Synthetic Sway (fixture)', notes },
  frames,
  meta: {
    checkpoint: 'fixture:synthetic',
    ex_score: 22.8,
    clean_rate: 0.61,
    survived: true,
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(replay));
const kb = (JSON.stringify(replay).length / 1024).toFixed(0);
console.log(`wrote ${OUT} — ${NFRAMES} frames @ ${FPS}fps, ${notes.length} notes, ${kb} KB`);
