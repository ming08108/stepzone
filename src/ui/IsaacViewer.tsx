import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { IsaacVrmDancer, DEFAULT_VRM_URL } from '../render/isaacVrmDancer';
import { MAX_BODIES, layoutForBodies, type SkeletonLayout } from '../render/isaacSkeleton';

/**
 * ?isaacviewer — live viewer for humanoid poses streamed out of an Isaac Lab
 * training run.
 *
 * Wire: Isaac trainer (pose_stream_hook) -> pose_stream.bin (mmap) ->
 * pose_relay.py (WebSocket on ws://127.0.0.1:8765) -> this page. Each frame is
 * the first K envs' `b` body positions in per-env LOCAL frame (the hook subtracts
 * each env's grid origin; Isaac Z-up). `b` is 15 (legacy humanoid_28) or 21 (the
 * Miku-exact skeleton) — the viewer reads it per frame and picks the matching bone
 * table (src/render/isaacSkeleton.ts). We draw each env as a clean ball-and-tube
 * skeleton (one sphere per body + its bones) on a dark stage with a ground grid,
 * matching the house dancer look. Because bodies are env-local, the future DDR
 * pads (also env-local) will line up with the feet with no extra bookkeeping.
 *
 * The stream is ~15-30 Hz and the sim is usually SLOWER than real-time (<1x) while
 * training, so frames arrive slower than the 30 Hz control rate they represent.
 * Three display modes cycle on the P key:
 *   - 1X (default): a timestamp-paced jitter buffer. Bank ~PREBUFFER_S of sim-time,
 *     then play the dance by `sim_t` at TRUE real-time (1.0x) so it looks like a
 *     real-speed dance, not slow-motion. When the sim runs below 1x the buffer
 *     drains and it holds/rebuilds the lead (HUD shows "BUFFERING NN%") — real-speed
 *     motion in chunks instead of the per-frame micro-freezes a naive 1x shows.
 *   - SMOOTH: play by `sim_t` at the rolling-average sim rate, holding ~1 s of
 *     buffer. Fluid and continuous, but renders sub-1x motion as slow-motion.
 *   - LIVE: arrival-paced, lowest latency — passes the raw sawtooth through.
 * A live "sim N.Nx" readout is the measured sim-time/wall-time rate; 1X/SMOOTH
 * also show buffered depth in seconds.
 *
 * Degrades gracefully: with no relay it shows an idle message and keeps
 * retrying the socket; the 3D stage renders regardless.
 */

// Connect back to whatever host served the page (so a phone/laptop on the LAN
// reaches the relay on the serving PC), with a `?ws=` override for anything odd.
function resolveWsUrl(): string {
  const p = new URLSearchParams(location.search).get('ws');
  if (p) return p.startsWith('ws') ? p : `ws://${p}`;
  const host = window.location.hostname || '127.0.0.1';
  return `ws://${host}:8765`;
}

// ?isaacviewer&exp=<id> — resolve a training stream by experiment id via the fleet
// feed instead of a hardwired ?ws=. Mirrors the ?experiments dashboard so a link
// survives the box cycling (the ws url changes; the exp id doesn't). Local dev and
// the trycloudflare tunnel read /experiments.json; everything else reads the pushed
// /api/experiments feed — identical to ExperimentsDashboard.feedUrl().
function viewerFeedUrl(): string {
  const h = location.hostname;
  const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local');
  const isTunnel = h.endsWith('trycloudflare.com');
  return isLocal || isTunnel ? '/experiments.json' : '/api/experiments';
}
// ws_public on a *.trycloudflare.com host (phone/off-LAN), else ws_local with a
// ws_public fallback (prefer LAN, fall back to the public tunnel). Mirrors the
// dashboard's wsUrlFor. null => this row has no reachable stream yet.
function wsUrlForRow(row: { ws_local?: string | null; ws_public?: string | null }): string | null {
  const onTunnel = location.hostname.endsWith('trycloudflare.com');
  const url = onTunnel ? row.ws_public : (row.ws_local ?? row.ws_public);
  return url && url.length ? url : null;
}

// ?miku — which dancer slot renders as the VRM anime avatar instead of a capsule
// skeleton. Default slot 0. `?miku=off` disables (all capsules). `?miku=N` picks
// slot N. `?vrmurl=` overrides the .vrm asset (drop any .vrm in public/models/).
function resolveMikuSlot(): number {
  const p = new URLSearchParams(location.search).get('miku');
  if (p === null) return 0; // default: slot 0 is the VRM
  if (p === 'off' || p === 'none' || p === 'false') return -1;
  const n = parseInt(p, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function resolveVrmUrl(): string {
  const p = new URLSearchParams(location.search).get('vrmurl');
  return p && p.length ? p : DEFAULT_VRM_URL;
}

// ?fps=15|30|60 caps the render loop (frame-skip in RAF). The stream is ~15 Hz, so
// 30 fps rendering loses nothing while roughly halving GPU load — important because
// these viewer tabs share the GPU with the trainer. Default 30; clamped to [5,120].
function resolveTargetFps(): number {
  const p = new URLSearchParams(location.search).get('fps');
  const n = p ? parseInt(p, 10) : NaN;
  if (Number.isFinite(n)) return Math.min(120, Math.max(5, n));
  return 30;
}

// Snap (skip interpolation) when a body jumps more than this between consecutive
// stream frames -- an env reset teleports the dancer, which must read as a clean
// cut, not a smeared slide.
const SNAP_JUMP = 0.6;

// The skeleton (body count + capsule bone table) is chosen per-frame from the
// stream's `b` field — 15-body legacy or 21-body Miku — by layoutForBodies().
// Scratch arrays are sized to MAX_BODIES so a 15 <-> 21 switch never reallocates.
// See src/render/isaacSkeleton.ts for the two index orders.

// Distinct hue per env so the K dancers read apart.
const DANCER_HUES = [0.52, 0.08, 0.32, 0.85, 0.15, 0.68, 0.0, 0.45];

// ~2-frame jitter buffer at 30 Hz: render `now - INTERP_DELAY` so there's almost
// always a frame on each side of the sample time to interpolate across.
const INTERP_DELAY = 0.07;
// SMOOTH mode: pace playback at the rolling-average sim rate, holding ~BUFFER_S of
// wall-clock buffer to absorb the collect/learn (rollout/update) sawtooth.
const BUFFER_S = 1.0;
const RATE_WINDOW_S = 5.0; // rolling window for the sim-rate estimate
// 1X mode: a timestamp-paced jitter buffer that plays back at TRUE real-time (1x)
// regardless of how slowly frames arrive. Bank PREBUFFER_S of sim-time before
// (re)starting, then advance the playhead at 1.0 sim-s per wall-s. When the sim
// runs slower than 1x the buffer eventually drains -> re-enter buffering and hold
// the last frame until the lead is rebuilt (real-speed dance in chunks, not
// per-frame micro-freezes). If the sim outruns 1x, snap forward past MAX_LEAD_S so
// latency stays bounded.
const PREBUFFER_S = 1.5; // sim-seconds of lead to bank before (re)starting 1x playback
const MAX_LEAD_S = 3.0; // sim-seconds; deeper than this => sim faster than 1x, drop toward latest

interface Frame {
  tRecv: number; // seconds, performance.now()-based (arrival / interp clock)
  tWall: number; // seconds since epoch, from the writer (latency display)
  tSim: number; // simulated seconds (advances at the sim's it/s-dependent rate)
  seq: number;
  step: number; // control-step index
  k: number;
  pos: Float32Array; // length k*b*3, Isaac world space (Z-up)
  quat?: Float32Array; // optional length k*b*4, per-body world quat, XYZW, Isaac Z-up
  targets?: EnvTarget[]; // optional DDR pad state, one entry per env
}

// SMOOTH: play by sim-timestamp at the average sim rate (default, no sawtooth).
// LIVE: arrival-paced, lowest latency (raw collect/learn rhythm).
// 1X: true realtime by sim-timestamp (only meaningful when sim rate >= 1).
type PlayMode = 'smooth' | 'live' | '1x';

// DDR step-target pads (PLANNED trainer feature; dormant until the stream sends
// a per-env `targets` field). Canonical local-frame pad centers on the ground,
// Isaac ground plane (x forward, y left), half-size 0.15 m. Order L, R, U, D.
const PAD_LOCAL: ReadonlyArray<readonly [number, number]> = [
  [0, 0.3], // L
  [0, -0.3], // R
  [0.3, 0], // U
  [-0.3, 0], // D
];
const PAD_LEAD_DEFAULT = 0.8; // s: how far ahead a pad starts lighting up
const FLASH_MS = 260;

/** Permissive per-env target state. Field names may still change trainer-side,
 *  so we read several aliases and ignore everything unknown. */
interface EnvTarget {
  originX: number;
  originY: number;
  padXY?: [number, number][]; // explicit env-local pad centers (real DDR stream)
  active: number; // active pad index, -1 = none
  ttd: number; // seconds to due (Infinity = none)
  lead: number;
  events: { pad: number; hit: boolean }[];
}

function pickNum(obj: Record<string, unknown>, keys: string[], dflt: number): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return dflt;
}

function normTargets(raw: unknown): EnvTarget[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((e0) => {
    const e = (e0 ?? {}) as Record<string, unknown>;
    const origin = e.origin ?? e.o;
    const ox = Array.isArray(origin) ? Number(origin[0]) || 0 : pickNum(e, ['ox', 'origin_x'], 0);
    const oy = Array.isArray(origin) ? Number(origin[1]) || 0 : pickNum(e, ['oy', 'origin_y'], 0);
    let padXY: [number, number][] | undefined;
    if (Array.isArray(e.pads)) {
      padXY = (e.pads as unknown[]).slice(0, PAD_LOCAL.length).map((pr) => {
        const a = Array.isArray(pr) ? pr : [0, 0];
        return [Number(a[0]) || 0, Number(a[1]) || 0] as [number, number];
      });
    }
    const evRaw = e.events ?? e.flashes;
    const events = Array.isArray(evRaw)
      ? evRaw.map((v0) => {
          const v = (v0 ?? {}) as Record<string, unknown>;
          return {
            pad: Math.round(pickNum(v, ['pad', 'idx', 'i'], -1)),
            hit: Boolean((v.hit ?? v.ok ?? v.good) as unknown),
          };
        })
      : [];
    return {
      originX: ox,
      originY: oy,
      padXY,
      active: Math.round(pickNum(e, ['active', 'active_pad', 'idx', 'pad'], -1)),
      ttd: pickNum(e, ['ttd', 'time_to_due', 'timeToDue', 't_due'], Infinity),
      lead: pickNum(e, ['lead', 'lead_time'], PAD_LEAD_DEFAULT) || PAD_LEAD_DEFAULT,
      events,
    };
  });
}

/** Isaac world (x=fwd, y=left, z=up) -> three.js (Y-up), VRM-aligned: Ry(+90)·Rx(-90) = (-iy, iz, -ix).
 *  Matches isaacVrmDancer.isaacToThree so the capsule skeleton and the VRM share one frame (the plain
 *  Rx(-90) mapping sits 90° off the VRM because the MJCF's forward is -Z_gltf, not Isaac +X). */
function isaacToThree(ix: number, iy: number, iz: number, out: THREE.Vector3): void {
  out.set(-iy, iz, -ix);
}

/** Debug overlay: make a capsule mesh draw ON TOP of the VRM (disable depth-test) so the skeleton is
 *  always visible over the mesh. Idempotent; cheap to call each frame. */
function overlayOnTop(obj: THREE.Object3D): void {
  const mat = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  if (!mat) return;
  for (const m of Array.isArray(mat) ? mat : [mat]) m.depthTest = false;
}

export function IsaacViewer({ onExit }: { onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  // Preview mode: the page was loaded with an explicit ?ws= override (pointing at
  // the clip-preview relay). Only then do we show the page switcher + clip labels;
  // the normal training viewer (no ?ws=) is completely unchanged.
  const previewMode = useMemo(() => new URLSearchParams(location.search).has('ws'), []);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const [activePage, setActivePage] = useState<number | null>(null);
  // Bridges between the one-shot imperative effect and React state/handlers.
  const setActivePageRef = useRef(setActivePage);
  setActivePageRef.current = setActivePage;
  const sendPageRef = useRef<(n: number) => void>(() => {});
  const changePage = (n: number) => {
    setActivePage(n); // optimistic highlight; relay echoes the authoritative page
    sendPageRef.current(n);
  };

  // ---- clip review mode (?review=1, preview only) -------------------------
  // Page through the 27 unique clips one at a time (one clip -> all 12 slots,
  // phase-shifted) and vote keep/drop/skip; votes persist in localStorage and are
  // collected into a pasteable results block.
  const reviewMode = useMemo(
    () => previewMode && new URLSearchParams(location.search).get('review') === '1',
    [previewMode],
  );
  type Vote = 'y' | 'n' | 'skip';
  const VOTES_KEY = 'stepzone.review.votes';
  const loadVotes = (): Record<string, Vote> => {
    try {
      const v = JSON.parse(localStorage.getItem(VOTES_KEY) || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  };
  const [reviewInfo, setReviewInfo] = useState<{ i: number; total: number; name: string } | null>(
    null,
  );
  const [reviewNames, setReviewNames] = useState<string[]>([]);
  type PreItem = { name: string; diag: number; med_speed: number; p90_speed: number };
  const [reviewPrefiltered, setReviewPrefiltered] = useState<PreItem[]>([]);
  type Progress = { frame: number; frames: number; t: number; dur: number };
  const [reviewProgress, setReviewProgress] = useState<Progress | null>(null);
  const setReviewProgressRef = useRef(setReviewProgress);
  setReviewProgressRef.current = setReviewProgress;
  const [votes, setVotes] = useState<Record<string, Vote>>(loadVotes);
  const [finished, setFinished] = useState(false);
  const [copied, setCopied] = useState(false);

  const setReviewInfoRef = useRef(setReviewInfo);
  setReviewInfoRef.current = setReviewInfo;
  const setReviewNamesRef = useRef(setReviewNames);
  setReviewNamesRef.current = setReviewNames;
  const setReviewPrefilteredRef = useRef(setReviewPrefiltered);
  setReviewPrefilteredRef.current = setReviewPrefiltered;
  const sendClipRef = useRef<(i: number) => void>(() => {});
  const reviewInfoRef = useRef(reviewInfo);
  reviewInfoRef.current = reviewInfo;

  const gotoClip = (i: number) => {
    setFinished(false);
    sendClipRef.current(i);
  };
  const recordVote = (name: string, v: Vote) => {
    setVotes((prev) => {
      const next = { ...prev, [name]: v };
      try {
        localStorage.setItem(VOTES_KEY, JSON.stringify(next));
      } catch {
        /* storage full / disabled — vote still lives in memory */
      }
      return next;
    });
  };
  const voteAndAdvance = (v: Vote) => {
    const info = reviewInfoRef.current;
    if (!info) return;
    recordVote(info.name, v);
    if (info.i >= info.total - 1)
      setFinished(true); // voted the last clip -> results
    else gotoClip(info.i + 1);
  };
  const navigate = (d: number) => {
    const info = reviewInfoRef.current;
    if (!info) return;
    gotoClip(Math.min(info.total - 1, Math.max(0, info.i + d)));
  };
  const voteRef = useRef(voteAndAdvance);
  voteRef.current = voteAndAdvance;
  const navRef = useRef(navigate);
  navRef.current = navigate;

  useEffect(() => {
    const canvas = canvasRef.current;
    const hud = hudRef.current;
    if (!canvas) return;

    let disposed = false;
    let raf = 0;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let controls: OrbitControls | null = null;

    // ---- ring buffer of recent frames (for temporal interpolation) ----------
    const frames: Frame[] = [];
    let sampledFrame: Frame | null = null; // frame the playhead currently shows
    let displaySeq = -1; // seq of the last displayed frame (for event catch-up)
    let lastSeq = -1;
    let lastRecvAt = 0;
    // Default 1X: the timestamp-paced jitter buffer that plays the dance at true
    // real-time speed even while the training sim produces frames slower than 1x
    // (SMOOTH would render that fluid-but-slow; LIVE would pass the sawtooth
    // through). Review forces LIVE (arrival-paced, no buffer refill) so a clip
    // switch shows the new dancer within a couple frames.
    let mode: PlayMode = reviewMode ? 'live' : '1x';
    let playbackSim = 0; // sim-seconds playback clock (SMOOTH / 1X)
    let playbackInit = false;
    let buffering1x = false; // 1X: currently holding a frame while (re)building the lead
    let rateEst = 1; // rolling estimate of sim-seconds per wall-second
    const rateSamples: { tRecv: number; tSim: number }[] = [];
    // ?ws= wins over ?exp= (power-user override, unchanged 1500ms static retry).
    // exp mode: no ?ws=, but ?exp=<id> is present — resolve the ws url from the feed
    // and re-resolve on every reconnect (the box may have cycled to a new url).
    const expId = new URLSearchParams(location.search).get('exp');
    const expMode = !previewMode && !!expId;
    // Mutable so exp-mode reconnects can retarget a freshly-resolved url; the ?ws=
    // path leaves this at the static resolveWsUrl() value forever.
    let currentWsAddr = resolveWsUrl();
    let expBackoff = 10_000; // exp-mode reconnect backoff (10→20→40→60→60…, ms)
    const mikuSlot = resolveMikuSlot();
    const vrmUrl = resolveVrmUrl();
    // Optional VRM avatar for one dancer slot (graceful capsule fallback on failure).
    let vrmDancer: IsaacVrmDancer | null = null;
    // Camera-on-miku mode: C toggles a tight, self-framing shot that follows the VRM
    // dancer's pelvis instead of the whole grid. `?mikucam` starts in it.
    // Quat-driven axial twist on the VRM (facing/turns). On by default when the relay
    // sends quats; `?twist=off` forces swing-only (positions) for A/B + fallback.
    const twistEnabled = new URLSearchParams(location.search).get('twist') !== 'off';
    let mikuCam = mikuSlot >= 0 && new URLSearchParams(location.search).has('mikucam');
    let mikuCamInit = false; // false = need to (re)seat the camera on next apply
    const mikuTarget = new THREE.Vector3(); // smoothed follow target (chest height)

    // ---- preview clip labels + page control (preview mode only) -------------
    // A small HTML overlay names each dancer with its clip's short-name; the page
    // switcher (React) sends {cmd:'setpage'} over this same socket. Nothing here
    // runs in the normal training viewer (previewMode === false).
    let labelStrings: string[] = [];
    let curPage = -1; // -1 so the relay's first page (even 0) triggers the highlight
    const labelEls: HTMLDivElement[] = [];
    const labelLayer = labelLayerRef.current;
    if (previewMode && labelLayer) {
      for (let i = 0; i < 32; i++) {
        const el = document.createElement('div');
        el.style.cssText =
          'position:absolute;transform:translate(-50%,0);white-space:nowrap;' +
          'font:11px/1.2 ui-monospace,Menlo,monospace;color:#cdd6f4;' +
          'background:rgba(15,18,32,0.62);padding:1px 5px;border-radius:4px;' +
          'border:1px solid #232842;display:none;pointer-events:none';
        labelLayer.appendChild(el);
        labelEls.push(el);
      }
    }
    // Send a page switch over the live socket (reads the current `ws` on each call).
    const sendSetPage = (n: number) => {
      try {
        ws?.send(JSON.stringify({ cmd: 'setpage', n }));
      } catch {
        /* socket not open; ignore */
      }
    };
    sendPageRef.current = sendSetPage;
    // Review mode: stream a single clip (index i) into all 12 slots.
    const sendSetClip = (i: number) => {
      try {
        ws?.send(JSON.stringify({ cmd: 'setclip', i }));
      } catch {
        /* socket not open; ignore */
      }
    };
    sendClipRef.current = sendSetClip;
    let lastReviewKey = ''; // de-dupe review-block state pushes (~45 Hz stream)
    let lastReviewFrame = -1; // de-dupe loop-progress pushes to ~10 Hz

    // Transient 'paused while hidden' note (imperative to keep it off React's path).
    let pauseNoteTimer: number | undefined;
    const pauseNote = document.createElement('div');
    pauseNote.textContent = 'resumed — rendering was paused while the tab was hidden';
    pauseNote.style.cssText =
      'position:absolute;top:12px;left:50%;transform:translateX(-50%);display:none;' +
      'font:12px/1.4 ui-monospace,Menlo,monospace;color:#0f1220;background:#e6c15a;' +
      'padding:5px 12px;border-radius:6px;pointer-events:none;z-index:5';
    canvas.parentElement?.appendChild(pauseNote);
    const onVisibility = () => {
      const nowHidden = document.hidden;
      if (!nowHidden && tabHidden) {
        // returned to the tab: reset the dt/pacing clocks and flag the resume note
        lastT = performance.now();
        lastRenderAt = 0;
        playbackInit = false;
        showedResume = true;
      }
      tabHidden = nowHidden;
    };
    document.addEventListener('visibilitychange', onVisibility);

    // ---- three.js stage -----------------------------------------------------
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const sizeToWindow = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    renderer.toneMapping = THREE.NeutralToneMapping;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1220);
    scene.fog = new THREE.Fog(0x0f1220, 10, 26);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);
    camera.position.set(0, 2.7, 7.8);

    // Soft dark-stage lighting: hemi fill + warm key + cool rim (house recipe).
    scene.add(new THREE.HemisphereLight(0xffffff, 0x30364f, 2.0));
    const key = new THREE.DirectionalLight(0xfff6e6, 2.4);
    key.position.set(4, 6, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd0ff, 1.2);
    rim.position.set(-3, 4, -5);
    scene.add(rim);

    // Ground grid + a faint slab beneath it.
    const grid = new THREE.GridHelper(24, 24, 0x3a4270, 0x232842);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    scene.add(grid);
    const slab = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.MeshStandardNodeMaterial({ color: 0x0b0e1a, roughness: 0.95 }),
    );
    slab.rotation.x = -Math.PI / 2;
    slab.position.y = -0.01;
    scene.add(slab);

    // ---- per-dancer skeleton meshes (built lazily once we know K) -----------
    const boneGeo = new THREE.CylinderGeometry(0.03, 0.03, 1, 10);
    const jointGeo = new THREE.SphereGeometry(0.05, 12, 8);
    const padGeo = new THREE.PlaneGeometry(0.22, 0.22); // slightly under 2*PAD_HALF to avoid overlap
    interface Dancer {
      bones: THREE.InstancedMesh;
      joints: THREE.InstancedMesh;
      pads: THREE.Mesh[]; // 4 flat ground quads (DDR targets)
      padMats: THREE.MeshBasicNodeMaterial[];
      padBaseCol: THREE.Color; // pad tint (matches this dancer's hue)
      padHotCol: THREE.Color; // active-pad tint (brighter same hue)
      flashUntil: number[]; // per-pad flash expiry (performance.now ms)
      flashHit: boolean[];
    }
    let dancers: Dancer[] = [];
    let builtK = 0;
    // Active skeleton layout (body count + capsule bones), chosen from the stream's
    // `b`. Defaults to 15-body legacy until the first frame reports otherwise.
    let layout: SkeletonLayout = layoutForBodies(undefined);
    let builtB = layout.nb; // body count the current dancer meshes were built for
    let gridCols = 3; // dancers per row (adapts to K)
    let gridRows = 1;

    const hueOf = (i: number) =>
      DANCER_HUES.length ? DANCER_HUES[i % DANCER_HUES.length] : (i * 0.137) % 1;

    const buildDancers = (k: number) => {
      for (const d of dancers) {
        scene.remove(d.bones, d.joints, ...d.pads);
        d.bones.dispose();
        d.joints.dispose();
        for (const m of d.padMats) m.dispose(); // pads share padGeo; freed at teardown
      }
      dancers = [];
      gridCols = Math.max(1, Math.ceil(Math.sqrt(k)));
      gridRows = Math.ceil(k / gridCols);
      for (let i = 0; i < k; i++) {
        const hue = hueOf(i);
        const boneCol = new THREE.Color().setHSL(hue, 0.55, 0.5);
        const jointCol = new THREE.Color().setHSL(hue, 0.6, 0.68);
        const bones = new THREE.InstancedMesh(
          boneGeo,
          new THREE.MeshStandardNodeMaterial({ color: boneCol, roughness: 0.45, metalness: 0.1 }),
          layout.bones.length,
        );
        const joints = new THREE.InstancedMesh(
          jointGeo,
          new THREE.MeshStandardNodeMaterial({ color: jointCol, roughness: 0.4, metalness: 0.1 }),
          layout.nb,
        );
        bones.frustumCulled = false;
        joints.frustumCulled = false;
        scene.add(bones, joints);
        // DDR pads: unlit quads flat on the ground, hidden until targets arrive.
        const pads: THREE.Mesh[] = [];
        const padMats: THREE.MeshBasicNodeMaterial[] = [];
        for (let p = 0; p < PAD_LOCAL.length; p++) {
          const m = new THREE.MeshBasicNodeMaterial({
            color: 0x223055,
            transparent: true,
            opacity: 0.14,
          });
          const quad = new THREE.Mesh(padGeo, m);
          quad.rotation.x = -Math.PI / 2;
          quad.visible = false;
          scene.add(quad);
          pads.push(quad);
          padMats.push(m);
        }
        dancers.push({
          bones,
          joints,
          pads,
          padMats,
          padBaseCol: new THREE.Color().setHSL(hue, 0.5, 0.55),
          padHotCol: new THREE.Color().setHSL(hue, 0.85, 0.75),
          flashUntil: [0, 0, 0, 0],
          flashHit: [false, false, false, false],
        });
      }
      builtK = k;
      // Review renders a single dancer at the origin; hide the other slots' meshes.
      if (reviewMode) {
        for (let d = 1; d < dancers.length; d++) {
          dancers[d].bones.visible = false;
          dancers[d].joints.visible = false;
        }
        frameCameraReview();
      } else {
        frameCameraForGrid();
      }
    };

    // Where each dancer stands. Review = single dancer parked at the origin; grid
    // preview = a centered grid (cols x rows adapt to K).
    const SLOT_SPACING = 2.3;
    const slotOf = (i: number): [number, number] => {
      if (reviewMode) return [0, 0];
      const col = i % gridCols;
      const row = Math.floor(i / gridCols);
      return [(col - (gridCols - 1) / 2) * SLOT_SPACING, (row - (gridRows - 1) / 2) * SLOT_SPACING];
    };

    // Pull the camera back to frame the whole grid.
    const frameCameraForGrid = () => {
      const w = gridCols * SLOT_SPACING;
      const depth = gridRows * SLOT_SPACING;
      const dist = w * 0.62 + depth * 0.5 + 2.5;
      camera.position.set(0, 1.7 + depth * 0.28, dist);
      camera.updateProjectionMatrix();
      if (controls) {
        controls.target.set(0, 0.85, -depth * 0.05);
        controls.update();
      }
      scene.fog = new THREE.Fog(0x0f1220, dist * 0.7, dist * 3);
    };

    // Review: tight judging shot on the single dancer at the origin (orbit stays on).
    const frameCameraReview = () => {
      camera.position.set(0, 1.35, 3.1);
      camera.updateProjectionMatrix();
      if (controls) {
        controls.target.set(0, 0.9, 0);
        controls.update();
      }
      scene.fog = new THREE.Fog(0x0f1220, 8, 24);
    };

    // scratch objects reused every frame (no per-frame allocation)
    const pA = new THREE.Vector3();
    const pB = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const mat4 = new THREE.Matrix4();
    const idQ = new THREE.Quaternion();
    const jScl = new THREE.Vector3(1, 1, 1);
    const labelPos = new THREE.Vector3(); // scratch: project slot centers to screen
    // per-dancer re-centered joint positions in three-space
    const jointPos: THREE.Vector3[] = Array.from({ length: MAX_BODIES }, () => new THREE.Vector3());

    // Copy a frame's per-body quats into dstQ (used at the clamp/snap returns).
    const copyQ = (f: Frame, dstQ: Float32Array | null): void => {
      if (dstQ && f.quat) dstQ.set(f.quat.subarray(0, Math.min(dstQ.length, f.quat.length)));
    };
    // Slerp per-body quats a->b at t into dstQ (XYZW). Falls back to copying when a
    // frame lacks quats (older relay). Only the VRM dancer reads these.
    const slerpQ = (a: Frame, b: Frame, t: number, kq: number, dstQ: Float32Array | null): void => {
      if (!dstQ) return;
      if (!a.quat || !b.quat) {
        copyQ(a.quat ? a : b, dstQ);
        return;
      }
      const m = Math.min(dstQ.length, a.quat.length, b.quat.length, kq * layout.nb * 4);
      // slerpFlat is typed for number[]; Float32Array is fine at runtime.
      const dstA = dstQ as unknown as number[];
      const aA = a.quat as unknown as number[];
      const bA = b.quat as unknown as number[];
      for (let q = 0; q + 4 <= m; q += 4) {
        THREE.Quaternion.slerpFlat(dstA, q, aA, q, bA, q, t);
      }
    };

    /** Interpolated snapshot into `dst` at time `target`, keyed by `keyOf`
     *  (arrival time in training mode, sim time in 1x). Returns k or 0. Also fills
     *  `dstQ` (optional) with slerped per-body quats for the VRM retarget. */
    const sampleInto = (
      target: number,
      keyOf: (f: Frame) => number,
      dst: Float32Array,
      dstQ: Float32Array | null = null,
    ): number => {
      if (frames.length === 0) return 0;
      let a = frames[0];
      let b = frames[frames.length - 1];
      if (target <= keyOf(a)) {
        dst.set(a.pos.subarray(0, Math.min(dst.length, a.pos.length)));
        copyQ(a, dstQ);
        sampledFrame = a;
        return a.k;
      }
      if (target >= keyOf(b)) {
        dst.set(b.pos.subarray(0, Math.min(dst.length, b.pos.length)));
        copyQ(b, dstQ);
        sampledFrame = b;
        return b.k;
      }
      for (let i = 0; i < frames.length - 1; i++) {
        if (keyOf(frames[i]) <= target && target <= keyOf(frames[i + 1])) {
          a = frames[i];
          b = frames[i + 1];
          break;
        }
      }
      const span = keyOf(b) - keyOf(a) || 1;
      const t = Math.min(1, Math.max(0, (target - keyOf(a)) / span));
      const k = Math.min(a.k, b.k);
      const n = Math.min(dst.length, a.pos.length, b.pos.length, k * layout.nb * 3);
      // If any coordinate jumped hard between these frames, an env reset teleported
      // a dancer -- don't smear across it, just show the newer frame.
      let jump = 0;
      for (let j = 0; j < n; j++) {
        const d = b.pos[j] - a.pos[j];
        if (d > jump) jump = d;
        else if (-d > jump) jump = -d;
      }
      if (jump > SNAP_JUMP) {
        dst.set(b.pos.subarray(0, Math.min(dst.length, b.pos.length)));
        copyQ(b, dstQ);
        sampledFrame = b; // reset: pads + bodies both jump to this frame together
        return b.k;
      }
      for (let j = 0; j < n; j++) dst[j] = a.pos[j] + (b.pos[j] - a.pos[j]) * t;
      slerpQ(a, b, t, k, dstQ);
      sampledFrame = a; // the frame the playhead has reached (owns pads + events)
      return k;
    };
    const keyRecv = (f: Frame) => f.tRecv;
    const keySim = (f: Frame) => f.tSim;

    let snap = new Float32Array(0);
    let snapQ = new Float32Array(0); // slerped per-body quats (k*nb*4, XYZW) for the VRM

    const updateSkeletons = (k: number, snapPos: Float32Array) => {
      const nb = layout.nb;
      const bonePairs = layout.bones;
      for (let d = 0; d < k; d++) {
        const base = d * nb * 3;
        // Bodies arrive in per-env LOCAL frame (the hook subtracts env_origins),
        // so we do NOT re-center on pelvis — we place the env-local coords
        // straight onto the grid slot. This keeps intra-motion root translation
        // and, crucially, keeps feet aligned with the DDR pads (same frame).
        const [sx, sz] = slotOf(d);
        for (let j = 0; j < nb; j++) {
          const o = base + j * 3;
          isaacToThree(snapPos[o + 0], snapPos[o + 1], snapPos[o + 2], jointPos[j]);
          jointPos[j].x += sx;
          jointPos[j].z += sz;
        }
        const dd = dancers[d];
        // joints
        for (let j = 0; j < nb; j++) {
          mat4.compose(jointPos[j], idQ, jScl);
          dd.joints.setMatrixAt(j, mat4);
        }
        dd.joints.instanceMatrix.needsUpdate = true;
        // bones
        for (let bi = 0; bi < bonePairs.length; bi++) {
          pA.copy(jointPos[bonePairs[bi][0]]);
          pB.copy(jointPos[bonePairs[bi][1]]);
          mid.addVectors(pA, pB).multiplyScalar(0.5);
          dir.subVectors(pB, pA);
          const len = dir.length();
          if (len < 1e-5) {
            scl.set(1, 1e-4, 1);
            quat.identity();
          } else {
            dir.multiplyScalar(1 / len);
            quat.setFromUnitVectors(up, dir);
            scl.set(1, len, 1);
          }
          mat4.compose(mid, quat, scl);
          dd.bones.setMatrixAt(bi, mat4);
        }
        dd.bones.instanceMatrix.needsUpdate = true;
      }
    };

    // ---- DDR pads (dormant unless the stream carries a `targets` field) -----
    // All four pads stay clearly visible (they form the DDR cross); the active
    // one brightens to amber as its due time approaches.
    const padHit = new THREE.Color(0x38e08a);
    const padMiss = new THREE.Color(0xe0556a);
    const padCol = new THREE.Color();
    const PAD_BASE_OPACITY = 0.4;
    // scratch for orienting pad quads flat + spun to the cross yaw
    const padFlatQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const padSpinQ = new THREE.Quaternion();
    const padUpAxis = new THREE.Vector3(0, 1, 0);

    // Fire a frame's hit/miss flashes. Called by the playhead's event catch-up as
    // it crosses each frame, so flashes land in sync with the displayed motion.
    const applyFrameEvents = (frame: Frame, nowMs: number) => {
      if (!frame.targets) return;
      for (let d = 0; d < dancers.length && d < frame.targets.length; d++) {
        for (const ev of frame.targets[d].events) {
          if (ev.pad >= 0 && ev.pad < PAD_LOCAL.length) {
            dancers[d].flashUntil[ev.pad] = nowMs + FLASH_MS;
            dancers[d].flashHit[ev.pad] = ev.hit;
          }
        }
      }
    };

    const updatePads = (targets: EnvTarget[] | undefined, nowMs: number) => {
      for (let d = 0; d < dancers.length; d++) {
        const dd = dancers[d];
        const t = targets && d < targets.length ? targets[d] : undefined;
        if (!t) {
          for (const q of dd.pads) q.visible = false;
          continue;
        }
        const [sx, sz] = slotOf(d);
        // The pad cross is rotated to the dancer's facing; spin the flat quads to
        // match (U->D arm gives the yaw) so they read as a crisp cross, not a
        // diamond of axis-aligned squares. In three ground coords: x, z = -y.
        let yaw = 0;
        if (t.padXY) {
          const ax = t.padXY[2][0] - t.padXY[3][0]; // U.x - D.x  (three x)
          const az = -(t.padXY[2][1] - t.padXY[3][1]); // -(U.y - D.y)  (three z)
          if (ax * ax + az * az > 1e-9) yaw = Math.atan2(-az, ax);
        }
        padSpinQ.setFromAxisAngle(padUpAxis, yaw);
        for (let p = 0; p < dd.pads.length; p++) {
          const q = dd.pads[p];
          q.visible = true;
          // Prefer explicit env-local pad centers from the real DDR stream;
          // fall back to canonical offsets around the per-env origin.
          const lx = t.padXY ? t.padXY[p][0] : PAD_LOCAL[p][0] + t.originX;
          const ly = t.padXY ? t.padXY[p][1] : PAD_LOCAL[p][1] + t.originY;
          // Isaac ground (x,y) -> three (x, z=up, -y), then onto the grid slot.
          q.position.set(lx + sx, 0.02, -ly + sz);
          q.quaternion.copy(padSpinQ).multiply(padFlatQ); // flat + spun to the cross
          const mat = dd.padMats[p];
          const flashLeft = dd.flashUntil[p] - nowMs;
          if (flashLeft > 0) {
            padCol.copy(dd.flashHit[p] ? padHit : padMiss);
            mat.color.copy(padCol);
            mat.opacity = 0.5 + 0.45 * (flashLeft / FLASH_MS);
          } else if (p === t.active && Number.isFinite(t.ttd)) {
            // intensify (toward this dancer's bright hue) as due time approaches
            const ramp = Math.min(1, Math.max(0, 1 - t.ttd / t.lead));
            padCol.copy(dd.padBaseCol).lerp(dd.padHotCol, ramp);
            mat.color.copy(padCol);
            mat.opacity = PAD_BASE_OPACITY + 0.55 * ramp;
          } else {
            mat.color.copy(dd.padBaseCol);
            mat.opacity = PAD_BASE_OPACITY;
          }
        }
      }
    };

    // ---- HUD ----------------------------------------------------------------
    let hudAt = 0;
    const setHud = (state: string, color: string, detail: string) => {
      if (!hud) return;
      hud.innerHTML =
        `<span style="color:${color}">● ${state}</span>` +
        `<span style="opacity:.75"> &nbsp; ${detail}</span>`;
    };

    // ---- WebSocket ----------------------------------------------------------
    // Opens a socket to currentWsAddr and wires the handlers. In exp mode the url is
    // resolved from the feed first (connect → resolveThenOpen → openSocket).
    const openSocket = () => {
      if (disposed) return;
      try {
        ws = new WebSocket(currentWsAddr);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        setHud('CONNECTED — waiting for frames', '#8fead0', currentWsAddr);
        // Review mode kicks the source into single-clip mode. On (re)connect, seat
        // it at the clip we're currently on (0 on first load) so a dropped socket
        // doesn't reset the user's position.
        if (reviewMode) sendSetClip(reviewInfoRef.current?.i ?? 0);
      };
      ws.onmessage = (ev) => {
        let msg: {
          type?: string;
          seq: number;
          t: number;
          sim_t?: number;
          step?: number;
          k: number;
          b: number;
          pos: number[];
          quat?: number[];
          targets?: unknown;
          labels?: string[];
          page?: number;
          review?: {
            i: number;
            total: number;
            name: string;
            names?: string[];
            prefiltered?: PreItem[];
            frame?: number;
            frames?: number;
            t?: number;
            dur?: number;
          };
        };
        try {
          msg = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (msg.type !== 'pose' || !Array.isArray(msg.pos)) return;
        // Preview-only additive fields: per-slot clip names + the source's current
        // page (authoritative — corrects any optimistic button highlight).
        if (previewMode) {
          if (Array.isArray(msg.labels)) {
            if (msg.labels.join('|') !== labelStrings.join('|')) {
              labelStrings = msg.labels.map(String);
              for (let i = 0; i < labelEls.length; i++)
                labelEls[i].textContent = labelStrings[i] ?? '';
            }
          }
          if (typeof msg.page === 'number' && msg.page !== curPage) {
            curPage = msg.page;
            setActivePageRef.current(curPage);
          }
          // Review block: which clip we're on + the full surviving name list and the
          // prefiltered-out clips (with stats). De-duped so we don't setState @45 Hz.
          if (reviewMode && msg.review && typeof msg.review === 'object') {
            const r = msg.review;
            const key = `${r.i}|${r.name}|${r.total}`;
            if (key !== lastReviewKey) {
              lastReviewKey = key;
              setReviewInfoRef.current({ i: r.i, total: r.total, name: r.name });
              if (Array.isArray(r.names) && r.names.length)
                setReviewNamesRef.current(r.names.map(String));
              if (Array.isArray(r.prefiltered)) setReviewPrefilteredRef.current(r.prefiltered);
            }
            // Loop progress advances ~10 Hz; push only when the frame index changes.
            if (typeof r.frame === 'number' && r.frame !== lastReviewFrame) {
              lastReviewFrame = r.frame;
              setReviewProgressRef.current({
                frame: r.frame,
                frames: r.frames ?? 0,
                t: r.t ?? 0,
                dur: r.dur ?? 0,
              });
            }
          }
        }
        if (msg.seq === lastSeq) return;
        lastSeq = msg.seq;
        lastRecvAt = performance.now() / 1000;
        // Frames are flowing — the stream is healthy, so reset exp-mode backoff so
        // the next box-cycle reconnect starts fast again (10s) rather than at 60s.
        expBackoff = 10_000;
        // The stream tags each frame with `b` (15 legacy / 21 Miku). Re-pick the
        // skeleton layout and rebuild the meshes when either the env count OR the
        // body count changes (a run swap can change either).
        if (msg.k !== builtK || msg.b !== builtB) {
          layout = layoutForBodies(msg.b);
          builtB = msg.b;
          buildDancers(msg.k);
          snap = new Float32Array(msg.k * layout.nb * 3);
          snapQ = new Float32Array(msg.k * layout.nb * 4);
          vrmDancer?.setBodyCount(layout.nb); // keep the VRM retarget's layout in sync
        }
        // Optional per-body world quats (additive field on the relay). Reorder the
        // stream's WXYZ -> three's XYZW so the slerp/retarget can treat them natively.
        let quatArr: Float32Array | undefined;
        const nq = msg.k * layout.nb * 4;
        if (Array.isArray(msg.quat) && msg.quat.length >= nq) {
          quatArr = new Float32Array(nq);
          for (let i = 0; i < msg.k * layout.nb; i++) {
            const s = i * 4;
            quatArr[s + 0] = msg.quat[s + 1]; // x
            quatArr[s + 1] = msg.quat[s + 2]; // y
            quatArr[s + 2] = msg.quat[s + 3]; // z
            quatArr[s + 3] = msg.quat[s + 0]; // w
          }
        }
        frames.push({
          tRecv: lastRecvAt,
          tWall: msg.t,
          tSim: msg.sim_t ?? lastRecvAt,
          seq: msg.seq,
          step: msg.step ?? 0,
          k: msg.k,
          pos: Float32Array.from(msg.pos),
          quat: quatArr,
          targets: normTargets(msg.targets), // undefined on current (targetless) runs
        });
        // rolling sim-rate window (Δsim/Δwall over ~RATE_WINDOW_S)
        rateSamples.push({ tRecv: lastRecvAt, tSim: msg.sim_t ?? lastRecvAt });
        while (rateSamples.length > 2 && lastRecvAt - rateSamples[0].tRecv > RATE_WINDOW_S)
          rateSamples.shift();
        // keep several seconds of frames (SMOOTH plays ~1 s behind newest)
        while (frames.length > 150) frames.shift();
      };
      ws.onclose = () => {
        ws = null;
        scheduleReconnect();
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    };
    // exp mode: (re)fetch the fleet feed, find our row, re-resolve its ws url (it may
    // have changed because the box cycled), then open. Feed/row/url failures fall
    // through to a backed-off retry with an explanatory HUD.
    const resolveThenOpen = async () => {
      if (disposed) return;
      try {
        const res = await fetch(`${viewerFeedUrl()}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) {
          scheduleReconnect();
          return;
        }
        const data = (await res.json()) as {
          experiments?: { id?: string; ws_local?: string | null; ws_public?: string | null }[];
        };
        if (disposed) return;
        const row = (data.experiments ?? []).find((e) => e && e.id === expId);
        if (!row) {
          setHud('WAITING', '#e6a15a', `waiting for ${expId} to appear in the fleet feed`);
          window.clearTimeout(reconnectTimer);
          reconnectTimer = window.setTimeout(connect, nextExpDelay());
          return;
        }
        const url = wsUrlForRow(row);
        if (!url) {
          setHud('WAITING', '#e6a15a', `no stream url for ${expId} yet — box may be provisioning`);
          window.clearTimeout(reconnectTimer);
          reconnectTimer = window.setTimeout(connect, nextExpDelay());
          return;
        }
        currentWsAddr = url;
      } catch {
        if (disposed) return;
        scheduleReconnect();
        return;
      }
      if (disposed) return;
      openSocket();
    };

    // Consume one step of the exp-mode backoff schedule (10→20→40→60→60…).
    const nextExpDelay = (): number => {
      const delay = expBackoff;
      expBackoff = Math.min(expBackoff * 2, 60_000);
      return delay;
    };

    const connect = () => {
      if (disposed) return;
      if (expMode) {
        void resolveThenOpen();
        return;
      }
      openSocket();
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      window.clearTimeout(reconnectTimer);
      if (expMode) {
        // Box may be cycling — surface it and retry with exponential backoff.
        setHud('RECONNECTING', '#e6a15a', 'stream reconnecting — box may be cycling');
        reconnectTimer = window.setTimeout(connect, nextExpDelay());
        return;
      }
      setHud(
        'NO STREAM',
        '#e6a15a',
        `idle — start pose_relay.py, then a source (run_dance_stream.ps1 or pose_fake_source.py). retrying ${currentWsAddr}…`,
      );
      reconnectTimer = window.setTimeout(connect, 1500);
    };

    // ---- boot + render loop -------------------------------------------------
    let lastT = performance.now();
    // Render-loop throttle: cap at targetFps (frame-skip) and pause entirely while
    // the tab is hidden, so a review/preview tab doesn't steal GPU from the trainer.
    const targetFps = resolveTargetFps();
    const frameInterval = 1000 / targetFps;
    let lastRenderAt = 0;
    let tabHidden = document.hidden;
    let showedResume = false;
    void renderer.init().then(() => {
      if (disposed) return;
      sizeToWindow();
      window.addEventListener('resize', sizeToWindow);
      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.target.set(0, 1.0, 0);
      controls.update();
      connect();

      // Load the VRM avatar for slot `mikuSlot` (unless disabled). On failure the
      // slot keeps its capsule skeleton and the HUD carries a note.
      if (mikuSlot >= 0) {
        vrmDancer = new IsaacVrmDancer(scene, vrmUrl);
        // The socket may already have observed a frame (and switched `layout`)
        // before the VRM finished constructing — adopt the current body count so a
        // 21-body run retargets correctly even if the first frame beat us here.
        vrmDancer.setBodyCount(layout.nb);
        void vrmDancer.load();
      }

      const loop = () => {
        raf = requestAnimationFrame(loop);
        // Pause entirely while the tab is hidden (frees the GPU for the trainer).
        if (tabHidden) return;
        const now = performance.now();
        // Frame-skip to the fps cap. RAF fires ~display Hz; we render only when a
        // full frameInterval has elapsed (tolerance so 30 fps isn't dropped to 20).
        if (now - lastRenderAt < frameInterval - 3) return;
        lastRenderAt = now;
        const dt = Math.min((now - lastT) / 1000, 1 / 15);
        lastT = now;
        // Show a transient 'paused' note the first render after returning to the tab.
        if (showedResume) {
          showedResume = false;
          if (pauseNote) {
            pauseNote.style.display = 'block';
            window.clearTimeout(pauseNoteTimer);
            pauseNoteTimer = window.setTimeout(() => {
              if (pauseNote) pauseNote.style.display = 'none';
            }, 2500);
          }
        }

        // update the rolling sim-rate estimate
        if (rateSamples.length >= 2) {
          const a = rateSamples[0];
          const b = rateSamples[rateSamples.length - 1];
          const wall = b.tRecv - a.tRecv;
          if (wall > 0.2) {
            const r = (b.tSim - a.tSim) / wall;
            if (r > 0.02 && r < 5) rateEst = r;
          }
        }

        if (frames.length && snap.length) {
          const newest = frames[frames.length - 1].tSim;
          const oldest = frames[0].tSim;
          let k: number;
          // Only bother slerping quats when the VRM dancer will consume them.
          const wantQ = vrmDancer && vrmDancer.ready && mikuSlot >= 0 ? snapQ : null;
          if (mode === 'live') {
            // arrival-paced: lowest latency, passes the raw sawtooth through
            playbackInit = false;
            buffering1x = false;
            k = sampleInto(now / 1000 - INTERP_DELAY, keyRecv, snap, wantQ);
          } else if (mode === 'smooth') {
            // SMOOTH paces at the measured sim rate: fluid, but slow-motion when
            // the sim is below 1x. Steers the clock to hold ~BUFFER_S of buffer.
            const bufSim = BUFFER_S * rateEst; // sim-seconds of buffer to hold
            buffering1x = false;
            if (!playbackInit) {
              playbackSim = Math.max(oldest, newest - bufSim);
              playbackInit = true;
            } else {
              playbackSim += dt * rateEst;
              const lag = newest - playbackSim; // sim-seconds behind newest
              playbackSim += (lag - bufSim) * dt * 0.5;
              if (playbackSim > newest) playbackSim = newest; // starved -> hold
              if (playbackSim < newest - 3 * bufSim - 0.5) playbackSim = newest - bufSim;
              if (playbackSim < oldest) playbackSim = oldest;
            }
            k = sampleInto(playbackSim, keySim, snap, wantQ);
          } else {
            // 1X: true real-time, timestamp-paced jitter buffer. Bank PREBUFFER_S
            // of sim-time, then advance the playhead at exactly 1.0 sim-s/wall-s so
            // the dance plays at real speed. On drain (sim slower than 1x) hold and
            // rebuffer; on overflow (sim faster than 1x) snap toward latest.
            if (!playbackInit) {
              playbackSim = oldest;
              playbackInit = true;
              buffering1x = true;
            }
            if (buffering1x) {
              // Hold the current frame until the lead reaches the prebuffer target.
              if (playbackSim < oldest) playbackSim = oldest; // old frames aged out
              if (newest - playbackSim >= PREBUFFER_S) buffering1x = false;
            }
            if (!buffering1x) {
              playbackSim += dt; // true 1x pacing by sim-timestamp
              const lead = newest - playbackSim; // sim-seconds still buffered ahead
              if (lead <= 0) {
                playbackSim = newest; // drained -> hold newest and rebuffer
                buffering1x = true;
              } else if (lead > MAX_LEAD_S) {
                playbackSim = newest - PREBUFFER_S; // sim outran 1x -> bound latency
              }
              if (playbackSim < oldest) playbackSim = oldest; // frames aged out beneath us
            }
            k = sampleInto(playbackSim, keySim, snap, wantQ);
          }
          if (k > 0) updateSkeletons(k, snap);

          // VRM avatar: retarget slot `mikuSlot` and hide that slot's capsule. If the
          // VRM isn't ready (still loading or failed), the capsule shows through.
          if (vrmDancer && mikuSlot < k && mikuSlot < dancers.length) {
            const cap = dancers[mikuSlot];
            if (vrmDancer.ready && k > 0) {
              const [sx, sz] = slotOf(mikuSlot);
              // Pass quats only if the sampled frame actually carried them (new relay)
              // AND twist is enabled; else null -> swing-only (verified fallback).
              // Exact 1:1 drive from the per-body quaternions when available (0.1mm to the physics
              // pose); fall back to swing-only aim if quats are absent or twist is toggled off.
              if (twistEnabled && sampledFrame?.quat) {
                vrmDancer.poseExact(snap, snapQ, mikuSlot, sx, sz);
              } else {
                vrmDancer.update(snap, mikuSlot, sx, sz, dt, null);
              }
              // DEBUG OVERLAY: draw this slot's capsule skeleton ON TOP of the VRM (depth-test off,
              // high render order) so any retargeting mismatch between the physics pose and the VRM is
              // immediately visible. The capsule uses the same (corrected) isaacToThree as the VRM.
              cap.bones.visible = true;
              cap.joints.visible = true;
              cap.bones.renderOrder = 999;
              cap.joints.renderOrder = 999;
              overlayOnTop(cap.bones);
              overlayOnTop(cap.joints);
            } else {
              cap.bones.visible = true;
              cap.joints.visible = true;
            }
          }

          // Camera-on-miku: follow the VRM dancer's pelvis (chest height) so she stays
          // framed. On (re)enable, seat the camera in front of her; then just track the
          // target every frame — the user can still orbit/zoom around her.
          if (mikuCam && controls && mikuSlot < k) {
            const [sx, sz] = slotOf(mikuSlot);
            const base = mikuSlot * layout.nb * 3;
            isaacToThree(snap[base], snap[base + 1], snap[base + 2], pA); // pelvis
            pA.x += sx;
            pA.z += sz;
            pA.y += 0.28; // aim a touch above the pelvis, toward the chest
            if (!mikuCamInit) {
              mikuTarget.copy(pA);
              // Seat in front (+Z is the VRM's facing after rotateVRM0) and slightly up.
              camera.position.set(mikuTarget.x, mikuTarget.y + 0.35, mikuTarget.z + 2.6);
              mikuCamInit = true;
            } else {
              mikuTarget.lerp(pA, 0.15); // smooth the follow so resets don't jolt the cam
            }
            controls.target.copy(mikuTarget);
          }

          // Preview clip labels: project each slot's ground center to screen and
          // park the name just under the dancer's feet (cheap: 12 projections).
          if (previewMode && labelEls.length) {
            const W = window.innerWidth;
            const H = window.innerHeight;
            for (let d = 0; d < labelEls.length; d++) {
              const el = labelEls[d];
              if (d >= k || !labelStrings[d]) {
                el.style.display = 'none';
                continue;
              }
              const [sx, sz] = slotOf(d);
              labelPos.set(sx, -0.05, sz).project(camera);
              if (labelPos.z > 1) {
                el.style.display = 'none';
                continue;
              }
              el.style.display = 'block';
              el.style.left = `${(labelPos.x * 0.5 + 0.5) * W}px`;
              el.style.top = `${(-labelPos.y * 0.5 + 0.5) * H + 6}px`;
            }
          }
        }

        // Pads + hit/miss events follow the DISPLAYED frame (sampledFrame), NOT the
        // newest received one -- otherwise, with SMOOTH playing ~1 s behind, the
        // pads would lead the bodies (glaring at resets). As the playhead advances,
        // fire events for every frame it newly crosses so flashes stay in sync.
        const latest = frames.length ? frames[frames.length - 1] : undefined;
        const disp = sampledFrame;
        if (disp) {
          if (displaySeq === -1) {
            displaySeq = disp.seq;
          } else if (disp.seq !== displaySeq) {
            for (const fr of frames) {
              if (fr.seq > displaySeq && fr.seq <= disp.seq) applyFrameEvents(fr, now);
            }
            displaySeq = disp.seq;
          }
          updatePads(disp.targets, now);
        } else {
          updatePads(undefined, now);
        }

        // HUD refresh ~6 Hz
        if (now - hudAt > 160) {
          hudAt = now;
          const nowS = now / 1000;
          const modeLabel = mode === 'smooth' ? 'SMOOTH' : mode === '1x' ? '1X' : 'LIVE';
          // VRM avatar status suffix (loading / active slot / fallback on failure).
          let mikuNote = '';
          if (mikuSlot >= 0) {
            if (vrmDancer?.failed)
              mikuNote = ` · miku: VRM load failed (capsule) — ${vrmDancer.error ?? ''}`;
            else if (vrmDancer?.ready)
              mikuNote = ` · miku slot ${mikuSlot}${mikuCam ? ' [cam]' : ''} (C frames)`;
            else mikuNote = ' · miku: loading VRM…';
          }
          if (ws && ws.readyState === WebSocket.OPEN) {
            if (latest && nowS - lastRecvAt < 1.0) {
              const latencyMs = Math.max(0, Date.now() / 1000 - latest.tWall) * 1000;
              // 1X plays by sim-time at 1x, so its banked lead in sim-seconds ~= the
              // wall-seconds of playback it can sustain before it must rebuffer.
              const lead1x = Math.max(0, latest.tSim - playbackSim);
              const tail =
                mode === 'live'
                  ? `latency ${latencyMs.toFixed(0)} ms`
                  : mode === '1x'
                    ? `buf ${lead1x.toFixed(1)}s`
                    : `buf ${Math.max(0, (latest.tSim - playbackSim) / Math.max(rateEst, 0.01)).toFixed(1)}s`;
              // While the 1X buffer is (re)filling, flag it amber with a % readout so
              // it's clear the viewer is buffering, not stalled.
              const buffering = mode === '1x' && buffering1x;
              const state = buffering
                ? `BUFFERING ${Math.min(99, Math.round((lead1x / PREBUFFER_S) * 100))}%`
                : 'LIVE';
              setHud(
                state,
                buffering ? '#e6a15a' : '#8fead0',
                `seq ${latest.seq} · ${latest.k} dancers · sim ${rateEst.toFixed(2)}x · ` +
                  `${tail} · ${modeLabel} · ${targetFps}fps (P cycles)${mikuNote}`,
              );
            } else {
              setHud('CONNECTED — stream stalled', '#e6a15a', 'no frames for >1s');
            }
          }
        }

        controls?.update();
        renderer.render(scene, camera);
      };
      loop();
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
      if (e.key === 'p' || e.key === 'P') {
        // cycle SMOOTH -> LIVE -> 1X -> SMOOTH
        mode = mode === 'smooth' ? 'live' : mode === 'live' ? '1x' : 'smooth';
        playbackInit = false;
      }
      if ((e.key === 'c' || e.key === 'C') && mikuSlot >= 0) {
        // toggle camera-on-miku framing; off restores the whole-grid shot
        mikuCam = !mikuCam;
        mikuCamInit = false;
        if (!mikuCam) frameCameraForGrid();
      }
      if (previewMode && !reviewMode && (e.key === '[' || e.key === ']')) {
        // [ / ] cycle the clip page (wrap 0..2), optimistic highlight + send
        const n = e.key === ']' ? (curPage + 1) % 3 : (curPage + 2) % 3;
        curPage = n;
        setActivePageRef.current(n);
        sendSetPage(n);
      }
      if (reviewMode) {
        // y/n vote (auto-advance), space = skip, arrows navigate without voting.
        if (e.key === 'y' || e.key === 'Y') voteRef.current('y');
        else if (e.key === 'n' || e.key === 'N') voteRef.current('n');
        else if (e.key === ' ') {
          e.preventDefault();
          voteRef.current('skip');
        } else if (e.key === 'ArrowLeft') navRef.current(-1);
        else if (e.key === 'ArrowRight') navRef.current(1);
      }
    };
    window.addEventListener('keydown', onKey);
    setHud('CONNECTING…', '#8fb6ea', expMode ? `exp=${expId}` : currentWsAddr);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(pauseNoteTimer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', sizeToWindow);
      document.removeEventListener('visibilitychange', onVisibility);
      pauseNote.remove();
      controls?.dispose();
      vrmDancer?.dispose();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      for (const d of dancers) {
        d.bones.dispose();
        d.joints.dispose();
        for (const m of d.padMats) m.dispose();
      }
      boneGeo.dispose();
      jointGeo.dispose();
      padGeo.dispose();
      renderer.dispose();
    };
  }, [onExit]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0f1220', overflow: 'hidden' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      <div
        ref={hudRef}
        style={{
          position: 'absolute',
          top: 12,
          left: 14,
          font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
          color: '#cdd6f4',
          background: 'rgba(15,18,32,0.72)',
          padding: '6px 10px',
          borderRadius: 6,
          border: '1px solid #232842',
          pointerEvents: 'none',
          maxWidth: '90vw',
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          left: 14,
          font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
          color: '#6b7394',
          pointerEvents: 'none',
        }}
      >
        Isaac Lab live pose viewer · drag to orbit · C frames miku
        {reviewMode ? ' · y/n vote · space skip · ←/→ nav' : previewMode ? ' · [ ] page' : ''} · ESC
        to exit
      </div>
      {previewMode && (
        // HTML overlay: per-dancer clip names (positioned imperatively). Shown in
        // both page and review mode (in review all 12 read the same clip name).
        <div
          ref={labelLayerRef}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
        />
      )}
      {previewMode && !reviewMode && (
        // Clip page switcher — sends {cmd:'setpage'} over the live socket.
        <div
          style={{
            position: 'absolute',
            top: 12,
            right: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
            color: '#cdd6f4',
            background: 'rgba(15,18,32,0.72)',
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #232842',
          }}
        >
          <span style={{ opacity: 0.75 }}>clips page:</span>
          {[0, 1, 2].map((n) => {
            const active = activePage === n;
            return (
              <button
                key={n}
                onClick={() => changePage(n)}
                style={{
                  font: 'inherit',
                  cursor: 'pointer',
                  minWidth: 24,
                  padding: '2px 8px',
                  borderRadius: 5,
                  border: active ? '1px solid #8fead0' : '1px solid #3a4270',
                  background: active ? '#1e6b53' : 'rgba(35,40,66,0.6)',
                  color: active ? '#eafff6' : '#cdd6f4',
                }}
              >
                {n}
              </button>
            );
          })}
        </div>
      )}
      {reviewMode && !finished && (
        <ReviewBar
          info={reviewInfo}
          vote={reviewInfo ? votes[reviewInfo.name] : undefined}
          progress={reviewProgress}
          onVote={voteAndAdvance}
          onNav={navigate}
          onFinish={() => setFinished(true)}
        />
      )}
      {reviewMode && finished && (
        <ReviewResults
          names={reviewNames}
          votes={votes}
          prefiltered={reviewPrefiltered}
          copied={copied}
          onCopy={(text) => {
            void navigator.clipboard?.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
          onBack={() => setFinished(false)}
          onGoto={(i) => gotoClip(i)}
        />
      )}
    </div>
  );
}

const voteLabel = (v?: 'y' | 'n' | 'skip') =>
  v === 'y' ? 'Y' : v === 'n' ? 'N' : v === 'skip' ? 'skip' : '—';

/** Bottom review bar: big clip name, counter, vote + navigation controls. */
function ReviewBar({
  info,
  vote,
  progress,
  onVote,
  onNav,
  onFinish,
}: {
  info: { i: number; total: number; name: string } | null;
  vote?: 'y' | 'n' | 'skip';
  progress: { frame: number; frames: number; t: number; dur: number } | null;
  onVote: (v: 'y' | 'n' | 'skip') => void;
  onNav: (d: number) => void;
  onFinish: () => void;
}) {
  const frac = progress && progress.frames > 0 ? progress.frame / progress.frames : 0;
  const btn = (active: boolean, accent: string): CSSProperties => ({
    font: 'inherit',
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 6,
    border: active ? `1px solid ${accent}` : '1px solid #3a4270',
    background: active ? accent : 'rgba(35,40,66,0.7)',
    color: active ? '#0f1220' : '#cdd6f4',
    fontWeight: active ? 700 : 400,
  });
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 44,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        font: '13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#cdd6f4',
        background: 'rgba(15,18,32,0.85)',
        padding: '10px 14px',
        borderRadius: 10,
        border: '1px solid #232842',
      }}
    >
      <button onClick={() => onNav(-1)} style={btn(false, '#8fb6ea')} title="previous (←)">
        ◀
      </button>
      <div style={{ minWidth: 240, textAlign: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#eafff6' }}>{info?.name ?? '…'}</div>
        <div style={{ opacity: 0.7, fontSize: 11 }}>
          clip {info ? info.i + 1 : '–'} / {info?.total ?? '–'}
          {vote ? ` · voted ${voteLabel(vote)}` : ''}
        </div>
        {/* Loop progress within the clip (position + wrap awareness). */}
        <div
          style={{
            marginTop: 5,
            height: 4,
            borderRadius: 2,
            background: '#232842',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.round(frac * 100)}%`,
              height: '100%',
              background: '#8fb6ea',
              transition: 'width 0.1s linear',
            }}
          />
        </div>
        <div style={{ opacity: 0.55, fontSize: 10, marginTop: 2 }}>
          {progress ? `${progress.t.toFixed(1)} / ${progress.dur.toFixed(1)} s` : '– / – s'}
        </div>
      </div>
      <button onClick={() => onVote('y')} style={btn(vote === 'y', '#38e08a')} title="keep (y)">
        Y keep
      </button>
      <button onClick={() => onVote('n')} style={btn(vote === 'n', '#e0556a')} title="drop (n)">
        N drop
      </button>
      <button
        onClick={() => onVote('skip')}
        style={btn(vote === 'skip', '#c9b45a')}
        title="skip (space)"
      >
        skip
      </button>
      <button onClick={() => onNav(1)} style={btn(false, '#8fb6ea')} title="next (→)">
        ▶
      </button>
      <button onClick={onFinish} style={btn(false, '#8fb6ea')} title="finish & show results">
        finish
      </button>
    </div>
  );
}

/** End-state results: votes table, prefiltered table, and a pasteable text block. */
function ReviewResults({
  names,
  votes,
  prefiltered,
  copied,
  onCopy,
  onBack,
  onGoto,
}: {
  names: string[];
  votes: Record<string, 'y' | 'n' | 'skip'>;
  prefiltered: { name: string; diag: number; med_speed: number; p90_speed: number }[];
  copied: boolean;
  onCopy: (text: string) => void;
  onBack: () => void;
  onGoto: (i: number) => void;
}) {
  const counts = names.reduce(
    (a, n) => {
      const v = votes[n];
      if (v === 'y') a.y++;
      else if (v === 'n') a.n++;
      else if (v === 'skip') a.skip++;
      else a.none++;
      return a;
    },
    { y: 0, n: 0, skip: 0, none: 0 },
  );
  const resultLines = names.map((n) => `${n}: ${voteLabel(votes[n])}`);
  const preLines = prefiltered.map(
    (p) =>
      `${p.name}: PREFILTERED (diag ${p.diag}m, med ${p.med_speed} m/s, p90 ${p.p90_speed} m/s)`,
  );
  const text = [
    '# clip review results',
    ...resultLines,
    '',
    '# prefiltered (auto-excluded travelers — override by name if wanted)',
    ...preLines,
  ].join('\n');
  const cell: CSSProperties = { padding: '2px 8px', borderBottom: '1px solid #232842' };
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(8,10,18,0.6)',
      }}
    >
      <div
        style={{
          width: 'min(680px, 92vw)',
          maxHeight: '88vh',
          overflow: 'auto',
          background: 'rgba(15,18,32,0.97)',
          border: '1px solid #2b3358',
          borderRadius: 12,
          padding: 18,
          font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
          color: '#cdd6f4',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#eafff6' }}>Clip review results</div>
          <div style={{ opacity: 0.8 }}>
            {names.length} reviewed · Y {counts.y} · N {counts.n} · skip {counts.skip} · unvoted{' '}
            {counts.none}
          </div>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', margin: '12px 0' }}>
          <tbody>
            {names.map((n, i) => {
              const v = votes[n];
              const col =
                v === 'y'
                  ? '#38e08a'
                  : v === 'n'
                    ? '#e0556a'
                    : v === 'skip'
                      ? '#c9b45a'
                      : '#6b7394';
              return (
                <tr key={n}>
                  <td style={{ ...cell, opacity: 0.5, width: 28 }}>{i + 1}</td>
                  <td style={cell}>
                    <button
                      onClick={() => onGoto(i)}
                      style={{
                        font: 'inherit',
                        background: 'none',
                        border: 'none',
                        color: '#8fb6ea',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                      title="re-review this clip"
                    >
                      {n}
                    </button>
                  </td>
                  <td style={{ ...cell, color: col, fontWeight: 700 }}>{voteLabel(v)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {prefiltered.length > 0 && (
          <>
            <div style={{ fontWeight: 700, color: '#e6a15a', margin: '8px 0 4px' }}>
              prefiltered — auto-excluded travelers ({prefiltered.length})
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
              <tbody>
                {prefiltered.map((p) => (
                  <tr key={p.name}>
                    <td style={cell}>{p.name}</td>
                    <td style={{ ...cell, opacity: 0.8 }}>
                      diag {p.diag}m · med {p.med_speed} · p90 {p.p90_speed} m/s
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <textarea
          readOnly
          value={text}
          style={{
            width: '100%',
            height: 160,
            background: '#0b0e1a',
            color: '#cdd6f4',
            border: '1px solid #232842',
            borderRadius: 6,
            font: '11px/1.4 ui-monospace, monospace',
            padding: 8,
            resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            onClick={() => onCopy(text)}
            style={{
              font: 'inherit',
              cursor: 'pointer',
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid #8fead0',
              background: copied ? '#1e6b53' : 'rgba(35,40,66,0.7)',
              color: '#eafff6',
            }}
          >
            {copied ? 'copied!' : 'copy to clipboard'}
          </button>
          <button
            onClick={onBack}
            style={{
              font: 'inherit',
              cursor: 'pointer',
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid #3a4270',
              background: 'rgba(35,40,66,0.7)',
              color: '#cdd6f4',
            }}
          >
            back to review
          </button>
        </div>
      </div>
    </div>
  );
}
