import { type CSSProperties, type ChangeEvent, useEffect, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { IsaacVrmDancer, DEFAULT_VRM_URL } from '../render/isaacVrmDancer';
import { BONES_21 } from '../render/isaacSkeleton';

/**
 * ?retargetdebug — verify the Miku clip retarget. Plays a retargeted clip
 * (rich_skeleton/export_clips_web.py -> public/debug/clips/*.bin) two ways at once:
 *   - the raw 21-body SKELETON (ball-and-stick) at the clip's body positions, and
 *   - the Miku VRM driven from the same pose by IsaacVrmDancer.
 * If the re-rooted rig is truly 1:1 the VRM bones sit on the skeleton with grounding OFF.
 * Controls: clip picker, play/scrub/speed, and VRM / skeleton / grounding toggles.
 */

const NB = 21;
const P_STRIDE = NB * 3; // floats per frame, positions
const Q_STRIDE = NB * 4; // floats per frame, quats

interface ClipMeta {
  name: string;
  frames: number;
  fps: number;
}
interface ClipData {
  frames: number;
  fps: number;
  pos: Float32Array; // frames * 21 * 3, Isaac Z-up
  quat: Float32Array; // frames * 21 * 4, wxyz
}

// Parse the MKC1 binary written by export_clips_web.py.
function parseClip(buf: ArrayBuffer): ClipData {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'MKC1') throw new Error(`bad clip magic ${magic}`);
  const frames = dv.getInt32(4, true);
  const nbodies = dv.getInt32(8, true);
  const fps = dv.getFloat32(12, true);
  if (nbodies !== NB) throw new Error(`expected ${NB} bodies, got ${nbodies}`);
  const HEADER = 16;
  const posCount = frames * P_STRIDE;
  const quatCount = frames * Q_STRIDE;
  const pos = new Float32Array(buf, HEADER, posCount);
  const quat = new Float32Array(buf, HEADER + posCount * 4, quatCount);
  // The .bin stores quats WXYZ (MuJoCo/Isaac order); IsaacVrmDancer.update expects XYZW
  // (same reorder ReplayDancer does on its WXYZ files). Without this the VRM gets
  // mislabelled quaternion components -> arms mirrored and facing that drifts as the body turns.
  for (let i = 0; i < quatCount; i += 4) {
    const w = quat[i];
    quat[i] = quat[i + 1]; // x
    quat[i + 1] = quat[i + 2]; // y
    quat[i + 2] = quat[i + 3]; // z
    quat[i + 3] = w; // w
  }
  return { frames, fps, pos, quat };
}

// Isaac world (x, y, z-up) -> three (x, z, -y). Matches isaacVrmDancer.isaacToThree.
const tx = (fp: Float32Array, j: number) => fp[j * 3];
const ty = (fp: Float32Array, j: number) => fp[j * 3 + 2];
const tz = (fp: Float32Array, j: number) => -fp[j * 3 + 1];

export function RetargetDebug({ onExit }: { onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrubRef = useRef<HTMLInputElement | null>(null);
  const frameLabelRef = useRef<HTMLSpanElement | null>(null);

  const [clips, setClips] = useState<ClipMeta[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [showVrm, setShowVrm] = useState(true);
  const [showSkel, setShowSkel] = useState(true);
  const [grounding, setGrounding] = useState(false); // OFF = raw 1:1 (the point of the re-root)
  const [exact, setExact] = useState(true); // exact-quat drive (poseExact) vs legacy aim+twist
  const [status, setStatus] = useState('loading clips…');

  // Mutable state the RAF loop reads without re-subscribing the effect.
  const S = useRef({
    clip: null as ClipData | null,
    playhead: 0, // float frame index
    playing: true,
    speed: 1,
    showVrm: true,
    showSkel: true,
    grounding: false,
    exact: true,
    scrubbing: false,
  });
  useEffect(() => void (S.current.playing = playing), [playing]);
  useEffect(() => void (S.current.speed = speed), [speed]);
  useEffect(() => void (S.current.showVrm = showVrm), [showVrm]);
  useEffect(() => void (S.current.showSkel = showSkel), [showSkel]);
  useEffect(() => void (S.current.grounding = grounding), [grounding]);
  useEffect(() => void (S.current.exact = exact), [exact]);

  // Load the clip manifest once.
  useEffect(() => {
    let alive = true;
    fetch('/debug/clips/manifest.json')
      .then((r) => r.json())
      .then((m: { clips: ClipMeta[] }) => {
        if (!alive) return;
        setClips(m.clips);
        if (m.clips.length) setSelected(m.clips[0].name);
        setStatus(`${m.clips.length} clips`);
      })
      .catch((e) => alive && setStatus(`manifest error: ${e}`));
    return () => {
      alive = false;
    };
  }, []);

  // Load the selected clip's binary.
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setStatus(`loading ${selected}…`);
    fetch(`/debug/clips/${selected}.bin`)
      .then((r) => r.arrayBuffer())
      .then((b) => {
        if (!alive) return;
        const clip = parseClip(b);
        S.current.clip = clip;
        S.current.playhead = 0;
        if (scrubRef.current) {
          scrubRef.current.max = String(clip.frames - 1);
          scrubRef.current.value = '0';
        }
        setStatus(`${selected} · ${clip.frames}f @ ${clip.fps}fps`);
      })
      .catch((e) => alive && setStatus(`clip error: ${e}`));
    return () => {
      alive = false;
    };
  }, [selected]);

  // three.js scene — built once on mount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let raf = 0;

    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    renderer.setClearColor(0x0b0e1a, 1);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 60);
    camera.position.set(1.9, 1.15, 2.4);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x30364f, 2.0));
    const key = new THREE.DirectionalLight(0xfff6e6, 2.2);
    key.position.set(3, 6, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd0ff, 1.0);
    rim.position.set(-4, 3, -3);
    scene.add(rim);
    scene.add(new THREE.GridHelper(10, 20, 0x3a4270, 0x232842));

    // Skeleton overlay: 21 joint spheres + BONES_21 sticks (as bright lines).
    const jointGeo = new THREE.SphereGeometry(0.022, 12, 8);
    const jointMat = new THREE.MeshStandardNodeMaterial({ color: 0x7dd3fc, roughness: 0.4 });
    const joints = new THREE.InstancedMesh(jointGeo, jointMat, NB);
    joints.frustumCulled = false;
    scene.add(joints);

    const boneGeo = new THREE.BufferGeometry();
    const bonePos = new Float32Array(BONES_21.length * 2 * 3);
    boneGeo.setAttribute('position', new THREE.BufferAttribute(bonePos, 3));
    const boneMat = new THREE.LineBasicNodeMaterial({ color: 0x38bdf8 });
    const boneLines = new THREE.LineSegments(boneGeo, boneMat);
    boneLines.frustumCulled = false;
    scene.add(boneLines);

    const dummy = new THREE.Object3D();
    let dancer: IsaacVrmDancer | null = null;

    let controls: OrbitControls | null = null;
    let lastT = performance.now();
    let lastScrubSync = 0;
    let resize = () => {};

    void renderer.init().then(() => {
      if (disposed) return;
      resize = () => {
        const w = canvas.clientWidth || window.innerWidth;
        const h = canvas.clientHeight || window.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      window.addEventListener('resize', resize);

      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.target.set(0, 0.75, 0);
      controls.update();

      dancer = new IsaacVrmDancer(scene, DEFAULT_VRM_URL);
      dancer.setBodyCount(NB);
      void dancer.load();

      const loop = () => {
        raf = requestAnimationFrame(loop);
        const now = performance.now();
        const dt = Math.min((now - lastT) / 1000, 1 / 15);
        lastT = now;
        controls?.update();

        const st = S.current;
        const clip = st.clip;
        if (clip) {
          if (st.playing && !st.scrubbing) {
            st.playhead += dt * clip.fps * st.speed;
            if (st.playhead >= clip.frames) st.playhead -= clip.frames; // loop
          }
          const f = Math.min(clip.frames - 1, Math.max(0, Math.floor(st.playhead)));
          const fp = clip.pos.subarray(f * P_STRIDE, f * P_STRIDE + P_STRIDE);
          const fq = clip.quat.subarray(f * Q_STRIDE, f * Q_STRIDE + Q_STRIDE);

          // VRM. Exact-quat drive (poseExact) reproduces the pose 1:1 from the per-body
          // quaternions; the legacy aim+twist update() is kept behind the toggle for comparison.
          if (dancer) {
            dancer.grounding = st.grounding;
            dancer.setVisible(st.showVrm);
            if (st.exact) dancer.poseExact(fp, fq);
            else dancer.update(fp, 0, 0, 0, dt, fq);
          }

          // Skeleton overlay
          joints.visible = st.showSkel;
          boneLines.visible = st.showSkel;
          if (st.showSkel) {
            for (let j = 0; j < NB; j++) {
              dummy.position.set(tx(fp, j), ty(fp, j), tz(fp, j));
              dummy.updateMatrix();
              joints.setMatrixAt(j, dummy.matrix);
            }
            joints.instanceMatrix.needsUpdate = true;
            for (let b = 0; b < BONES_21.length; b++) {
              const [a, c] = BONES_21[b];
              bonePos[b * 6 + 0] = tx(fp, a);
              bonePos[b * 6 + 1] = ty(fp, a);
              bonePos[b * 6 + 2] = tz(fp, a);
              bonePos[b * 6 + 3] = tx(fp, c);
              bonePos[b * 6 + 4] = ty(fp, c);
              bonePos[b * 6 + 5] = tz(fp, c);
            }
            boneGeo.attributes.position.needsUpdate = true;
          }

          // reflect the playhead into the scrubber ~10x/s (no React churn)
          if (now - lastScrubSync > 100) {
            lastScrubSync = now;
            if (!st.scrubbing && scrubRef.current) scrubRef.current.value = String(f);
            if (frameLabelRef.current)
              frameLabelRef.current.textContent = `${f} / ${clip.frames - 1}`;
          }
        }
        renderer.render(scene, camera);
      };
      loop();
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      controls?.dispose();
      dancer?.dispose?.();
      jointGeo.dispose();
      boneGeo.dispose();
      renderer.dispose();
    };
  }, []);

  const onScrub = (e: ChangeEvent<HTMLInputElement>) => {
    S.current.playhead = Number(e.target.value);
    if (frameLabelRef.current && S.current.clip)
      frameLabelRef.current.textContent = `${e.target.value} / ${S.current.clip.frames - 1}`;
  };

  const btn: CSSProperties = {
    background: '#1c2340',
    color: '#cdd6f4',
    border: '1px solid #313a5e',
    borderRadius: 6,
    padding: '5px 10px',
    cursor: 'pointer',
    font: '12px ui-monospace,Menlo,monospace',
  };
  const on: CSSProperties = { ...btn, background: '#2a63c0', borderColor: '#3b7ae0' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0b0e1a' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      <div
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: 12,
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
          alignItems: 'center',
          background: 'rgba(12,15,26,0.82)',
          border: '1px solid #232842',
          borderRadius: 10,
          padding: '8px 12px',
          color: '#cdd6f4',
          font: '12px ui-monospace,Menlo,monospace',
        }}
      >
        <button style={btn} onClick={onExit}>
          ← exit
        </button>
        <select
          style={{ ...btn, maxWidth: 320 }}
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {clips.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <button style={playing ? on : btn} onClick={() => setPlaying((p) => !p)}>
          {playing ? '❚❚ pause' : '▶ play'}
        </button>
        <input
          ref={scrubRef}
          type="range"
          min={0}
          max={0}
          defaultValue={0}
          style={{ flex: '1 1 200px', minWidth: 160 }}
          onMouseDown={() => (S.current.scrubbing = true)}
          onMouseUp={() => (S.current.scrubbing = false)}
          onChange={onScrub}
        />
        <span ref={frameLabelRef} style={{ minWidth: 78, textAlign: 'right' }}>
          0 / 0
        </span>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          speed
          <input
            type="range"
            min={0.1}
            max={2}
            step={0.1}
            value={speed}
            style={{ width: 90 }}
            onChange={(e) => setSpeed(Number(e.target.value))}
          />
          <span style={{ width: 30 }}>{speed.toFixed(1)}×</span>
        </label>
        <button style={showVrm ? on : btn} onClick={() => setShowVrm((v) => !v)}>
          VRM
        </button>
        <button style={showSkel ? on : btn} onClick={() => setShowSkel((v) => !v)}>
          bones
        </button>
        <button
          style={exact ? on : btn}
          onClick={() => setExact((v) => !v)}
          title="Exact per-body quaternion drive (1:1) vs legacy aim+twist retarget"
        >
          {exact ? 'exact' : 'aim'}
        </button>
        <button
          style={grounding ? on : btn}
          onClick={() => setGrounding((v) => !v)}
          title="OFF = raw 1:1 pelvis→hips mapping (verifies the re-rooted rig grounds on its own)"
        >
          grounding: {grounding ? 'on' : 'off (raw)'}
        </button>
        <span style={{ opacity: 0.7 }}>{status}</span>
      </div>
    </div>
  );
}
