/**
 * three.js dancer proving ground (`?vrm`) — a thin wrapper around ThreeVrmDancer
 * (src/render/threeDancer.ts), the same class the in-game attract dancer uses.
 * `?model=` picks the avatar: miku4 (default), a|b|c (VRoid samples), ps1.
 *
 * Click-drag to orbit, scroll to zoom. The panel exposes the dancer's live `tune` knobs so
 * the motion can be dialed in without a rebuild (each slider writes straight into d.tune,
 * which build() reads every frame).
 */
import { useEffect, useRef, useState } from 'react';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ThreeVrmDancer } from '../render/threeDancer';

const MODELS: Record<string, string> = {
  miku4: '/models/Miku4.vrm',
  a: '/models/AvatarSample_A.vrm',
  b: '/models/AvatarSample_B.vrm',
  c: '/models/AvatarSample_C.vrm',
  ps1: '/models/PS1Miku.vrm',
};

type Knob = { key: string; label: string; min: number; max: number; step: number };
const KNOBS: Knob[] = [
  { key: 'yawAmp', label: 'Body turn into crossover', min: 0, max: 1, step: 0.01 },
  { key: 'yawRate', label: 'Turn speed (rad/s)', min: 0.3, max: 6, step: 0.1 },
  { key: 'commitX', label: 'Weight shift  ← →', min: 0, max: 1, step: 0.02 },
  { key: 'commitZ', label: 'Weight shift  fore/aft', min: 0, max: 1, step: 0.02 },
  { key: 'comStiff', label: 'Weight stiffness', min: 3, max: 20, step: 0.5 },
  { key: 'leanRoll', label: 'Lean into travel', min: 0, max: 1, step: 0.02 },
  { key: 'leanPitch', label: 'Lean fore/aft', min: 0, max: 1, step: 0.02 },
  { key: 'pelvisRoll', label: 'Hip hike (contrapposto)', min: 0, max: 0.3, step: 0.01 },
  { key: 'bounce', label: 'Bounce / impact', min: 0, max: 2, step: 0.05 },
  { key: 'kneeSplit', label: 'Knee anti-clip', min: 0, max: 8, step: 0.2 },
  { key: 'clipBeats', label: 'Arm speed (beats/loop)', min: 12, max: 80, step: 1 },
];
const DEFAULTS: Record<string, number> = {
  yawAmp: 0.45,
  yawRate: 1.3,
  commitX: 0.6,
  commitZ: 0.5,
  comStiff: 9,
  leanRoll: 0.45,
  leanPitch: 0.35,
  pelvisRoll: 0.09,
  bounce: 1.0,
  kneeSplit: 4.0,
  clipBeats: 39,
};

export function VrmTest({ onExit }: { onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dancerRef = useRef<ThreeVrmDancer | null>(null);
  const [tune, setTune] = useState<Record<string, number>>({ ...DEFAULTS });
  const [show, setShow] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const params = new URLSearchParams(location.search);
    const key = params.get('model')?.toLowerCase() ?? 'miku4';
    const modelUrl = MODELS[key] ?? MODELS.miku4;
    const clipBeats = Number(params.get('clipBeats'));
    // Deterministic driver (?fixed=<fps>): advance a synthetic 128-BPM beat at a FIXED dt so a
    // headless run is reproducible (dt-correctness + metric logging without rAF jitter).
    const fixedFps = Number(params.get('fixed'));

    let raf = 0;
    let controls: OrbitControls | null = null;
    let lastT = performance.now();
    const t0 = performance.now();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);

    const d = new ThreeVrmDancer({ modelUrl, canvas });
    dancerRef.current = d;
    (window as unknown as { __dancer?: ThreeVrmDancer }).__dancer = d;
    void d.init().then(() => {
      if (clipBeats > 0) d.tune.clipBeats = clipBeats;
      // Orbit: click-drag rotates, wheel zooms. Attached to the canvas, so the panel doesn't grab it.
      controls = new OrbitControls(d.cam, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      const [tx, ty, tz] = d.orbitTarget;
      controls.target.set(tx, ty, tz);
      controls.update();
      let frame = 0;
      const loop = () => {
        raf = requestAnimationFrame(loop);
        let elapsed: number;
        let dt: number;
        if (fixedFps > 0) {
          dt = 1 / fixedFps;
          elapsed = frame * dt;
          frame++;
        } else {
          const now = performance.now();
          dt = Math.min((now - lastT) / 1000, 1 / 30);
          lastT = now;
          elapsed = (now - t0) / 1000;
        }
        const beat = (elapsed * 128) / 60;
        d.build(elapsed, beat, dt);
        controls?.update();
        d.render();
      };
      loop();
    });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      controls?.dispose();
      d.dispose();
      dancerRef.current = null;
    };
  }, [onExit]);

  const set = (k: string, v: number) => {
    setTune((t) => ({ ...t, [k]: v }));
    const d = dancerRef.current;
    if (d) (d.tune as unknown as Record<string, number>)[k] = v;
  };
  const reset = () => {
    setTune({ ...DEFAULTS });
    const d = dancerRef.current;
    if (d) Object.assign(d.tune, DEFAULTS);
  };

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', background: '#14162a' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      <button
        onClick={() => setShow((s) => !s)}
        style={{ ...btn, position: 'absolute', top: 10, right: 10 }}
      >
        {show ? 'hide' : 'tune'}
      </button>
      {show && (
        <div style={panel}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 13 }}>dancer tune</strong>
            <button onClick={reset} style={btn}>
              reset
            </button>
          </div>
          {KNOBS.map((k) => (
            <label key={k.key} style={row}>
              <span style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{k.label}</span>
                <span style={{ opacity: 0.7 }}>{tune[k.key]?.toFixed(2)}</span>
              </span>
              <input
                type="range"
                min={k.min}
                max={k.max}
                step={k.step}
                value={tune[k.key]}
                onChange={(e) => set(k.key, Number(e.target.value))}
                style={{ width: '100%' }}
              />
            </label>
          ))}
          <div style={{ opacity: 0.5, fontSize: 11, marginTop: 4 }}>
            drag to orbit · scroll to zoom
          </div>
        </div>
      )}
    </div>
  );
}

const panel: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  left: 10,
  width: 250,
  maxHeight: 'calc(100vh - 20px)',
  overflowY: 'auto',
  padding: '10px 12px',
  background: 'rgba(12,14,26,0.82)',
  color: '#e8ecf4',
  font: '12px system-ui, sans-serif',
  borderRadius: 8,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const row: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 };
const btn: React.CSSProperties = {
  background: '#2a2f45',
  color: '#e8ecf4',
  border: '1px solid #3a4060',
  borderRadius: 6,
  padding: '3px 8px',
  fontSize: 12,
  cursor: 'pointer',
};
