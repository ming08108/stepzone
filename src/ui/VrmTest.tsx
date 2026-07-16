/**
 * three.js dancer proving ground (`?vrm`) — a thin wrapper around ThreeVrmDancer
 * (src/render/threeDancer.ts), the same class the in-game attract dancer uses.
 *
 * Click-drag to orbit, scroll to zoom. The panel switches models, toggles a bone-skeleton
 * overlay, and exposes the dancer's live `tune` knobs so the motion can be dialed in without a
 * rebuild (each slider writes straight into d.tune, which build() reads every frame). The
 * bottom readout shows the whole-body TURN vs the clip's TORSO twist so we can tell them apart.
 */
import { useEffect, useRef, useState } from 'react';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ThreeVrmDancer } from '../render/threeDancer';

// AvatarSample_B and _C are dropped from the picker: they genuinely ship with long coats/dresses
// (confirmed in bind pose and with spring physics disabled — not a bug), which don't suit the
// pad dance and aren't removable without leaving the model undressed. _A stays: its "skirt" was a
// real bug (a short cardigan flung by the spring solver, now fixed) — it wears cardigan + pants.
const MODELS: Record<string, string> = {
  miku4: '/models/Miku4.vrm',
  a: '/models/AvatarSample_A.vrm',
  ps1: '/models/PS1Miku.vrm',
};

type Knob = { key: string; label: string; min: number; max: number; step: number };
const KNOBS: Knob[] = [
  { key: 'clipTwist', label: 'Clip rotation (samba spin)', min: 0, max: 1, step: 0.02 },
  { key: 'clipLean', label: 'Clip torso lean', min: 0, max: 1, step: 0.02 },
  { key: 'yawAmp', label: 'Turn on single cross', min: 0, max: 1.6, step: 0.02 },
  { key: 'crossTurn', label: 'Turn on full cross (→π spin)', min: 0, max: 3.14, step: 0.05 },
  { key: 'yawRate', label: 'Turn snappiness', min: 1, max: 30, step: 0.5 },
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
  clipTwist: 0,
  clipLean: 0.5,
  yawAmp: 0.5,
  crossTurn: 1.8,
  yawRate: 6,
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
  const readoutRef = useRef<HTMLDivElement>(null);
  const skelRef = useRef(false);
  const notesRef = useRef(false);
  const flipRef = useRef(false);
  const speedRef = useRef(1);
  const [tune, setTune] = useState<Record<string, number>>({ ...DEFAULTS });
  const [speed, setSpeed] = useState(1);
  const [show, setShow] = useState(true);
  const [skel, setSkel] = useState(false);
  const [notes, setNotes] = useState(false);
  const [flip, setFlip] = useState(false);
  const [model, setModel] = useState(
    () => new URLSearchParams(location.search).get('model')?.toLowerCase() ?? 'miku4',
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const params = new URLSearchParams(location.search);
    const modelUrl = MODELS[model] ?? MODELS.miku4;
    const clipBeats = Number(params.get('clipBeats'));
    // Deterministic driver (?fixed=<fps>): advance a synthetic 128-BPM beat at a FIXED dt so a
    // headless run is reproducible (dt-correctness + metric logging without rAF jitter).
    const fixedFps = Number(params.get('fixed'));

    let raf = 0;
    let controls: OrbitControls | null = null;
    let lastT = performance.now();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);

    const d = new ThreeVrmDancer({ modelUrl, canvas });
    dancerRef.current = d;
    (window as unknown as { __dancer?: ThreeVrmDancer }).__dancer = d;
    void d.init().then(() => {
      // Apply the current tune (survives a model switch) and skeleton toggle.
      Object.assign(d.tune, tune);
      if (clipBeats > 0) d.tune.clipBeats = clipBeats;
      d.showSkeleton(skelRef.current);
      d.setShowNotes(notesRef.current);
      d.tune.yawSign = flipRef.current ? -1 : 1;
      controls = new OrbitControls(d.cam, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      const [tx, ty, tz] = d.orbitTarget;
      controls.target.set(tx, ty, tz);
      controls.update();
      // A scaled clock: advance danceTime by dt·speed each frame so the WHOLE motion (clip,
      // springs, footwork) slows uniformly — true slow-mo, not just slower arms.
      let danceTime = 0;
      let cutCount = 0;
      let prevYawDeg = 0;
      let maxJump = 0;
      const loop = () => {
        raf = requestAnimationFrame(loop);
        let sdt: number;
        if (fixedFps > 0) {
          sdt = (1 / fixedFps) * speedRef.current;
        } else {
          const now = performance.now();
          sdt = Math.min((now - lastT) / 1000, 1 / 30) * speedRef.current;
          lastT = now;
        }
        danceTime += sdt;
        const beat = (danceTime * 128) / 60;
        d.build(danceTime, beat, sdt);
        controls?.update();
        d.render();
        const el = readoutRef.current;
        if (el) {
          const dbg = d.debug();
          if (dbg.cut) cutCount++;
          const jump = Math.abs(dbg.yawDeg - prevYawDeg);
          if (jump > maxJump) maxJump = jump;
          prevYawDeg = dbg.yawDeg;
          el.textContent =
            `body turn ${dbg.yawDeg.toFixed(1)}°  ·  torso twist ${dbg.twistDeg.toFixed(1)}°  ·  ` +
            `cuts ${cutCount}  ·  max turn/frame ${maxJump.toFixed(2)}°`;
          el.style.color = dbg.cut ? '#ff6b6b' : '#8fead0';
        }
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
  }, [onExit, model]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    skelRef.current = skel;
    dancerRef.current?.showSkeleton(skel);
  }, [skel]);

  useEffect(() => {
    notesRef.current = notes;
    dancerRef.current?.setShowNotes(notes);
  }, [notes]);

  useEffect(() => {
    flipRef.current = flip;
    const d = dancerRef.current;
    if (d) d.tune.yawSign = flip ? -1 : 1;
  }, [flip]);

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
  const setSpd = (v: number) => {
    setSpeed(v);
    speedRef.current = v;
  };

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', background: '#14162a' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      <div ref={readoutRef} style={readout} />
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={model} onChange={(e) => setModel(e.target.value)} style={sel}>
              {Object.keys(MODELS).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={skel} onChange={(e) => setSkel(e.target.checked)} />
              skel
            </label>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} />
              notes
            </label>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} />
              flip turn
            </label>
          </div>
          <label style={row}>
            <span style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Playback speed</span>
              <span style={{ opacity: 0.7 }}>{speed.toFixed(2)}×</span>
            </span>
            <input
              type="range"
              min={0.1}
              max={1.5}
              step={0.05}
              value={speed}
              onChange={(e) => setSpd(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </label>
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
const readout: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  left: 12,
  padding: '4px 8px',
  background: 'rgba(12,14,26,0.75)',
  color: '#8fead0',
  font: '12px ui-monospace, monospace',
  borderRadius: 6,
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
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
const sel: React.CSSProperties = { ...btn, flex: 1 };
