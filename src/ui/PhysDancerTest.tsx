/**
 * ?phys — proving ground for the PHYSICS dancer (src/phys/*): a muscle-driven
 * ragdoll that balances and dances on a 4-panel pad, rendered through a VRM
 * avatar. Completely independent of the animation-driven ?vrm dancer.
 *
 * URL params: ?phys&model=miku4|ps1|a  &fixed=<fps> (deterministic clock for
 * headless capture). Test hook: window.__physDancer = the live sim.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils, MToonMaterialLoaderPlugin, type VRM } from '@pixiv/three-vrm';
import { MToonNodeMaterial } from '@pixiv/three-vrm/nodes';
import { loadRapier, PhysDanceSim } from '../phys/simulation';
import { skeletonFromVrm } from '../phys/vrmBinding';
import { PhysVrmBinding } from '../phys/vrmBinding';
import { PHYS_PANEL } from '../phys/controller';
import type { BodyName } from '../phys/rig';

const MODELS: Record<string, string> = {
  miku4: '/models/Miku4.vrm',
  ps1: '/models/PS1Miku.vrm',
  a: '/models/AvatarSample_A.vrm',
};

const PANEL_COL = [0xff5f5f, 0x5fb4ff, 0x8fff5f, 0xffd75f];

export function PhysDancerTest({ onExit }: { onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<PhysDanceSim | null>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('loading…');
  const [assist, setAssist] = useState(1.0);
  const [muscle, setMuscle] = useState(1.0);
  const [bpm, setBpm] = useState(110);
  const [speed, setSpeed] = useState(1.0);
  const [showBodies, setShowBodies] = useState(false);
  const params = new URLSearchParams(location.search);
  const modelKey = (params.get('model') ?? 'miku4').toLowerCase();
  const modelUrl = MODELS[modelKey] ?? MODELS.miku4;
  const fixedFps = Number(params.get('fixed') ?? 0);

  const knobsRef = useRef({ assist, muscle, bpm, speed, showBodies });
  knobsRef.current = { assist, muscle, bpm, speed, showBodies };

  useEffect(() => {
    const canvas = canvasRef.current!;
    let disposed = false;
    let raf = 0;
    let renderer: THREE.WebGPURenderer | null = null;
    let controls: OrbitControls | null = null;

    (async () => {
      const [R, gltf] = await Promise.all([
        loadRapier(),
        (() => {
          const loader = new GLTFLoader();
          loader.register(
            (parser) =>
              new VRMLoaderPlugin(parser, {
                mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser, {
                  materialType: MToonNodeMaterial,
                }),
              }),
          );
          return loader.loadAsync(modelUrl);
        })(),
      ]);
      if (disposed) return;
      const vrm = gltf.userData.vrm as VRM;
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineMorphs?.(vrm);
      VRMUtils.rotateVRM0(vrm); // face +Z (toward the camera)
      vrm.scene.traverse((o) => ((o as THREE.Mesh).frustumCulled = false));
      vrm.scene.updateMatrixWorld(true);

      // Physics: measure the avatar, build the ragdoll + brain, bind bones.
      const skel = skeletonFromVrm(vrm);
      const sim = new PhysDanceSim(R, skel, { bpm: knobsRef.current.bpm });
      const binding = new PhysVrmBinding(vrm, sim.rig);
      simRef.current = sim;
      (window as unknown as { __physDancer: PhysDanceSim }).__physDancer = sim;

      // Scene.
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x101018);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x334433, 2.0));
      const key = new THREE.DirectionalLight(0xfff9ea, 2.4);
      key.position.set(3, 5, 3);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xbfd0ff, 1.2);
      rim.position.set(-2, 4, -5);
      scene.add(rim);

      // Pad: slab + panels.
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(0.95, 0.02, 0.95),
        new THREE.MeshStandardNodeMaterial({ color: 0x0a0a14, roughness: 0.6 }),
      );
      slab.position.y = -0.011;
      scene.add(slab);
      PHYS_PANEL.forEach((p, i) => {
        const tile = new THREE.Mesh(
          new THREE.BoxGeometry(0.26, 0.008, 0.26),
          new THREE.MeshBasicNodeMaterial({ color: PANEL_COL[i], transparent: true, opacity: 0.4 }),
        );
        tile.position.copy(p).setY(0.004);
        scene.add(tile);
      });
      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(6, 48),
        new THREE.MeshStandardNodeMaterial({ color: 0x14141c, roughness: 0.9 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.02;
      scene.add(floor);

      scene.add(vrm.scene);

      // Debug: one marker per rigid body (mass-scaled), toggled by 'bodies'.
      const bodyMarkers: { name: BodyName; mesh: THREE.Mesh }[] = [];
      const markerMat = new THREE.MeshBasicNodeMaterial({
        color: 0x4fd6ff,
        wireframe: true,
        transparent: true,
        opacity: 0.7,
      });
      for (const [name, body] of sim.rig.bodies) {
        const r = 0.02 + 0.02 * Math.cbrt(body.mass());
        const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(r), markerMat);
        mesh.visible = false;
        scene.add(mesh);
        bodyMarkers.push({ name, mesh });
      }

      // Renderer + camera.
      const w = canvas.clientWidth || innerWidth;
      const h = canvas.clientHeight || innerHeight;
      renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
      renderer.setSize(w, h, false);
      renderer.toneMapping = THREE.NeutralToneMapping;
      await renderer.init();
      if (disposed) return;
      const camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 50);
      camera.position.set(0, 1.35, 3.4);
      controls = new OrbitControls(camera, canvas);
      controls.target.set(0, 0.9, 0);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;

      setStatus('');
      let last = performance.now();
      let simTime = 0;
      const loop = () => {
        if (disposed) return;
        raf = requestAnimationFrame(loop);
        const now = performance.now();
        const kn = knobsRef.current;
        const wall = Math.min(1 / 30, (now - last) / 1000);
        last = now;
        const dt = (fixedFps > 0 ? 1 / fixedFps : wall) * kn.speed;
        simTime += dt;
        sim.assist = kn.assist;
        sim.rig.muscleScale = kn.muscle;
        sim.bpm = kn.bpm;
        try {
          sim.tick(dt);
          binding.apply();
        } catch (e) {
          console.error(e);
        }
        for (const m of bodyMarkers) {
          m.mesh.visible = kn.showBodies;
          if (kn.showBodies) {
            const b = sim.rig.bodies.get(m.name)!;
            const p = b.translation();
            const q = b.rotation();
            m.mesh.position.set(p.x, p.y, p.z);
            m.mesh.quaternion.set(q.x, q.y, q.z, q.w);
          }
        }
        if (readoutRef.current) {
          const st = sim.rig.readState();
          readoutRef.current.textContent =
            `beat ${sim.beat.toFixed(1)}  com (${st.com.x.toFixed(2)}, ${st.com.y.toFixed(2)}, ` +
            `${st.com.z.toFixed(2)})  feet ${st.feet[0].contact ? 'L' : '·'}${st.feet[1].contact ? 'R' : '·'}  ` +
            `t ${simTime.toFixed(1)}s`;
        }
        controls!.update();
        void renderer!.render(scene, camera);
      };
      loop();
    })().catch((e) => {
      console.error(e);
      setStatus(`failed: ${e?.message ?? e}`);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      controls?.dispose();
      simRef.current?.dispose();
      simRef.current = null;
      renderer?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrl]);

  const shove = () => {
    const s = simRef.current;
    if (!s) return;
    const a = Math.random() * Math.PI * 2;
    s.rig.shove(3.2 * Math.cos(a), 0, 3.2 * Math.sin(a));
  };

  return (
    <div className="fixed inset-0 bg-black">
      <canvas ref={canvasRef} className="h-full w-full" />
      {status && (
        <div className="absolute inset-0 grid place-items-center text-white/80">{status}</div>
      )}
      <div className="absolute left-3 top-3 flex w-64 flex-col gap-2 rounded bg-black/70 p-3 text-xs text-white/90">
        <div className="flex items-center justify-between">
          <b>PHYSICS DANCER</b>
          <button className="rounded bg-white/10 px-2 py-0.5" onClick={onExit}>
            exit
          </button>
        </div>
        <div ref={readoutRef} className="font-mono text-[10px] text-white/60" />
        <label className="flex items-center justify-between gap-2">
          assist (0 = pure physics) <span>{assist.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={assist}
          onChange={(e) => setAssist(Number(e.target.value))}
        />
        <label className="flex items-center justify-between gap-2">
          muscle strength <span>{muscle.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min={0.2}
          max={2}
          step={0.05}
          value={muscle}
          onChange={(e) => setMuscle(Number(e.target.value))}
        />
        <label className="flex items-center justify-between gap-2">
          bpm <span>{bpm}</span>
        </label>
        <input
          type="range"
          min={60}
          max={180}
          step={1}
          value={bpm}
          onChange={(e) => setBpm(Number(e.target.value))}
        />
        <label className="flex items-center justify-between gap-2">
          speed <span>{speed.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min={0.1}
          max={1.5}
          step={0.05}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={showBodies}
            onChange={(e) => setShowBodies(e.target.checked)}
          />
          show rigid bodies
        </label>
        <button className="rounded bg-rose-500/70 px-2 py-1 font-bold" onClick={shove}>
          SHOVE (test physicality)
        </button>
        <div className="text-[10px] leading-snug text-white/50">
          Every motion is muscle torque against gravity — no animation. Assist is an external
          stabilizer standing in for a trained balance policy; slide to 0 to watch pure physics (she
          will eventually stumble).
        </div>
      </div>
    </div>
  );
}
