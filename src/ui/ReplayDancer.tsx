import { useEffect, useRef, useState, type CSSProperties } from 'react';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { IsaacVrmDancer, DEFAULT_VRM_URL } from '../render/isaacVrmDancer';
import {
  parseReplay,
  sampleReplay,
  makePose,
  replayDuration,
  exPercentAt,
  comboAt,
  JUDGMENT_COLOR,
  JUDGMENT_LABEL,
  type Replay,
  type Pose,
} from '../render/replay';

/**
 * ?replaydancer — a polished, video-ready replay renderer for recorded RL-dancer
 * rollouts (see docs/replay-format.md). The VRM anime avatar (reused verbatim via
 * IsaacVrmDancer, the same retarget driver ?isaacviewer uses) performs on a DDR
 * stage: four pad squares on the floor light up on note hits and under planted
 * feet, and a crisp scrolling arrow lane with receptor flashes + judgment popups
 * reads the chart. Load a replay by file-drop or ?replayUrl=.
 *
 * Presentation choice (pads-in-3D + lane-in-2D-HUD): the four pads live in the 3D
 * scene on the floor so the dancer's footwork reads spatially (which foot planted
 * where), while the *scrolling arrows* live in a clean 2D HUD strip — crisp
 * vector arrows and classic judgment lettering, without fighting the moving 3D
 * camera or a perspective-warped floor lane. Everything is composited onto ONE
 * canvas (3D blitted, HUD drawn on top) so canvas.captureStream(fps) records it
 * whole (scripts/renderReplay.mjs).
 *
 * Playback interpolates poses (positions lerp, quaternions SLERP) so 30Hz OR 60Hz
 * replays render smooth at any output rate; rate!=1 and a 120fps capture over-crank
 * stay crisp.
 */

// ── Pad + lane constants ─────────────────────────────────────────────────────
// Pad centers in Isaac env-local ground coords (x forward, y left). 0=L,1=R,2=U,3=D.
const PAD_LOCAL: ReadonlyArray<readonly [number, number]> = [
  [0, 0.3],
  [0, -0.3],
  [0.3, 0],
  [-0.3, 0],
];
// Per-pad accent color + up-arrow rotation (canvas cw radians; up-arrow base).
const PAD_COLOR = ['#ff4f6d', '#ffd24d', '#5be36b', '#4db8ff']; // L,R,U,D
const PAD_ROT = [-Math.PI / 2, Math.PI / 2, 0, Math.PI]; // L,R,U,D
// Lane column order left→right (DDR visual): L, D, U, R → pad indices.
const LANE_COLS = [0, 3, 2, 1] as const;

const FLASH_S = 0.28; // pad + receptor flash lifetime
const POPUP_S = 0.5; // judgment popup lifetime
const LOOKAHEAD_S = 1.7; // how far ahead notes enter the lane
const FOOT_PLANT_H = 0.09; // source foot height (m) at/under which a foot is planted

const B_R_FOOT = 11;
const B_L_FOOT = 14;

interface CaptureParams {
  on: boolean;
  fps: number;
  rate: number;
}
function readCapture(): CaptureParams {
  const p = new URLSearchParams(location.search);
  const on = p.has('capture');
  const fps = Math.max(1, Math.min(120, parseInt(p.get('capfps') || '', 10) || 60));
  const rate = Math.max(0.05, Math.min(4, parseFloat(p.get('caprate') || '') || 1));
  return { on, fps, rate };
}

/** Trace an up-pointing DDR arrow of radius `s` centered at origin (pre-rotation). */
function arrowPath(ctx: CanvasRenderingContext2D, s: number): void {
  const w = s * 0.5; // half-width of the stem
  ctx.beginPath();
  ctx.moveTo(0, -s); // tip
  ctx.lineTo(-s, 0.05 * s); // left shoulder
  ctx.lineTo(-w, 0.05 * s);
  ctx.lineTo(-w, s * 0.8); // left tail
  ctx.lineTo(w, s * 0.8); // right tail
  ctx.lineTo(w, 0.05 * s);
  ctx.lineTo(s, 0.05 * s); // right shoulder
  ctx.closePath();
}

/** Build a 128px arrow glyph texture for a pad (used on the floor pad tops). */
function padArrowTexture(dir: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.translate(64, 64);
  ctx.rotate(PAD_ROT[dir]);
  arrowPath(ctx, 44);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function ReplayDancer({ onExit }: { onExit: () => void }) {
  const threeCanvasRef = useRef<HTMLCanvasElement>(null);
  const compositeRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [replay, setReplay] = useState<Replay | null>(null);
  const [loadMsg, setLoadMsg] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Playback state mirrored to React ~10Hz for the controls; the render loop
  // reads/writes the refs so seeks + rate changes are frame-immediate.
  const playingRef = useRef(true);
  const rateRef = useRef(1);
  const tRef = useRef(0);
  const [ui, setUi] = useState({ playing: true, t: 0, rate: 1, dur: 0 });

  const capture = readCapture();

  // ── Load: ?replayUrl= (fetch) ───────────────────────────────────────────────
  useEffect(() => {
    const url = new URLSearchParams(location.search).get('replayUrl');
    if (!url) return;
    let cancelled = false;
    setLoadMsg(`loading ${url}…`);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (cancelled) return;
        const rep = parseReplay(j);
        setReplay(rep);
        setLoadMsg('');
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(`failed to load replay: ${e instanceof Error ? e.message : String(e)}`);
        setLoadMsg('');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadFile = (file: File) => {
    setErr(null);
    setLoadMsg(`reading ${file.name}…`);
    file
      .text()
      .then((txt) => {
        const rep = parseReplay(JSON.parse(txt));
        setReplay(rep);
        setLoadMsg('');
        tRef.current = 0;
        playingRef.current = true;
      })
      .catch((e) => {
        setErr(`bad replay file: ${e instanceof Error ? e.message : String(e)}`);
        setLoadMsg('');
      });
  };

  // ── Scene + render loop (rebuilt whenever a replay loads) ────────────────────
  useEffect(() => {
    const threeCanvas = threeCanvasRef.current;
    const composite = compositeRef.current;
    if (!threeCanvas || !composite || !replay) return;
    const ctx = composite.getContext('2d')!;

    let disposed = false;
    let raf = 0;
    let controls: OrbitControls | null = null;
    const dur = replayDuration(replay);
    tRef.current = Math.min(tRef.current, dur);

    // Sizing: fixed capture resolution, or window*dpr for the live page.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const dims = () => {
      if (capture.on) {
        const p = new URLSearchParams(location.search);
        return {
          w: parseInt(p.get('capw') || '', 10) || 1920,
          h: parseInt(p.get('caph') || '', 10) || 1080,
        };
      }
      return { w: Math.round(window.innerWidth * dpr), h: Math.round(window.innerHeight * dpr) };
    };
    let { w: W, h: H } = dims();

    // three.js renderer (WebGPU, falls back to WebGL2 in headless capture).
    const renderer = new THREE.WebGPURenderer({ canvas: threeCanvas, antialias: true });
    renderer.setPixelRatio(1); // we manage device pixels ourselves
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c16);
    scene.fog = new THREE.Fog(0x0a0c16, 6, 20);

    const camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 60);
    camera.position.set(0, 1.35, 3.2);

    // Lighting: hemi fill + warm key (shadow caster) + cool back rim.
    scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x181c2e, 1.5));
    const key = new THREE.DirectionalLight(0xfff2dd, 2.6);
    key.position.set(3.5, 6, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 20;
    key.shadow.camera.left = -3;
    key.shadow.camera.right = 3;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -1;
    key.shadow.bias = -0.0008;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb4ff, 1.4);
    rim.position.set(-4, 3, -5);
    scene.add(rim);
    const fillPink = new THREE.PointLight(0xff5f8f, 8, 12, 2);
    fillPink.position.set(-2.5, 1.2, 1.5);
    scene.add(fillPink);

    // Floor: dark reflective-ish slab (receives shadow) + subtle grid.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardNodeMaterial({ color: 0x0c1020, roughness: 0.55, metalness: 0.35 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(30, 30, 0x2a3468, 0x161c34);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    grid.position.y = 0.001;
    scene.add(grid);

    // DDR pads: four glowing squares with a direction arrow decal, flat on the floor.
    const padArrowTex = [0, 1, 2, 3].map(padArrowTexture);
    const padGeo = new THREE.PlaneGeometry(0.26, 0.26);
    const padBaseMats: THREE.MeshStandardNodeMaterial[] = [];
    const padGlowMats: THREE.MeshBasicNodeMaterial[] = [];
    for (let p = 0; p < 4; p++) {
      const col = new THREE.Color(PAD_COLOR[p]);
      const base = new THREE.MeshStandardNodeMaterial({
        color: col.clone().multiplyScalar(0.28),
        roughness: 0.5,
        metalness: 0.2,
        emissive: col.clone().multiplyScalar(0.12),
      });
      const quad = new THREE.Mesh(padGeo, base);
      quad.rotation.x = -Math.PI / 2;
      const [lx, ly] = PAD_LOCAL[p];
      quad.position.set(lx, 0.012, -ly);
      scene.add(quad);
      padBaseMats.push(base);
      // arrow decal on top (brightens with flash via material color)
      const glow = new THREE.MeshBasicNodeMaterial({
        map: padArrowTex[p],
        transparent: true,
        opacity: 0.5,
        color: col.clone().multiplyScalar(0.7),
        depthWrite: false,
      });
      const deco = new THREE.Mesh(padGeo, glow);
      deco.rotation.x = -Math.PI / 2;
      deco.position.set(lx, 0.02, -ly);
      scene.add(deco);
      padGlowMats.push(glow);
    }

    // The reused VRM dancer (graceful capsule-less fallback: nothing if it fails).
    const vrmUrl = new URLSearchParams(location.search).get('vrmurl') || DEFAULT_VRM_URL;
    const dancer = new IsaacVrmDancer(scene, vrmUrl);
    void dancer.load().then(() => {
      if (disposed || !dancer.vrm) return;
      dancer.vrm.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = false;
        }
      });
    });

    // ── Pose sampling scratch ──────────────────────────────────────────────────
    const pose: Pose = makePose(replay);
    const notes = replay.chart.notes;

    // ── 2D HUD (drawn onto the composite after the 3D blit) ─────────────────────
    const FONT = "'Chakra Petch', ui-monospace, sans-serif";
    const draw2D = (t: number) => {
      const scale = H / 1080; // author the HUD at 1080p, scale to the real size
      const px = (v: number) => v * scale;
      // Lane geometry: 4 columns centered horizontally near the top.
      const colGap = px(112);
      const laneW = colGap * 3;
      const cx0 = W / 2 - laneW / 2;
      const receptorY = px(120);
      const laneBottom = H * 0.82;
      const speed = (laneBottom - receptorY) / LOOKAHEAD_S;
      const aSize = px(38);

      // Column backdrop strip
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#080a14';
      roundRect(
        ctx,
        cx0 - colGap * 0.55,
        px(24),
        laneW + colGap * 1.1,
        laneBottom - px(12),
        px(16),
      );
      ctx.fill();
      ctx.restore();

      // Receptors + flashes
      for (let i = 0; i < 4; i++) {
        const pad = LANE_COLS[i];
        const x = cx0 + i * colGap;
        // flash intensity from the nearest recent note on this pad
        let flash = 0;
        for (const n of notes) {
          if (n.pad !== pad) continue;
          const age = t - n.t;
          if (age >= 0 && age <= FLASH_S) flash = Math.max(flash, 1 - age / FLASH_S);
        }
        ctx.save();
        ctx.translate(x, receptorY);
        ctx.rotate(PAD_ROT[pad]);
        // dim receptor ring
        arrowPath(ctx, aSize);
        ctx.lineWidth = px(3);
        ctx.strokeStyle = `rgba(150,165,210,${0.5 + 0.5 * flash})`;
        ctx.stroke();
        if (flash > 0) {
          ctx.globalAlpha = flash;
          ctx.fillStyle = PAD_COLOR[pad];
          ctx.shadowColor = PAD_COLOR[pad];
          ctx.shadowBlur = px(24) * flash;
          ctx.fill();
        }
        ctx.restore();
      }

      // Scrolling notes (draw far→near so nearer notes sit on top)
      for (let k = notes.length - 1; k >= 0; k--) {
        const n = notes[k];
        const dt = n.t - t;
        if (dt > LOOKAHEAD_S || dt < -FLASH_S) continue; // off-lane / already hit+flashed
        const col = LANE_COLS.indexOf(n.pad as (typeof LANE_COLS)[number]);
        if (col < 0) continue;
        const x = cx0 + col * colGap;
        const y = receptorY + dt * speed;
        let alpha = 1;
        if (dt < 0)
          alpha = Math.max(0, 1 + dt / FLASH_S); // fade as it passes the receptor
        else if (dt > LOOKAHEAD_S - 0.25) alpha = (LOOKAHEAD_S - dt) / 0.25; // fade in
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(x, y);
        ctx.rotate(PAD_ROT[n.pad]);
        arrowPath(ctx, aSize);
        ctx.fillStyle = PAD_COLOR[n.pad];
        ctx.shadowColor = PAD_COLOR[n.pad];
        ctx.shadowBlur = px(10);
        ctx.fill();
        ctx.lineWidth = px(2);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.stroke();
        ctx.restore();
      }

      // Judgment popups (stateless: any note with 0 <= t-n.t <= POPUP_S)
      for (const n of notes) {
        const age = t - n.t;
        if (age < 0 || age > POPUP_S) continue;
        const f = age / POPUP_S;
        const pop = age < 0.06 ? age / 0.06 : 1; // quick squash-in
        const rise = px(28) * f;
        const alpha = f < 0.7 ? 1 : (1 - f) / 0.3;
        const col = LANE_COLS.indexOf(n.pad as (typeof LANE_COLS)[number]);
        const x = col >= 0 ? cx0 + col * colGap : W / 2;
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.translate(x, receptorY + px(70) - rise);
        ctx.scale(0.7 + 0.3 * pop, 0.7 + 0.3 * pop);
        ctx.font = `800 ${px(22)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = px(4);
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(JUDGMENT_LABEL[n.judgment], 0, 0);
        ctx.fillStyle = JUDGMENT_COLOR[n.judgment];
        ctx.shadowColor = JUDGMENT_COLOR[n.judgment];
        ctx.shadowBlur = px(16);
        ctx.fillText(JUDGMENT_LABEL[n.judgment], 0, 0);
        ctx.restore();
      }

      // ── Text HUD ────────────────────────────────────────────────────────────
      const exPct = exPercentAt(notes, t);
      const combo = comboAt(notes, t);

      // Chart name (top-left)
      ctx.save();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = `700 ${px(26)}px ${FONT}`;
      ctx.fillStyle = '#eef2ff';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = px(6);
      ctx.fillText(replay.chart.name, px(28), px(26));
      ctx.font = `500 ${px(15)}px ${FONT}`;
      ctx.fillStyle = '#8f9ac7';
      const metaLine = [
        replay.meta.checkpoint ? String(replay.meta.checkpoint) : null,
        replay.meta.survived === false ? 'DIED' : replay.meta.survived === true ? 'SURVIVED' : null,
      ]
        .filter(Boolean)
        .join('  ·  ');
      if (metaLine) ctx.fillText(metaLine, px(28), px(60));
      ctx.restore();

      // EX % (top-right)
      ctx.save();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.font = `800 ${px(40)}px ${FONT}`;
      ctx.fillStyle = '#ffe27a';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = px(6);
      ctx.fillText(`${exPct.toFixed(2)}%`, W - px(28), px(24));
      ctx.font = `600 ${px(14)}px ${FONT}`;
      ctx.fillStyle = '#8f9ac7';
      ctx.fillText('EX SCORE', W - px(28), px(72));
      ctx.restore();

      // Combo (center, under the lane)
      if (combo > 1) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `800 ${px(64)}px ${FONT}`;
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'rgba(120,180,255,0.9)';
        ctx.shadowBlur = px(18);
        ctx.fillText(String(combo), W / 2, laneBottom + px(48));
        ctx.font = `700 ${px(18)}px ${FONT}`;
        ctx.fillStyle = '#9fb4ff';
        ctx.shadowBlur = 0;
        ctx.fillText('COMBO', W / 2, laneBottom + px(92));
        ctx.restore();
      }

      // Time / rate (bottom-center)
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.font = `600 ${px(16)}px ${FONT}`;
      ctx.fillStyle = '#aab3d6';
      const rateStr =
        Math.abs(rateRef.current - 1) < 1e-3 ? '' : `   ${rateRef.current.toFixed(2)}×`;
      ctx.fillText(`${t.toFixed(1)} / ${dur.toFixed(1)} s${rateStr}`, W / 2, H - px(18));
      ctx.restore();
    };

    // ── Pad flashes + planted-foot glow in 3D ──────────────────────────────────
    const padCol = new THREE.Color();
    const updatePads3D = (t: number) => {
      // planted-foot proximity: which pads a low foot is near
      const rfx = pose.pos[B_R_FOOT * 3],
        rfy = pose.pos[B_R_FOOT * 3 + 1],
        rfz = pose.pos[B_R_FOOT * 3 + 2];
      const lfx = pose.pos[B_L_FOOT * 3],
        lfy = pose.pos[B_L_FOOT * 3 + 1],
        lfz = pose.pos[B_L_FOOT * 3 + 2];
      for (let p = 0; p < 4; p++) {
        let flash = 0;
        for (const n of notes) {
          if (n.pad !== p) continue;
          const age = t - n.t;
          if (age >= 0 && age <= FLASH_S) flash = Math.max(flash, 1 - age / FLASH_S);
        }
        // planted glow: a low foot within ~0.2m of the pad center
        const [lx, ly] = PAD_LOCAL[p];
        let plant = 0;
        if (rfz < FOOT_PLANT_H) plant = Math.max(plant, near(rfx, rfy, lx, ly));
        if (lfz < FOOT_PLANT_H) plant = Math.max(plant, near(lfx, lfy, lx, ly));
        const lvl = Math.max(flash, plant * 0.5);
        const base = new THREE.Color(PAD_COLOR[p]);
        padCol.copy(base).multiplyScalar(0.28 + 1.1 * lvl);
        (padBaseMats[p].color as THREE.Color).copy(padCol);
        (padBaseMats[p].emissive as THREE.Color)
          .copy(base)
          .multiplyScalar(0.12 + 1.4 * flash + 0.35 * plant);
        padGlowMats[p].opacity = 0.5 + 0.5 * lvl;
        (padGlowMats[p].color as THREE.Color).copy(base).multiplyScalar(0.7 + 1.6 * lvl);
      }
    };

    // ── Camera: gentle video-friendly framing (deterministic in `t`) ────────────
    const applyCamera = (t: number) => {
      if (controls) return; // OrbitControls owns the camera on the live page
      const az = Math.sin(t * 0.16) * 0.42; // slow ±24° oscillation
      const r = 3.15;
      camera.position.set(Math.sin(az) * r, 1.32 + 0.06 * Math.sin(t * 0.11), Math.cos(az) * r);
      camera.lookAt(0, 1.02, 0);
    };

    // ── One rendered frame at content time `t` with sim step `dt` ───────────────
    const renderAt = async (t: number, dt: number) => {
      sampleReplay(replay, t, pose);
      if (dancer.ready) dancer.update(pose.pos, 0, 0, 0, Math.max(1e-3, dt), pose.quatXYZW);
      updatePads3D(t);
      applyCamera(t);
      controls?.update();
      await renderer.renderAsync(scene, camera);
      // composite: blit the 3D frame, then draw the HUD on top
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(threeCanvas, 0, 0, W, H);
      draw2D(t);
    };

    const resize = () => {
      if (capture.on) return; // fixed capture size
      const d = dims();
      W = d.w;
      H = d.h;
      threeCanvas.width = W;
      threeCanvas.height = H;
      composite.width = W;
      composite.height = H;
      renderer.setSize(W, H, false);
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
    };

    // init sizes
    threeCanvas.width = composite.width = W;
    threeCanvas.height = composite.height = H;
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();

    let lastWall = performance.now();
    void renderer.init().then(async () => {
      if (disposed) return;
      if (!capture.on) {
        window.addEventListener('resize', resize);
        controls = new OrbitControls(camera, composite);
        controls.enableDamping = true;
        controls.target.set(0, 1.02, 0);
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.6;
        controls.minDistance = 1.8;
        controls.maxDistance = 6;
        controls.maxPolarAngle = Math.PI * 0.52;
        controls.update();
      }

      if (capture.on) {
        await runCapture();
        return;
      }

      // Live loop: wall-clock paced, advances `t` by rate while playing; loops.
      const loop = async () => {
        if (disposed) return;
        const now = performance.now();
        const wdt = Math.min(0.1, (now - lastWall) / 1000);
        lastWall = now;
        if (playingRef.current) {
          tRef.current += wdt * rateRef.current;
          if (tRef.current >= dur) tRef.current = 0; // loop for showcase
          if (tRef.current < 0) tRef.current = dur;
        }
        await renderAt(tRef.current, wdt * rateRef.current);
        raf = requestAnimationFrame(() => void loop());
      };
      raf = requestAnimationFrame(() => void loop());
    });

    // ── Capture: MediaRecorder on the composite, real-time-paced, exact frames ──
    async function runCapture() {
      const cap = readCapture();
      const stream = composite!.captureStream(cap.fps);
      const mime = pickMime();
      const bitsPerSecond = Math.round(((W * H) / (1920 * 1080)) * 24_000_000); // ~24Mbps @1080p
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitsPerSecond });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      const done = new Promise<void>((resolve) => {
        rec.onstop = () => {
          const blob = new Blob(chunks, { type: mime });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'replay.webm';
          document.body.appendChild(a);
          a.click();
          (window as unknown as { __captureBytes?: number }).__captureBytes = blob.size;
          (window as unknown as { __captureDone?: boolean }).__captureDone = true;
          resolve();
        };
      });

      const interval = 1000 / cap.fps;
      const dtContent = (interval / 1000) * cap.rate;
      const total = Math.max(1, Math.ceil((dur / cap.rate) * cap.fps));
      (window as unknown as { __captureTotal?: number }).__captureTotal = total;
      rec.start();
      const startWall = performance.now();
      for (let i = 0; i <= total && !disposed; i++) {
        const t = Math.min(dur, (i / cap.fps) * cap.rate);
        await renderAt(t, dtContent);
        (window as unknown as { __captureProgress?: number }).__captureProgress = i / total;
        const targetWall = startWall + (i + 1) * interval;
        const delay = Math.max(0, targetWall - performance.now());
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
      rec.stop();
      await done;
    }

    // signal readiness once the dancer has attempted to load (ready or failed)
    const readyPoll = window.setInterval(() => {
      if (dancer.ready || dancer.failed) {
        (window as unknown as { __replayReady?: boolean }).__replayReady = true;
        window.clearInterval(readyPoll);
      }
    }, 100);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearInterval(readyPoll);
      window.removeEventListener('resize', resize);
      controls?.dispose();
      dancer.dispose();
      padGeo.dispose();
      for (const t of padArrowTex) t.dispose();
      for (const m of padBaseMats) m.dispose();
      for (const m of padGlowMats) m.dispose();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay]);

  // Mirror playback refs to React ~10Hz for the slider/buttons.
  useEffect(() => {
    const id = window.setInterval(() => {
      setUi((u) => {
        const dur = replay ? replayDuration(replay) : 0;
        if (
          u.t === tRef.current &&
          u.playing === playingRef.current &&
          u.rate === rateRef.current &&
          u.dur === dur
        )
          return u;
        return { t: tRef.current, playing: playingRef.current, rate: rateRef.current, dur };
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [replay]);

  // Keyboard: space=play/pause, arrows=seek, Esc=exit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
      else if (e.key === ' ') {
        e.preventDefault();
        playingRef.current = !playingRef.current;
      } else if (e.key === 'ArrowLeft') tRef.current = Math.max(0, tRef.current - 1);
      else if (e.key === 'ArrowRight') tRef.current = tRef.current + 1;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  const captureMode = capture.on;
  const panel: CSSProperties = {
    position: 'absolute',
    bottom: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 16px',
    borderRadius: 12,
    background: 'rgba(10,12,22,0.82)',
    border: '1px solid #232a48',
    color: '#cdd6f4',
    font: "13px/1.4 'Chakra Petch', ui-monospace, sans-serif",
    zIndex: 10,
  };

  return (
    <div
      ref={containerRef}
      style={{ position: 'fixed', inset: 0, background: '#0a0c16', overflow: 'hidden' }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) loadFile(f);
      }}
    >
      {/* The 3D canvas is rendered off-screen-ish behind the composite; the
          composite (what captureStream records) blits it + draws the HUD. */}
      <canvas
        ref={threeCanvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0 }}
      />
      <canvas
        ref={compositeRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />

      {!captureMode && (
        <>
          {/* Drop / load prompt when no replay yet */}
          {!replay && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 14,
                color: '#cdd6f4',
                font: "15px/1.6 'Chakra Petch', ui-monospace, sans-serif",
                textAlign: 'center',
                pointerEvents: 'none',
              }}
            >
              <div style={{ fontSize: 28, fontWeight: 800, color: '#eef2ff' }}>REPLAY DANCER</div>
              <div style={{ opacity: 0.8 }}>
                {loadMsg || 'drop a replay .json here, or open ?replayUrl=…'}
              </div>
              {err && <div style={{ color: '#ff6b7f', maxWidth: 520 }}>{err}</div>}
              <label
                style={{
                  pointerEvents: 'auto',
                  cursor: 'pointer',
                  marginTop: 8,
                  padding: '8px 18px',
                  borderRadius: 8,
                  border: '1px solid #3a4270',
                  background: 'rgba(35,40,66,0.7)',
                }}
              >
                choose file…
                <input
                  type="file"
                  accept="application/json,.json"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) loadFile(f);
                  }}
                />
              </label>
            </div>
          )}

          {dragOver && (
            <div
              style={{
                position: 'absolute',
                inset: 16,
                border: '2px dashed #6f8fff',
                borderRadius: 16,
                pointerEvents: 'none',
              }}
            />
          )}

          {/* Playback controls */}
          {replay && (
            <div style={panel}>
              <button onClick={() => (playingRef.current = !playingRef.current)} style={btn}>
                {ui.playing ? '❚❚' : '►'}
              </button>
              <input
                type="range"
                min={0}
                max={Math.max(0.001, ui.dur)}
                step={0.01}
                value={ui.t}
                onChange={(e) => {
                  tRef.current = parseFloat(e.target.value);
                }}
                style={{ width: 320 }}
              />
              <span style={{ minWidth: 96, textAlign: 'center', opacity: 0.85 }}>
                {ui.t.toFixed(1)} / {ui.dur.toFixed(1)}s
              </span>
              <span style={{ display: 'flex', gap: 4 }}>
                {[0.25, 0.5, 1, 1.5, 2].map((r) => (
                  <button
                    key={r}
                    onClick={() => (rateRef.current = r)}
                    style={{
                      ...btn,
                      background: Math.abs(ui.rate - r) < 1e-3 ? '#2b3a7a' : 'rgba(35,40,66,0.7)',
                    }}
                  >
                    {r}×
                  </button>
                ))}
              </span>
              <button onClick={onExit} style={btn} title="exit (Esc)">
                ✕
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const btn: CSSProperties = {
  font: "13px/1 'Chakra Petch', ui-monospace, sans-serif",
  cursor: 'pointer',
  padding: '6px 12px',
  borderRadius: 7,
  border: '1px solid #3a4270',
  background: 'rgba(35,40,66,0.7)',
  color: '#cdd6f4',
};

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Proximity 0..1 of a foot at Isaac (fx,fy) to a pad center (px,py). */
function near(fx: number, fy: number, px: number, py: number): number {
  const d = Math.hypot(fx - px, fy - py);
  return Math.max(0, 1 - d / 0.22);
}

/** Pick the best supported webm codec for MediaRecorder. */
function pickMime(): string {
  const cands = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const c of cands) if (MediaRecorder.isTypeSupported(c)) return c;
  return 'video/webm';
}
