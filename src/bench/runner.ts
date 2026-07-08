/**
 * Render-benchmark runner. Drives the real chart-parse → Judge → WebGPU
 * note-field path against synthetic stress charts (benchChart.ts) on a
 * full-viewport canvas, with an autoplayer firing perfect hits so explosions,
 * judgments, combo pops and hold engagement all render like real gameplay.
 *
 * Each measured (rAF) frame records what the player actually experiences:
 *  - frame-to-frame deltas (fps / p95 / missed). Normally vsync-bound, so FPS
 *    tops out at the display refresh; run the driver with vsync disabled
 *    (--disable-gpu-vsync --disable-frame-rate-limit) for the true uncapped
 *    presented frame rate.
 *  - CPU draw time (main-thread encode/record) per frame.
 *  - GPU ms per PRESENTED frame, via WebGPU timestamp queries on the render
 *    pass (gpuTimer.ts) — the real GPU cost of what's on screen, which is what
 *    drives headroom.
 *
 * The runner owns its canvases (created inside a caller-provided container)
 * because a canvas element can hold only one context type ever — each
 * scenario gets fresh elements.
 */

import type { NoteSkin } from '../game/playOptions';
import { Judge } from '../gameplay/judge';
import { TapNoteScore, TapNoteType } from '../notes/noteTypes';
import { parseSimfile } from '../parse/loader';
import type { Feedback } from '../render/fieldConfig';
import { beatTimes, GpuNoteField } from '../render/gpu/gpuNoteField';
import { makeBenchSsc, type BenchChartOpts } from './benchChart';

export interface BenchScenario {
  id: string;
  label: string;
  /** Which note-field renderer draws the scenario (default canvas). */
  backend?: 'canvas' | 'webgpu';
  noteSkin: NoteSkin;
  chart: BenchChartOpts;
  /** X-mod multiplier (lower = more notes on screen at once). */
  scrollValue: number;
  /** Pin the life gauge each frame (≤0.25 forces the arcade DANGER chrome). */
  life?: number;
  /** Composite a full-screen background image behind the field. */
  bgImage?: boolean;
  /** Seconds of measured rAF time (default 5). */
  seconds?: number;
}

/** Chart used by every stress scenario, so skins/layers compare like-for-like. */
const STRESS_CHART: BenchChartOpts = {
  bpm: 200,
  measures: 32,
  jumpEveryBeats: 1,
  holdEveryBeats: 2,
  holdLenBeats: 1.5,
  rollEveryNth: 3,
  mineEveryBeats: 1,
};

export const BENCH_SCENARIOS: BenchScenario[] = [
  {
    id: 'gpu-arcade-typical',
    label: 'WEBGPU · TYPICAL CHART',
    backend: 'webgpu',
    noteSkin: 'arcade',
    chart: { bpm: 175, measures: 28, jumpEveryBeats: 2, holdEveryBeats: 4, holdLenBeats: 1 },
    scrollValue: 2.5,
  },
  {
    id: 'gpu-arcade-stress',
    label: 'WEBGPU · STRESS + DANGER',
    backend: 'webgpu',
    noteSkin: 'arcade',
    chart: STRESS_CHART,
    scrollValue: 1,
    life: 0.12,
  },
  {
    id: 'gpu-arcade-stress-bgimage',
    label: 'WEBGPU · STRESS + BG IMAGE',
    backend: 'webgpu',
    noteSkin: 'arcade',
    chart: STRESS_CHART,
    scrollValue: 1,
    bgImage: true,
  },
  {
    id: 'gpu-itg-stress',
    label: 'WEBGPU · ITG · STRESS',
    backend: 'webgpu',
    noteSkin: 'itg',
    chart: STRESS_CHART,
    scrollValue: 1,
  },
];

export interface FrameStats {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface ScenarioResult {
  id: string;
  label: string;
  /** Present (with a reason) when the scenario could not run. */
  skipped?: string;
  frames: number;
  seconds: number;
  fps: number;
  /** rAF frame-to-frame deltas, ms. */
  frameMs: FrameStats;
  /** % of measured frames that overran 1.5× the display refresh interval. */
  missedPct: number;
  /** CPU time inside renderer.draw() per frame, ms (main-thread encode). */
  drawCpuMs: FrameStats;
  /** Real GPU time per presented frame, ms (WebGPU timestamp query). null when
   *  timestamps are unavailable. */
  gpuMs: FrameStats | null;
  /** GC pauses observed during the window (heap-size drops between frames) —
   *  each is a potential stutter; the leading indicator of per-frame allocation
   *  churn. Requires --enable-precise-memory-info; null otherwise. */
  gcCount: number | null;
  /** Bytes allocated per measured frame (heap rises summed / frames). */
  allocPerFrame: number | null;
}

export interface DeviceInfo {
  userAgent: string;
  hardwareConcurrency: number;
  devicePixelRatio: number;
  screen: { width: number; height: number };
  /** UNMASKED_RENDERER_WEBGL — identifies the actual GPU / SwiftShader. */
  webglRenderer: string | null;
  webgpu: { vendor: string; architecture: string; device: string; description: string } | null;
}

export interface BenchResult {
  schema: 1;
  app: 'stepzone-render-bench';
  when: string;
  device: DeviceInfo;
  view: { width: number; height: number; dpr: number };
  refreshHz: number;
  scenarios: ScenarioResult[];
}

export interface BenchProgress {
  scenarioIndex: number;
  scenarioCount: number;
  label: string;
  phase: 'warmup' | 'measure';
  liveFps: number;
}

export interface RunOptions {
  /** Full-viewport element the runner creates its canvases inside. */
  container: HTMLElement;
  onProgress?: (p: BenchProgress) => void;
  signal?: AbortSignal;
  scenarios?: BenchScenario[];
}

const WARMUP_SECONDS = 0.8;
const MEASURE_SECONDS = 5;
/** Song-seconds at rAF start — drops the runner mid-stream immediately. */
const START_OFFSET_SECONDS = 2;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Benchmark cancelled', 'AbortError');
}

function nextFrame(signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal);
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function stats(samples: number[]): FrameStats {
  if (samples.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { avg, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] };
}

/** Median rAF delta with nothing rendering — the display refresh interval. */
async function measureRefreshMs(signal?: AbortSignal): Promise<number> {
  const deltas: number[] = [];
  let prev = await nextFrame(signal);
  // ~40 frames or 700ms, whichever first; enough for a stable median.
  const t0 = performance.now();
  while (deltas.length < 40 && performance.now() - t0 < 700) {
    const t = await nextFrame(signal);
    deltas.push(t - prev);
    prev = t;
  }
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)] || 16.7;
  return Math.max(2, Math.min(50, median));
}

/** Colorful deterministic 1920×1080 bitmap standing in for song background art. */
function makeBgBitmap(): ImageBitmap | null {
  try {
    const c = new OffscreenCanvas(1920, 1080);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const g = ctx.createLinearGradient(0, 0, 1920, 1080);
    g.addColorStop(0, '#2a1a5e');
    g.addColorStop(0.5, '#173a5e');
    g.addColorStop(1, '#5e1a3a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1920, 1080);
    for (let i = 0; i < 60; i++) {
      const x = (i * 397) % 1920;
      const y = (i * 251) % 1080;
      ctx.fillStyle = `hsla(${(i * 47) % 360},70%,60%,0.25)`;
      ctx.beginPath();
      ctx.arc(x, y, 40 + (i % 7) * 30, 0, Math.PI * 2);
      ctx.fill();
    }
    return c.transferToImageBitmap();
  } catch {
    return null;
  }
}

async function collectWebgpuInfo(): Promise<DeviceInfo['webgpu']> {
  try {
    if (!navigator.gpu) return null;
    const adapter = await Promise.race([
      navigator.gpu.requestAdapter(),
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ]);
    if (!adapter) return null;
    const info = adapter.info;
    return {
      vendor: info?.vendor ?? '',
      architecture: info?.architecture ?? '',
      device: info?.device ?? '',
      description: info?.description ?? '',
    };
  } catch {
    return null;
  }
}

export async function collectDeviceInfo(): Promise<DeviceInfo> {
  let webglRenderer: string | null = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      webglRenderer = dbg
        ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
        : String(gl.getParameter(gl.RENDERER));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    webglRenderer = null;
  }
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
    devicePixelRatio: window.devicePixelRatio || 1,
    screen: { width: screen.width, height: screen.height },
    webglRenderer,
    webgpu: await collectWebgpuInfo(),
  };
}

/** Autoplayer: perfect-hits every tap/hold head as its time passes, keeps
 *  holds engaged through their tails, and lets mines/rolls run their course —
 *  so judgments, combo, explosions and hold states all animate like play. */
class Autoplayer {
  private cursor = 0;
  private readonly heldUntil: number[];
  readonly held: boolean[];

  constructor(
    private readonly judge: Judge,
    numTracks: number,
    private readonly fb: Feedback,
  ) {
    this.heldUntil = new Array<number>(numTracks).fill(-1);
    this.held = new Array<boolean>(numTracks).fill(false);
  }

  tick(now: number): void {
    const notes = this.judge.notes;
    while (this.cursor < notes.length && notes[this.cursor].time <= now) {
      const n = notes[this.cursor++];
      if (!n.judgable || n.note.type === TapNoteType.Mine) continue; // mines scroll through
      this.fb.laneFlash[n.track] = n.time;
      const ev = this.judge.step(n.track, n.time, false);
      if (ev && ev.tns !== TapNoteScore.None && ev.tns !== TapNoteScore.HitMine) {
        this.fb.laneHit[n.track] = { tns: ev.tns, atSeconds: n.time };
        this.fb.lastJudgment = { tns: ev.tns, atSeconds: n.time };
      }
      if (n.isHold && !n.isRoll) this.heldUntil[n.track] = n.tailTime;
    }
    for (let t = 0; t < this.held.length; t++) this.held[t] = this.heldUntil[t] >= now;
    this.judge.update(now, this.held);
  }
}

interface Scene {
  judge: Judge;
  fb: Feedback;
  auto: Autoplayer;
  beatOf: (t: number) => number;
  endSeconds: number;
  /** Render one frame (autoplay/judging already ticked by the caller). */
  render: (now: number, beat: number, progress: number) => void;
  /** Real GPU-time-per-frame plumbing (gpuTimer.ts); absent when timestamps
   *  are unavailable. */
  gpu?: {
    reset: () => void;
    /** Await pending timestamp readbacks, then return the collected GPU ms. */
    read: () => Promise<number[]>;
  };
  cleanup: () => void;
}

function makeCanvas(container: HTMLElement): {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  dpr: number;
} {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  container.appendChild(canvas);
  const width = container.clientWidth || 1280;
  const height = container.clientHeight || 720;
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  return { canvas, width, height, dpr };
}

const BENCH_META = {
  title: 'RENDER BENCHMARK',
  subtitle: 'stepzone',
  difficulty: 'DANCE-SINGLE · BENCH 20',
};

/** Build the judge/feedback/autoplay core plus a backend-specific render fn.
 *  Returns null when the scenario's backend can't run here (reason attached). */
async function buildScene(
  scn: BenchScenario,
  container: HTMLElement,
): Promise<Scene | { skipped: string }> {
  const song = parseSimfile(makeBenchSsc(scn.chart), 'bench.ssc');
  const chart = song.charts[0];
  const timing = chart.getTimingData(song.timing);
  const judge = new Judge(chart.getNoteData(), timing);
  const fb: Feedback = {
    lastJudgment: null,
    laneFlash: new Array<number>(4).fill(-999),
    laneHit: new Array<Feedback['laneHit'][number]>(4).fill(null),
  };
  let end = 0;
  for (const n of judge.notes) end = Math.max(end, n.tailTime);

  const bg = scn.bgImage ? makeBgBitmap() : null;
  if (scn.bgImage && !bg) return { skipped: 'OffscreenCanvas unavailable' };

  const common = {
    judge,
    fb,
    auto: new Autoplayer(judge, 4, fb),
    beatOf: (t: number) => timing.getBeatFromElapsedTime(t),
    endSeconds: Math.max(1, end),
  };

  const { canvas, width, height, dpr } = makeCanvas(container);
  const field = await GpuNoteField.create(canvas, 4, {
    scrollMode: 'X',
    scrollValue: scn.scrollValue,
    songMaxBpm: scn.chart.bpm,
    meta: BENCH_META,
    noteSkin: scn.noteSkin,
  });
  if (!field) {
    canvas.remove();
    return { skipped: 'WebGPU unavailable' };
  }
  field.resize(width, height, dpr);
  const lastBeat = judge.notes.length ? judge.notes[judge.notes.length - 1].beat : 0;
  field.setBeatTimes(beatTimes((bt) => timing.getElapsedTimeFromBeat(bt), lastBeat));
  if (bg) field.setBackground(bg);
  field.prewarm(); // bake atlas + compile pipelines before the measured window
  return {
    ...common,
    render: (now, beat, progress) => field.draw(judge, now, beat, progress, fb),
    gpu: field.gpuTimingAvailable
      ? {
          reset: () => field.resetGpuTimes(),
          read: async () => {
            await field.gpuIdle(); // flush pending timestamp readbacks
            await new Promise((r) => setTimeout(r, 0)); // let mapAsync callbacks run
            return field.gpuFrameTimes();
          },
        }
      : undefined,
    cleanup: () => {
      field.destroy();
      bg?.close();
      canvas.remove();
    },
  };
}

async function runScenario(
  scn: BenchScenario,
  index: number,
  count: number,
  refreshMs: number,
  opts: RunOptions,
): Promise<ScenarioResult> {
  const base: Omit<
    ScenarioResult,
    | 'frames'
    | 'seconds'
    | 'fps'
    | 'frameMs'
    | 'missedPct'
    | 'drawCpuMs'
    | 'gpuMs'
    | 'gcCount'
    | 'allocPerFrame'
  > = {
    id: scn.id,
    label: scn.label,
  };
  const skippedResult = (reason: string): ScenarioResult => ({
    ...base,
    skipped: reason,
    frames: 0,
    seconds: 0,
    fps: 0,
    frameMs: stats([]),
    missedPct: 0,
    drawCpuMs: stats([]),
    gpuMs: null,
    gcCount: null,
    allocPerFrame: null,
  });

  const built = await buildScene(scn, opts.container);
  if ('skipped' in built) {
    return skippedResult(built.skipped);
  }
  const scene = built;

  try {
    const measureSeconds = scn.seconds ?? MEASURE_SECONDS;
    const frameDeltas: number[] = [];
    const drawTimes: number[] = [];
    let measuring = false;
    let measureStartWall = 0;
    let lastProgressAt = 0;
    let songNow = START_OFFSET_SECONDS;
    // Heap sampling: with --enable-precise-memory-info, usedJSHeapSize is exact,
    // so a drop between frames is a GC and a rise is bytes allocated that frame.
    const heapOf = (): number =>
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
      0;
    const heapAvail = heapOf() > 0;
    let prevHeap = 0;
    let gcCount = 0;
    let allocBytes = 0;

    const drawOnce = (now: number): number => {
      scene.auto.tick(now);
      if (scn.life !== undefined) scene.judge.life = scn.life;
      const beat = scene.beatOf(now);
      const progress = Math.min(1, now / scene.endSeconds);
      const d0 = performance.now();
      scene.render(now, beat, progress);
      return performance.now() - d0;
    };

    // --- rAF phase: warmup, then measure ------------------------------------
    const wall0 = await nextFrame(opts.signal);
    let prevWall = wall0;
    for (;;) {
      const wall = await nextFrame(opts.signal);
      const delta = wall - prevWall;
      prevWall = wall;
      songNow = START_OFFSET_SECONDS + (wall - wall0) / 1000;
      const drawMs = drawOnce(songNow);

      if (!measuring && wall - wall0 >= WARMUP_SECONDS * 1000) {
        measuring = true;
        measureStartWall = wall;
        prevHeap = heapOf(); // baseline after warmup allocations have settled
        scene.gpu?.reset(); // start GPU-time collection at the measure window
      } else if (measuring) {
        frameDeltas.push(delta);
        drawTimes.push(drawMs);
        if (heapAvail) {
          const h = heapOf();
          const d = h - prevHeap;
          if (d < 0) gcCount++;
          else allocBytes += d;
          prevHeap = h;
        }
        if (wall - measureStartWall >= measureSeconds * 1000) break;
      }

      if (opts.onProgress && wall - lastProgressAt > 400) {
        lastProgressAt = wall;
        const recent = frameDeltas.slice(-60);
        const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : delta;
        opts.onProgress({
          scenarioIndex: index,
          scenarioCount: count,
          label: scn.label,
          phase: measuring ? 'measure' : 'warmup',
          liveFps: avg > 0 ? 1000 / avg : 0,
        });
      }
    }

    const frames = frameDeltas.length;
    const drawStats = stats(drawTimes);

    // Real GPU time per presented frame (WebGPU timestamp query), drained after
    // the measured window so the last readbacks land. null → no GPU timing.
    const gpuTimes = scene.gpu ? await scene.gpu.read() : [];
    const gpuMs = gpuTimes.length ? stats(gpuTimes) : null;

    const measuredSeconds = (prevWall - measureStartWall) / 1000;
    return {
      ...base,
      frames,
      seconds: measuredSeconds,
      fps: frames / measuredSeconds,
      frameMs: stats(frameDeltas),
      missedPct:
        (100 * frameDeltas.filter((d) => d > 1.5 * refreshMs).length) /
        Math.max(1, frameDeltas.length),
      drawCpuMs: drawStats,
      gpuMs,
      gcCount: heapAvail ? gcCount : null,
      allocPerFrame: heapAvail ? allocBytes / Math.max(1, frames) : null,
    };
  } finally {
    scene.cleanup();
  }
}

export async function runBenchmark(opts: RunOptions): Promise<BenchResult> {
  const scenarios = opts.scenarios ?? BENCH_SCENARIOS;
  // Text sprites bake against the loaded web fonts; wait so a mid-run font
  // arrival doesn't invalidate every sprite cache and skew one scenario.
  await document.fonts.ready.catch(() => undefined);
  const device = await collectDeviceInfo();
  const refreshMs = await measureRefreshMs(opts.signal);

  const results: ScenarioResult[] = [];
  for (let i = 0; i < scenarios.length; i++) {
    throwIfAborted(opts.signal);
    results.push(await runScenario(scenarios[i], i, scenarios.length, refreshMs, opts));
  }

  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  return {
    schema: 1,
    app: 'stepzone-render-bench',
    when: new Date().toISOString(),
    device,
    view: {
      width: opts.container.clientWidth || 0,
      height: opts.container.clientHeight || 0,
      dpr,
    },
    refreshHz: 1000 / refreshMs,
    scenarios: results,
  };
}
