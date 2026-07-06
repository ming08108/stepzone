/**
 * Render-benchmark runner. Drives the real chart-parse → Judge →
 * NoteFieldRenderer path against synthetic stress charts (benchChart.ts) on a
 * full-viewport canvas, with an autoplayer firing perfect hits so explosions,
 * judgments, combo pops and hold engagement all render like real gameplay.
 *
 * Each scenario measures two things:
 *  - rAF phase (ground truth): frame-to-frame deltas under vsync — what the
 *    player actually experiences — plus the CPU cost of every draw() call and
 *    a per-theme-pass breakdown (bench/instrument.ts).
 *  - saturation phase: back-to-back draws with no vsync wait — a CPU
 *    throughput ceiling (draws/sec). Canvas rasterizes in the browser's GPU
 *    process, so this is a command-recording proxy, not total GPU cost; the
 *    rAF numbers are the honest end-to-end signal.
 *
 * The runner owns its canvases (created inside a caller-provided container)
 * because a canvas element can hold only one context type ever — each
 * scenario gets fresh elements so 2D and WebGPU backends can't collide.
 */

import type { NoteSkin } from '../game/playOptions';
import { Judge } from '../gameplay/judge';
import { TapNoteScore, TapNoteType } from '../notes/noteTypes';
import { parseSimfile } from '../parse/loader';
import { NoteFieldRenderer, type Feedback } from '../render/noteField';
import { GpuNoteField } from '../render/gpu/gpuNoteField';
import { makeBenchSsc, type BenchChartOpts } from './benchChart';
import { emptyPassTotals, instrumentTheme, type PassKey, type PassTotals } from './instrument';

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
    id: 'arcade-typical',
    label: 'ARCADE · TYPICAL CHART',
    noteSkin: 'arcade',
    chart: { bpm: 175, measures: 28, jumpEveryBeats: 2, holdEveryBeats: 4, holdLenBeats: 1 },
    scrollValue: 2.5,
  },
  {
    id: 'arcade-stress',
    label: 'ARCADE · STRESS + DANGER',
    noteSkin: 'arcade',
    chart: STRESS_CHART,
    scrollValue: 1,
    life: 0.12,
  },
  {
    id: 'itg-stress',
    label: 'ITG · STRESS',
    noteSkin: 'itg',
    chart: STRESS_CHART,
    scrollValue: 1,
  },
  {
    id: 'arcade-stress-bgimage',
    label: 'ARCADE · STRESS + BG IMAGE',
    noteSkin: 'arcade',
    chart: STRESS_CHART,
    scrollValue: 1,
    bgImage: true,
  },
  // The same suite on the WebGPU note field (arcade skin only in v1).
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
  /** CPU time inside renderer.draw() per frame, ms. */
  drawCpuMs: FrameStats;
  /** Back-to-back draws per second with no vsync wait (CPU ceiling). */
  satDrawsPerSec: number;
  /** Average CPU ms/frame per theme pass; 'other' = background + cull + loop. */
  passes: Record<PassKey | 'other', number>;
  /** Average sprites drawn per frame in the note passes (density check). */
  avgTapsPerFrame: number;
  avgHoldsPerFrame: number;
  avgMinesPerFrame: number;
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
  phase: 'warmup' | 'measure' | 'saturate';
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
const SATURATE_WALL_MS = 1000;
const SATURATE_MAX_DRAWS = 2400;
const SATURATE_STEP_SECONDS = 1 / 240;
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
  passTotals: PassTotals;
  passCounts: PassTotals;
  beatOf: (t: number) => number;
  endSeconds: number;
  /** Render one frame (autoplay/judging already ticked by the caller). */
  render: (now: number, beat: number, progress: number) => void;
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

  const passTotals = emptyPassTotals();
  const passCounts = emptyPassTotals();
  const bg = scn.bgImage ? makeBgBitmap() : null;
  if (scn.bgImage && !bg) return { skipped: 'OffscreenCanvas unavailable' };

  const common = {
    judge,
    fb,
    auto: new Autoplayer(judge, 4, fb),
    passTotals,
    passCounts,
    beatOf: (t: number) => timing.getBeatFromElapsedTime(t),
    endSeconds: Math.max(1, end),
  };

  if (scn.backend === 'webgpu') {
    if (scn.noteSkin !== 'arcade') return { skipped: 'GPU field is arcade-skin only' };
    const { canvas, width, height, dpr } = makeCanvas(container);
    const field = await GpuNoteField.create(canvas, 4, {
      scrollMode: 'X',
      scrollValue: scn.scrollValue,
      songMaxBpm: scn.chart.bpm,
      meta: BENCH_META,
    });
    if (!field) {
      canvas.remove();
      return { skipped: 'WebGPU unavailable' };
    }
    field.resize(width, height, dpr);
    if (bg) field.setBackground(bg);
    return {
      ...common,
      render: (now, beat, progress) => field.draw(judge, now, beat, progress, fb),
      cleanup: () => {
        field.destroy();
        bg?.close();
        canvas.remove();
      },
    };
  }

  const { canvas, width, height, dpr } = makeCanvas(container);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return { skipped: '2D canvas context unavailable' };
  }
  const renderer = new NoteFieldRenderer(4, {
    noteSkin: scn.noteSkin,
    scrollMode: 'X',
    scrollValue: scn.scrollValue,
    songMaxBpm: scn.chart.bpm,
    meta: BENCH_META,
    wrapTheme: (theme) => {
      const counting = instrumentTheme(theme, passTotals);
      // Also count note-pass calls so results record on-screen density.
      const bump =
        <A extends unknown[]>(key: PassKey, fn: (...args: A) => void) =>
        (...args: A) => {
          passCounts[key] += 1;
          fn(...args);
        };
      return {
        ...counting,
        drawTapNote: bump('taps', counting.drawTapNote),
        drawHoldBody: bump('holds', counting.drawHoldBody),
        drawMine: bump('mines', counting.drawMine),
      };
    },
  });
  renderer.resize(width, height, dpr);
  if (bg) renderer.setBackground(bg);

  return {
    ...common,
    render: (now, beat, progress) => {
      renderer.draw(ctx, judge, now, beat, progress, fb);
    },
    cleanup: () => {
      bg?.close();
      canvas.remove();
    },
  };
}

function zeroPasses(p: PassTotals): void {
  for (const k of Object.keys(p) as PassKey[]) p[k] = 0;
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
    'frames' | 'seconds' | 'fps' | 'frameMs' | 'missedPct' | 'drawCpuMs' | 'satDrawsPerSec'
  > & { passes: Record<PassKey | 'other', number> } = {
    id: scn.id,
    label: scn.label,
    passes: { ...emptyPassTotals(), other: 0 },
    avgTapsPerFrame: 0,
    avgHoldsPerFrame: 0,
    avgMinesPerFrame: 0,
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
    satDrawsPerSec: 0,
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
        zeroPasses(scene.passTotals);
        zeroPasses(scene.passCounts);
      } else if (measuring) {
        frameDeltas.push(delta);
        drawTimes.push(drawMs);
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
    const passes: Record<PassKey | 'other', number> = { ...emptyPassTotals(), other: 0 };
    let hookSum = 0;
    for (const k of Object.keys(scene.passTotals) as PassKey[]) {
      passes[k] = scene.passTotals[k] / frames;
      hookSum += passes[k];
    }
    const drawStats = stats(drawTimes);
    passes.other = Math.max(0, drawStats.avg - hookSum);
    const avgTaps = scene.passCounts.taps / frames;
    const avgHolds = scene.passCounts.holds / frames;
    const avgMines = scene.passCounts.mines / frames;

    // --- saturation phase ----------------------------------------------------
    opts.onProgress?.({
      scenarioIndex: index,
      scenarioCount: count,
      label: scn.label,
      phase: 'saturate',
      liveFps: 0,
    });
    // Let the progress overlay actually paint before the thread is hogged.
    await nextFrame(opts.signal);
    const sat0 = performance.now();
    let satDraws = 0;
    while (performance.now() - sat0 < SATURATE_WALL_MS && satDraws < SATURATE_MAX_DRAWS) {
      songNow += SATURATE_STEP_SECONDS;
      drawOnce(songNow);
      satDraws++;
    }
    const satElapsed = performance.now() - sat0;

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
      satDrawsPerSec: satElapsed > 0 ? (satDraws * 1000) / satElapsed : 0,
      passes,
      avgTapsPerFrame: avgTaps,
      avgHoldsPerFrame: avgHolds,
      avgMinesPerFrame: avgMines,
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
