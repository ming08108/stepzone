/**
 * Generates a hand-crafted, PS1-quality "Miku-style" dancer as a VRM 0.x GLB —
 * ORIGINAL geometry and textures (no licensed asset), so it ships. The model is
 * rigid-skinned (every vertex bound to exactly ONE bone, weight 1.0), which is
 * exactly how PlayStation-era characters articulated: segmented limbs with
 * visible joint seams and no smooth blending. Flat-shaded, blocky, ~a few
 * hundred triangles, with a tiny painted face texture.
 *
 * The bone hierarchy uses the VRM humanoid names our retarget expects
 * (retargetRig.ts VRM_CHAINS), and the avatar faces -Z (VRM 0.x convention) so
 * the loader's 180° pre-rotation and crossed L/R chains drive it like the VRoid
 * avatars. Run: `node scripts/genPs1Miku.mjs` → public/models/PS1Miku.vrm
 */
import { writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'PS1Miku.vrm');

// ---------------------------------------------------------------------------
// Palette (linear-ish sRGB factors), tuned to canonical Hatsune Miku so every
// teal accent sings one note (#39C5BB). Sleeves + skirt are a blue-navy (not
// pure black) so they read apart from the boots.
const TEAL = [0.224, 0.773, 0.733]; // #39C5BB — hair + all teal accents
const SKIN = [1.0, 0.85, 0.76];
const WHITE = [0.93, 0.95, 0.97];
const NAVY = [0.086, 0.102, 0.18]; // #161A2E — sleeves + skirt
const BOOT = [0.05, 0.055, 0.09]; // boots, a touch darker than the navy
const MAG = [0.878, 0.2, 0.541]; // #E0338A — hair-tie / earphone accent
const GREY = [0.32, 0.35, 0.42]; // headset band + ear pods
const RED = [0.86, 0.22, 0.28]; // a collar function button

// Material table: name → { color, tex? }. Order fixes material index.
const MATS = [
  { key: 'skin', color: SKIN },
  { key: 'hair', color: TEAL }, // hair AND every teal accent (tie, cuffs, trim)
  { key: 'top', color: WHITE },
  { key: 'navy', color: NAVY }, // detached sleeves + skirt
  { key: 'boot', color: BOOT },
  { key: 'mag', color: MAG }, // hair-tie modules + earphone accents
  { key: 'grey', color: GREY }, // headset
  { key: 'red', color: RED }, // collar button
  { key: 'face', color: [1, 1, 1], tex: true }, // sampled face texture
];
const MI = Object.fromEntries(MATS.map((m, i) => [m.key, i]));

// ---------------------------------------------------------------------------
// Skeleton: VRM humanoid bone name → { parent, t:[localTranslation] }. T-pose,
// Y-up, facing -Z. Anatomical LEFT is -X (see VRM_CHAINS note). Units = metres.
const BONES = {
  hips: { parent: null, t: [0, 0.92, 0] },
  spine: { parent: 'hips', t: [0, 0.1, 0] },
  chest: { parent: 'spine', t: [0, 0.13, 0] },
  neck: { parent: 'chest', t: [0, 0.16, 0] },
  head: { parent: 'neck', t: [0, 0.07, 0] },
  leftShoulder: { parent: 'chest', t: [-0.04, 0.13, 0] },
  leftUpperArm: { parent: 'leftShoulder', t: [-0.07, 0, 0] },
  leftLowerArm: { parent: 'leftUpperArm', t: [-0.24, 0, 0] },
  leftHand: { parent: 'leftLowerArm', t: [-0.22, 0, 0] },
  rightShoulder: { parent: 'chest', t: [0.04, 0.13, 0] },
  rightUpperArm: { parent: 'rightShoulder', t: [0.07, 0, 0] },
  rightLowerArm: { parent: 'rightUpperArm', t: [0.24, 0, 0] },
  rightHand: { parent: 'rightLowerArm', t: [0.22, 0, 0] },
  leftUpperLeg: { parent: 'hips', t: [-0.09, 0, 0] },
  leftLowerLeg: { parent: 'leftUpperLeg', t: [0, -0.42, 0] },
  leftFoot: { parent: 'leftUpperLeg', t: [0, -0.42, 0], _via: 'leftLowerLeg' },
  rightUpperLeg: { parent: 'hips', t: [0.09, 0, 0] },
  rightLowerLeg: { parent: 'rightUpperLeg', t: [0, -0.42, 0] },
  rightFoot: { parent: 'rightUpperLeg', t: [0, -0.42, 0], _via: 'rightLowerLeg' },
};
// Fix the feet parents (chain through the lower legs).
BONES.leftFoot.parent = 'leftLowerLeg';
BONES.rightFoot.parent = 'rightLowerLeg';

const BONE_NAMES = Object.keys(BONES);
const jointIndex = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));

// Accumulate world-space bind positions.
const world = {};
function worldPos(name) {
  if (world[name]) return world[name];
  const b = BONES[name];
  const p = b.parent ? worldPos(b.parent) : [0, 0, 0];
  world[name] = [p[0] + b.t[0], p[1] + b.t[1], p[2] + b.t[2]];
  return world[name];
}
BONE_NAMES.forEach(worldPos);

// ---------------------------------------------------------------------------
// Geometry accumulation, grouped by material. Each vertex: pos, nrm, uv, joint.
const groups = MATS.map(() => ({ pos: [], nrm: [], uv: [], joint: [], idx: [] }));

function pushTri(g, a, b, c, nrm, uv) {
  const base = g.pos.length / 3;
  for (const v of [a, b, c]) {
    g.pos.push(v[0], v[1], v[2]);
    g.nrm.push(nrm[0], nrm[1], nrm[2]);
  }
  g.uv.push(uv[0][0], uv[0][1], uv[1][0], uv[1][1], uv[2][0], uv[2][1]);
  g.idx.push(base, base + 1, base + 2);
}

function faceNormalOut(a, b, c, center) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const fc = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  const out = [fc[0] - center[0], fc[1] - center[1], fc[2] - center[2]];
  if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) n = [-n[0], -n[1], -n[2]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

const Z2 = [
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
];
// Add one quad (a,b,c,d CCW) to a material group, bound to `bone`. Optional uv[4].
function addQuad(matKey, bone, a, b, c, d, center, uv) {
  const g = groups[MI[matKey]];
  const j = jointIndex[bone];
  const n = faceNormalOut(a, b, c, center);
  const uvv = uv || Z2;
  const before = g.pos.length / 3;
  pushTri(g, a, b, c, n, [uvv[0], uvv[1], uvv[2]]);
  pushTri(g, a, c, d, n, [uvv[0], uvv[2], uvv[3]]);
  const added = g.pos.length / 3 - before;
  for (let k = 0; k < added; k++) g.joint.push(j);
}

// Add an axis-aligned box (optionally tapered by separate top/bottom half-XZ).
function addBox(matKey, bone, cx, cy, cz, hx, hy, hz, opt = {}) {
  const hxT = opt.hxTop ?? hx,
    hzT = opt.hzTop ?? hz;
  const hxB = opt.hxBot ?? hx,
    hzB = opt.hzBot ?? hz;
  const y0 = cy - hy,
    y1 = cy + hy;
  // 8 corners: bottom (b*) then top (t*), (-x-z)(+x-z)(+x+z)(-x+z)
  const b0 = [cx - hxB, y0, cz - hzB],
    b1 = [cx + hxB, y0, cz - hzB],
    b2 = [cx + hxB, y0, cz + hzB],
    b3 = [cx - hxB, y0, cz + hzB];
  const t0 = [cx - hxT, y1, cz - hzT],
    t1 = [cx + hxT, y1, cz - hzT],
    t2 = [cx + hxT, y1, cz + hzT],
    t3 = [cx - hxT, y1, cz + hzT];
  const C = [cx, cy, cz];
  const skip = opt.skip || {};
  if (!skip.front) addQuad(matKey, bone, b0, b1, t1, t0, C, opt.uvFront); // -Z (face side)
  if (!skip.back) addQuad(matKey, bone, b2, b3, t3, t2, C); // +Z
  if (!skip.left) addQuad(matKey, bone, b3, b0, t0, t3, C); // -X
  if (!skip.right) addQuad(matKey, bone, b1, b2, t2, t1, C); // +X
  if (!skip.top) addQuad(matKey, bone, t0, t1, t2, t3, C);
  if (!skip.bottom) addQuad(matKey, bone, b3, b2, b1, b0, C);
}

const W = worldPos;
// Segment box between two joints, thin cross-section, bound to `bone`.
function segBox(matKey, bone, aName, bName, r, opt = {}) {
  const a = W(aName),
    b = W(bName);
  const cx = (a[0] + b[0]) / 2,
    cy = (a[1] + b[1]) / 2,
    cz = (a[2] + b[2]) / 2;
  const hx = Math.max(Math.abs(b[0] - a[0]) / 2, r) + (opt.padX || 0);
  const hy = Math.max(Math.abs(b[1] - a[1]) / 2, r) + (opt.padY || 0);
  const hz = r + (opt.padZ || 0);
  addBox(matKey, bone, cx, cy, cz, hx, hy, hz, opt);
}

const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vcross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const vnorm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// An N-gon prism ("tube") between two end centers a→b, radius rA→rB, `sides`
// facets — the rounded, chamfered limb PS1 used instead of a raw cube. `roll`
// rotates the ring so a facet can be aimed (e.g. a flat front for the face).
// caps: [capA, capB] adds end fans. Flat per-face normals. All verts → `bone`.
function tube(matKey, bone, a, b, rA, rB, sides, opt = {}) {
  const roll = opt.roll || 0;
  const axis = vnorm(vsub(b, a));
  const up = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
  const u = vnorm(vcross(up, axis));
  const v = vcross(axis, u);
  const mid = vscale(vadd(a, b), 0.5);
  const g = groups[MI[matKey]];
  const j = jointIndex[bone];
  const ring = (c, r) => {
    const pts = [];
    for (let k = 0; k < sides; k++) {
      const ang = roll + (k / sides) * Math.PI * 2;
      const dir = vadd(vscale(u, Math.cos(ang)), vscale(v, Math.sin(ang)));
      pts.push(vadd(c, vscale(dir, r)));
    }
    return pts;
  };
  const ra = ring(a, rA),
    rb = ring(b, rB);
  const quad = (p0, p1, p2, p3) => {
    const n = faceNormalOut(p0, p1, p2, mid);
    const base = g.pos.length / 3;
    for (const p of [p0, p1, p2, p0, p2, p3]) {
      g.pos.push(p[0], p[1], p[2]);
      g.nrm.push(n[0], n[1], n[2]);
      g.uv.push(0, 0);
      g.joint.push(j);
    }
    for (let t = 0; t < 6; t++) g.idx.push(base + t);
  };
  for (let k = 0; k < sides; k++) {
    const k1 = (k + 1) % sides;
    quad(ra[k], ra[k1], rb[k1], rb[k]);
  }
  const cap = (center, rr, out) => {
    const n = vnorm(out);
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      const base = g.pos.length / 3;
      const tri = out[1] >= 0 ? [center, rr[k1], rr[k]] : [center, rr[k], rr[k1]];
      for (const p of tri) {
        g.pos.push(p[0], p[1], p[2]);
        g.nrm.push(n[0], n[1], n[2]);
        g.uv.push(0, 0);
        g.joint.push(j);
      }
      g.idx.push(base, base + 1, base + 2);
    }
  };
  if (opt.capA !== false) cap(a, ra, vscale(axis, -1));
  if (opt.capB !== false) cap(b, rb, axis);
}

// A tapered limb segment between two joints, along the bone, `sides`-gon.
function segTube(matKey, boneA, boneB, bone, rA, rB, sides, opt = {}) {
  tube(matKey, bone, W(boneA), W(boneB), rA, rB, sides, opt);
}

// ============================ BUILD THE FIGURE =============================
const lerp = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const head = W('head');
const HEADCY = head[1] + 0.09;
// Head: a rounded 8-gon (not a cube). The face is a separate textured plate.
tube('skin', 'head', [0, HEADCY - 0.11, 0], [0, HEADCY + 0.09, 0.005], 0.115, 0.1, 8);
// Face plate: a quad just in front (-Z) of the head, textured.
{
  const z = -0.098,
    x = 0.095,
    y0 = HEADCY - 0.1,
    y1 = HEADCY + 0.08;
  addQuad(
    'face',
    'head',
    [-x, y0, z],
    [x, y0, z],
    [x, y1, z],
    [-x, y1, z],
    [0, HEADCY, 0.2],
    [
      [1, 1],
      [0, 1],
      [0, 0],
      [1, 0],
    ],
  );
}
// Hair: cap over the crown/back (front stays open for the face), plus a fringe
// of bangs low across the forehead and side locks framing the face.
addBox('hair', 'head', 0, HEADCY + 0.04, 0.015, 0.125, 0.095, 0.1, {
  skip: { front: true, bottom: true },
});
addBox('hair', 'head', 0, HEADCY + 0.055, -0.095, 0.115, 0.05, 0.02); // fringe / bangs
addBox('hair', 'head', -0.112, HEADCY - 0.03, -0.02, 0.022, 0.1, 0.075); // side lock L
addBox('hair', 'head', 0.112, HEADCY - 0.03, -0.02, 0.022, 0.1, 0.075); // side lock R
// Twintails: anchored HIGH on the upper sides, flaring out ~40% then hanging to
// hip height with a clear gap of air from the torso — twin spikes in silhouette
// read as "Miku" instantly. A chunky magenta hair-tie module sits at each root.
for (const s of [-1, 1]) {
  const root = [s * 0.13, HEADCY + 0.05, 0.0];
  const mid = [s * 0.3, HEADCY - 0.22, 0.03]; // flared outward → the gap + spike
  const tip = [s * 0.24, 0.63, 0.05]; // falls to ~hip height, curling slightly in
  addBox('mag', 'head', s * 0.15, HEADCY + 0.03, 0.0, 0.05, 0.055, 0.05); // hair-tie
  tube('hair', 'head', root, mid, 0.055, 0.08, 6); // upper tail, flared
  tube('hair', 'head', mid, tip, 0.08, 0.016, 6); // lower tail, tapering to a point
}

// Headset — Miku's single most iconic prop. A grey band arcs ear-to-ear over the
// crown; each ear has a pod (grey) with a pink speaker centre and a teal
// "conductor" fin sweeping up-and-back.
{
  const earY = HEADCY - 0.01;
  const bandPts = [
    [-0.15, earY + 0.02, 0.0],
    [-0.1, HEADCY + 0.13, 0.0],
    [0.1, HEADCY + 0.13, 0.0],
    [0.15, earY + 0.02, 0.0],
  ];
  for (let i = 0; i < bandPts.length - 1; i++)
    tube('grey', 'head', bandPts[i], bandPts[i + 1], 0.02, 0.02, 4, { capA: false, capB: false });
  for (const s of [-1, 1]) {
    const inner = [s * 0.125, earY, 0.0];
    const outer = [s * 0.175, earY, 0.0];
    tube('grey', 'head', inner, outer, 0.058, 0.062, 8); // ear pod
    tube(
      'mag',
      'head',
      vadd(outer, [s * 0.001, 0, 0]),
      vadd(outer, [s * 0.02, 0, 0]),
      0.03,
      0.026,
      8,
      {
        capA: false,
      },
    ); // pink speaker centre
    // Teal conductor fin: a thin blade sweeping up and back from the pod.
    addBox('hair', 'head', s * 0.185, earY + 0.06, 0.05, 0.012, 0.07, 0.03, {
      hxTop: 0.012,
      hzTop: 0.012,
    });
  }
}

// Neck (rounded)
tube('skin', 'neck', [0, W('neck')[1] - 0.02, 0], [0, W('neck')[1] + 0.07, 0], 0.045, 0.045, 6);
// Collar band (navy) at the base of the neck, with a row of little function
// buttons down the front (red / teal / magenta) — a nod to her shirt's detailing.
tube('navy', 'chest', [0, W('chest')[1] + 0.06, 0], [0, W('chest')[1] + 0.11, 0], 0.075, 0.06, 8);
{
  const cy = W('chest')[1] + 0.04;
  const btn = ['red', 'hair', 'mag'];
  for (let i = 0; i < 3; i++)
    addBox(btn[i], 'chest', 0.0, cy - i * 0.03, -0.078, 0.011, 0.011, 0.008);
}

// Torso: two rounded 8-gon segments (spine, chest) so it bends. White top.
segTube('top', 'hips', 'spine', 'spine', 0.115, 0.11, 8, { capA: false });
segTube('top', 'spine', 'chest', 'chest', 0.115, 0.125, 8, { capB: false });
// Tie: a thin teal strip down the chest front.
addBox('hair', 'chest', 0, W('chest')[1] - 0.02, -0.108, 0.022, 0.11, 0.015);
// Skirt: a flared 8-gon frustum (pleats read from the facets), navy with a teal
// hem trim. Hem ~1.7x the waist so it reads as a skirt, not shorts.
const hipY = W('hips')[1];
tube('navy', 'hips', [0, hipY + 0.02, 0], [0, hipY - 0.15, 0], 0.115, 0.2, 8, { capA: false });
tube('hair', 'hips', [0, hipY - 0.15, 0], [0, hipY - 0.175, 0], 0.2, 0.205, 8, { capA: false }); // hem trim

// Arms: BARE shoulders + upper arm (skin); detached navy sleeve on the forearm
// with a teal cuff at the wrist (canonical Miku, the inverse of shoulder pads).
for (const side of ['left', 'right']) {
  const U = side + 'UpperArm',
    L = side + 'LowerArm',
    H = side + 'Hand';
  const uArm = W(U),
    lArm = W(L),
    hand = W(H);
  const aDir = vnorm(vsub(lArm, uArm));
  // Thin navy shoulder strap over the top of the upper arm.
  tube('navy', U, uArm, vadd(uArm, vscale(aDir, 0.045)), 0.056, 0.052, 6, { capB: false });
  tube('skin', U, uArm, lArm, 0.048, 0.044, 6); // bare upper arm
  tube('navy', L, lArm, hand, 0.05, 0.044, 6); // detached forearm sleeve
  tube('hair', L, vadd(hand, vscale(aDir, -0.03)), vadd(hand, vscale(aDir, 0.02)), 0.05, 0.048, 6, {
    capA: false,
    capB: false,
  }); // teal wrist cuff
  const out = side === 'left' ? -0.05 : 0.05;
  tube('skin', H, hand, vadd(hand, [out, 0, 0]), 0.045, 0.038, 6); // hand
}

// Legs: bare upper thigh (skin), thigh-high navy boots with a teal top band, and
// a blocky boot foot with a forward toe. Rounded 6-gon thigh/shin.
for (const side of ['left', 'right']) {
  const U = side + 'UpperLeg',
    L = side + 'LowerLeg',
    F = side + 'Foot';
  const hip = W(U),
    knee = W(L),
    foot = W(F);
  const bootTop = lerp(hip, knee, 0.42); // thigh-high: boot starts mid-thigh
  tube('skin', U, hip, bootTop, 0.078, 0.068, 6); // bare upper thigh
  tube('hair', U, bootTop, lerp(hip, knee, 0.55), 0.072, 0.072, 6, { capA: false, capB: false }); // teal band
  tube('boot', U, lerp(hip, knee, 0.55), knee, 0.07, 0.068, 6, { capA: false }); // boot (thigh part)
  tube('boot', L, knee, foot, 0.068, 0.06, 6); // boot (shin)
  addBox('boot', F, foot[0], foot[1] - 0.05, -0.06, 0.07, 0.04, 0.12); // boot foot + toe
  addBox('boot', F, foot[0], foot[1] - 0.085, 0.03, 0.06, 0.025, 0.045); // raised heel
}

// ---------------------------------------------------------------------------
// Face texture: a small painted anime face (skin bg, big teal eyes, mouth).
function makeFaceTexture(size = 96) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };
  const disc = (cx, cy, rx, ry, cb) => {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const dx = (x - cx) / rx,
          dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) cb(x, y);
      }
  };
  // Skin background.
  const s = [Math.round(SKIN[0] * 255), Math.round(SKIN[1] * 255), Math.round(SKIN[2] * 255)];
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = s[0];
    px[i * 4 + 1] = s[1];
    px[i * 4 + 2] = s[2];
    px[i * 4 + 3] = 255;
  }
  const teal = [Math.round(TEAL[0] * 255), Math.round(TEAL[1] * 255), Math.round(TEAL[2] * 255)];
  const tealDk = [30, 120, 116];
  // Teal fringe / bangs across the top, with triangular notches (little V dips)
  // so the hairline isn't a flat bar — covers the upper forehead.
  for (let x = 0; x < size; x++) {
    const tri = Math.abs((((x / size) * 3.5) % 1) - 0.5) * 2; // 0..1 sawtooth
    const edge = (0.12 + 0.13 * tri) * size;
    for (let y = 0; y < edge; y++) set(x, y, teal[0], teal[1], teal[2]);
  }
  // Blush.
  for (const ex of [0.22, 0.78])
    disc(ex * size, 0.66 * size, 0.1 * size, 0.055 * size, (x, y) => set(x, y, 255, 178, 180));
  // Eyes: white-of-eye, teal iris, dark outline, highlight.
  for (const ex of [0.32, 0.68]) {
    disc(ex * size, 0.5 * size, 0.15 * size, 0.2 * size, (x, y) => set(x, y, 20, 24, 34)); // outline
    disc(ex * size, 0.51 * size, 0.12 * size, 0.17 * size, (x, y) => set(x, y, 245, 250, 252)); // white
    disc(ex * size, 0.54 * size, 0.1 * size, 0.14 * size, (x, y) =>
      set(x, y, Math.round(TEAL[0] * 255), Math.round(TEAL[1] * 255), Math.round(TEAL[2] * 255)),
    ); // iris
    disc(ex * size, 0.6 * size, 0.06 * size, 0.08 * size, (x, y) => set(x, y, 12, 30, 40)); // pupil
    disc((ex + 0.03) * size, 0.44 * size, 0.03 * size, 0.04 * size, (x, y) =>
      set(x, y, 255, 255, 255),
    ); // highlight
  }
  // Brows: thin teal, tucked just under the fringe.
  for (const ex of [0.32, 0.68])
    disc(ex * size, 0.34 * size, 0.1 * size, 0.014 * size, (x, y) =>
      set(x, y, tealDk[0], tealDk[1], tealDk[2]),
    );
  // Mouth: a small flat line (not a dot).
  disc(0.5 * size, 0.8 * size, 0.07 * size, 0.014 * size, (x, y) => set(x, y, 168, 72, 84));
  return { px, size };
}

// Encode RGBA → PNG (zlib deflate).
function encodePNG(px, w, h) {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const cd = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(cd), 0);
    return Buffer.concat([len, cd, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // filter byte 0 per row
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(px.buffer, px.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Assemble the GLB.
const bin = [];
let binLen = 0;
function addView(buf, align = 4) {
  while (binLen % align !== 0) {
    bin.push(Buffer.alloc(align - (binLen % align)));
    binLen += align - (binLen % align);
  }
  const off = binLen;
  bin.push(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
  binLen += buf.byteLength;
  return { off, len: buf.byteLength };
}

const bufferViews = [];
const accessors = [];
function accessor(arr, type, comp, extra = {}) {
  let typedBuf, ctype;
  if (comp === 'f32') {
    typedBuf = new Float32Array(arr);
    ctype = 5126;
  } else if (comp === 'u16') {
    typedBuf = new Uint16Array(arr);
    ctype = 5123;
  } else throw new Error('comp');
  const v = addView(typedBuf);
  bufferViews.push({ buffer: 0, byteOffset: v.off, byteLength: v.len });
  const count = arr.length / { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
  const a = { bufferView: bufferViews.length - 1, componentType: ctype, count, type, ...extra };
  accessors.push(a);
  return accessors.length - 1;
}

// Inverse-bind matrices: T-pose is pure translation, so inverseBind = translate(-worldPos).
const ibm = [];
for (const name of BONE_NAMES) {
  const p = W(name);
  // column-major 4x4, translation in last column
  ibm.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1);
}
const ibmAcc = accessor(ibm, 'MAT4', 'f32');

// Primitives (one per non-empty material group).
const primitives = [];
groups.forEach((g, mat) => {
  if (g.idx.length === 0) return;
  const pos = accessor(g.pos, 'VEC3', 'f32', {
    min: [
      Math.min(...everyN(g.pos, 3, 0)),
      Math.min(...everyN(g.pos, 3, 1)),
      Math.min(...everyN(g.pos, 3, 2)),
    ],
    max: [
      Math.max(...everyN(g.pos, 3, 0)),
      Math.max(...everyN(g.pos, 3, 1)),
      Math.max(...everyN(g.pos, 3, 2)),
    ],
  });
  const nrm = accessor(g.nrm, 'VEC3', 'f32');
  const uv = accessor(g.uv, 'VEC2', 'f32');
  const joints4 = [];
  const weights4 = [];
  for (const j of g.joint) {
    joints4.push(j, 0, 0, 0);
    weights4.push(1, 0, 0, 0);
  }
  const ja = accessor(joints4, 'VEC4', 'u16');
  const wa = accessor(weights4, 'VEC4', 'f32');
  const ia = accessor(g.idx, 'SCALAR', 'u16');
  primitives.push({
    attributes: { POSITION: pos, NORMAL: nrm, TEXCOORD_0: uv, JOINTS_0: ja, WEIGHTS_0: wa },
    indices: ia,
    material: mat,
  });
});
function everyN(a, n, o) {
  const r = [];
  for (let i = o; i < a.length; i += n) r.push(a[i]);
  return r;
}

// Face texture PNG.
const ft = makeFaceTexture();
const png = encodePNG(ft.px, ft.size, ft.size);
const imgView = addView(png, 1);
bufferViews.push({ buffer: 0, byteOffset: imgView.off, byteLength: imgView.len });
const imgViewIdx = bufferViews.length - 1;

// Nodes: bones + one mesh node. The mesh node holds the skinned mesh.
const nodes = BONE_NAMES.map((name) => {
  const b = BONES[name];
  const node = { name, translation: b.t };
  return node;
});
// children
BONE_NAMES.forEach((name, i) => {
  const kids = BONE_NAMES.map((n, j) => (BONES[n].parent === name ? j : -1)).filter((j) => j >= 0);
  if (kids.length) nodes[i].children = kids;
});
const meshNodeIdx = nodes.length;
nodes.push({ name: 'PS1Miku', mesh: 0, skin: 0 });

const materials = MATS.map((m) => {
  const mat = {
    name: m.key,
    pbrMetallicRoughness: {
      baseColorFactor: [m.color[0], m.color[1], m.color[2], 1],
      metallicFactor: 0,
      roughnessFactor: 1,
    },
    doubleSided: true,
    alphaMode: 'OPAQUE',
  };
  if (m.tex) mat.pbrMetallicRoughness.baseColorTexture = { index: 0 };
  return mat;
});

const rootBoneIdx = jointIndex['hips'];
const gltf = {
  asset: { version: '2.0', generator: 'genPs1Miku' },
  scene: 0,
  scenes: [{ nodes: [rootBoneIdx, meshNodeIdx] }],
  nodes,
  meshes: [{ name: 'PS1Miku', primitives }],
  skins: [
    {
      joints: BONE_NAMES.map((n) => jointIndex[n]),
      inverseBindMatrices: ibmAcc,
      skeleton: rootBoneIdx,
    },
  ],
  materials,
  images: [{ mimeType: 'image/png', bufferView: imgViewIdx }],
  textures: [{ source: 0, sampler: 0 }],
  samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }], // NEAREST (PS1)
  buffers: [{ byteLength: binLen }],
  bufferViews,
  accessors,
  extensionsUsed: ['VRM'],
  extensions: {
    VRM: {
      specVersion: '0.0',
      meta: {
        title: 'PS1 Miku (original)',
        author: 'stepzone',
        licenseName: 'CC0',
        allowedUserName: 'Everyone',
      },
      humanoid: {
        humanBones: BONE_NAMES.map((n) => ({ bone: n, node: jointIndex[n] })),
      },
    },
  },
};

// Pack GLB.
const binBuf = Buffer.concat(bin);
let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
while (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')]);
let binPadded = binBuf;
while (binPadded.length % 4) binPadded = Buffer.concat([binPadded, Buffer.alloc(1)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binPadded.length, 8);
const jsonHdr = Buffer.alloc(8);
jsonHdr.writeUInt32LE(jsonBuf.length, 0);
jsonHdr.writeUInt32LE(0x4e4f534a, 4);
const binHdr = Buffer.alloc(8);
binHdr.writeUInt32LE(binPadded.length, 0);
binHdr.writeUInt32LE(0x004e4942, 4);
writeFileSync(OUT, Buffer.concat([header, jsonHdr, jsonBuf, binHdr, binPadded]));

let tris = 0;
for (const p of primitives) tris += accessors[p.indices].count / 3;
console.log(
  `wrote ${OUT} — ${(Buffer.concat([header, jsonHdr, jsonBuf, binHdr, binPadded]).length / 1024).toFixed(1)}KB, ${Math.round(tris)} tris, ${BONE_NAMES.length} bones, ${primitives.length} prims`,
);
