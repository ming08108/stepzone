/**
 * WebGPU note field — the DDR A3 (arcade) look on a first-principles GPU
 * pipeline. Same design grid, scroll math and judge-view as the 2D renderer
 * (imported from noteField/scroll), same procedural art (baked once into a
 * texture atlas by ddrA3's exported paint functions), but the per-frame path
 * is pure GPU: one render pass, a few hundred instanced quads, 3-5 draw
 * calls. Canvas 2D never runs during a frame — only when a sprite is first
 * baked (or a text slot changes).
 *
 * Frame graph (also fixes the 2D renderer's layering inconsistency — hold
 * bodies now pass OVER the receptors, like their heads and like StepMania):
 *   1 background: song media (cover-fit) or solid, + dim
 *   2 field chrome: lane filter, DANGER wash/ropes
 *   3 beat/measure guide lines (scroll with the field, under the notes)
 *   4 receptors
 *   5 hold bodies
 *   6 taps / hold heads / mines
 *   7 hit explosions (additive)
 *   8 judgment label + combo — ON TOP of the arrows, like the DDR cab
 *   9 HUD over the arrows: dance gauge, song panel, score panel
 *
 * The dance gauge's animated fills (flowing green bands, the maxed-gauge
 * rainbow, the top sheen) are scrolling patterns clipped by a baked
 * segment-shape alpha mask — the instanced-quad shader's mask/repeatU/phaseU
 * path — reproducing the 2D theme's ctx.clip() compositing exactly.
 */

import type { Judge } from '../../gameplay/judge';
import {
  beatToNoteRow,
  getNoteType,
  noteRowToBeat,
  TapNoteScore,
  TapNoteType,
} from '../../notes/noteTypes';
import { columnAnglesFor } from '../columns';
import {
  ARROW_HALF,
  DESIGN_SIZE,
  LANE_W,
  MIN_DESIGN_SCALE,
  type NoteFieldConfig,
} from '../fieldConfig';
import {
  advanceCursor,
  FALLBACK_MAX_BPM,
  holdHeadState,
  holdIsAlive,
  holdIsHeld,
  notYet,
  passed,
  shouldDrawHoldBody,
  shouldDrawNote,
  yOf,
  type ScrollState,
} from '../scroll';
import { RECEPTOR_FLASH, type Feedback, type RenderMeta, type TapNoteStyle } from '../types';
import type { NoteSkin } from '../../game/playOptions';
import { GpuAtlas } from './atlas';
import { GlyphBank } from './glyphs';
import { GpuTimer } from './gpuTimer';
import { AttractGpu, type AttractConfig } from './attractGpu';
import { MediaLayer } from './media';
import { QuadBatch } from './quads';
import { ShapeBatch } from './shapes';
import { DdrA3GpuSkin } from './ddrA3Skin';
import { SimplyLoveGpuSkin } from './simplyLoveSkin';
import type { GpuSkin, SkinCtx } from './skin';

/** Renderer config subset the GPU field consumes. `noteSkin` picks the art
 *  (arcade DDR A3 vs ITG Simply Love); everything else is shared mechanics. */
export type GpuFieldConfig = Pick<
  NoteFieldConfig,
  | 'scrollMode'
  | 'scrollValue'
  | 'reverse'
  | 'songMaxBpm'
  | 'bgDim'
  | 'bare'
  | 'columnAngles'
  | 'meta'
  | 'noteSkin'
>;

const DEFAULT_GPU_CONFIG: GpuFieldConfig = {
  scrollMode: 'X',
  scrollValue: 2,
  reverse: false,
  songMaxBpm: FALLBACK_MAX_BPM,
  bgDim: 0.6,
  bare: false,
  columnAngles: [],
  meta: { title: '', subtitle: '', difficulty: '' },
  noteSkin: 'arcade',
};

function makeSkin(noteSkin: NoteSkin): GpuSkin {
  return noteSkin === 'itg' ? new SimplyLoveGpuSkin() : new DdrA3GpuSkin();
}

/** Per-view layout derived from that view's own column width — so the main
 *  field keeps its (wider) design scale while rival columns shrink everything
 *  (arrows, lanes, receptor, beat spacing) rather than just clipping. */
interface ViewMetrics {
  /** This view's column width in css px. */
  viewW: number;
  /** Design scale from viewW (drives colW/arrowS/receptorY). */
  ds: number;
  colW: number;
  arrowS: number;
  fieldLeft: number;
  receptorY: number;
  /** Scroll-speed factor vs the main view (= ds / mainDs), so a narrower rival
   *  shows proportionally tighter beat spacing — a true smaller field, not a
   *  clipped one. Main is always 1, so the solo / 2-player layout is unchanged. */
  scrollScale: number;
}

/** One side-by-side rival field view (live versus). Its chrome/notes/HUD draw
 *  view-locally; the batch originX places it. Cursor/combo state persists across
 *  frames here, one instance per rival, so views don't share a cursor. */
interface RivalView {
  numTracks: number;
  columnAngles: readonly number[];
  meta: RenderMeta;
  metrics: ViewMetrics;
  firstVisibleIdx: number;
  lastCombo: number;
  comboPopAt: number;
}

/** Config the UI/bench pass to setRivals() (per-frame judged state rides in
 *  draw()'s rivals argument, parallel by index). */
export interface RivalConfig {
  numTracks: number;
  columnAngles: number[];
  meta: RenderMeta;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/**
 * Elapsed time (seconds) of every integer beat 0..ceil(throughBeat), for the
 * beat-line pass. Takes a beat→time function (kept free of a TimingData
 * import so the renderer stays presentation-only, like scroll.ts). The array
 * is what setBeatTimes() consumes; a few beats of slack past the last note
 * cover the scroll-out tail (positions past the end extrapolate anyway).
 */
export function beatTimes(getTime: (beat: number) => number, throughBeat: number): Float64Array {
  const n = Math.max(1, Math.ceil(throughBeat) + 8);
  const out = new Float64Array(n);
  for (let bt = 0; bt < n; bt++) out[bt] = getTime(bt);
  return out;
}

export class GpuNoteField {
  width = 800;
  height = 720;
  private cfg: GpuFieldConfig;
  private lost = false;
  /** Fired once if the GPU device is lost (caller may fall back to canvas). */
  onLost?: () => void;

  // Layout (recomputed on resize/config).
  private ds = 1;
  private dpr = 1;
  private colW = LANE_W;
  private arrowS = ARROW_HALF;
  private fieldLeft = 0;
  private receptorY = 0;
  private lastDs = -1;
  // Reusable render-pass descriptor + submit array — mutated per frame (view,
  // timestampWrites, command buffer) instead of reallocating the literals.
  private readonly clearValue: GPUColor = { r: 11 / 255, g: 12 / 255, b: 14 / 255, a: 1 };
  private readonly colorAttachment: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    clearValue: this.clearValue,
    loadOp: 'clear',
    storeOp: 'store',
  };
  private readonly passDesc: GPURenderPassDescriptor = {
    colorAttachments: [this.colorAttachment],
  };
  private readonly submitScratch: GPUCommandBuffer[] = [undefined as unknown as GPUCommandBuffer];

  private firstVisibleIdx = 0;
  private lastCombo = 0;
  private comboPopAt = -10;
  /** Active view width (the currently-drawing view's slice of the canvas);
   *  makeCtx reads it. Set per view by drawView, defaults to the main view. */
  private viewW = 0;
  /** The main field's layout: full canvas solo, or the fixed left W/2 half once
   *  any rival is present (so the main never shrinks with the player count). */
  private mainMetrics!: ViewMetrics;
  /** The side-by-side rival field views (live versus) sharing this canvas,
   *  device and background — one render, uniform backdrop. Empty for solo. Each
   *  carries its own (smaller) metrics packed into the right W/2 half. */
  private rivals: RivalView[] = [];
  /** Per-beat elapsed times for the guide-line pass (null = no beat lines). */
  private beatLineTimes: Float64Array | null = null;
  private readonly scroll: ScrollState;

  // Rebuilt by ensureAtlas() when the display demands a different texture
  // size or bake resolution (4K fullscreen, monitor dpr changes).
  private atlas!: GpuAtlas;
  private batch!: QuadBatch;
  private hudBatch!: QuadBatch;
  private shapes!: ShapeBatch;
  /** Geometry drawn under the notes (SL field filter + density graph). */
  private underShapes!: ShapeBatch;
  private glyphs!: GlyphBank;
  private atlasSize = 0;
  private atlasScale = 0;
  private readonly media: MediaLayer;
  /** Procedural attract background (GPU), drawn when a song ships no BGA. */
  private attract: AttractGpu | null = null;
  private attractCfg: AttractConfig | null = null;
  private readonly timer: GpuTimer;
  /** The art plug-in (arcade / ITG), selected by cfg.noteSkin. */
  private skin: GpuSkin;

  private constructor(
    private readonly device: GPUDevice,
    private readonly ctx: GPUCanvasContext,
    private readonly canvas: HTMLCanvasElement,
    private readonly format: GPUTextureFormat,
    readonly numTracks: number,
    config: Partial<GpuFieldConfig>,
  ) {
    this.cfg = { ...DEFAULT_GPU_CONFIG, ...config };
    if (this.cfg.songMaxBpm <= 0) this.cfg.songMaxBpm = FALLBACK_MAX_BPM;
    if (this.cfg.columnAngles.length === 0) this.cfg.columnAngles = columnAnglesFor('', numTracks);
    this.skin = makeSkin(this.cfg.noteSkin);
    this.media = new MediaLayer(device, format);
    this.timer = new GpuTimer(device);
    this.ensureAtlas();

    this.scroll = {
      mode: this.cfg.scrollMode,
      value: this.cfg.scrollValue,
      songMaxBpm: this.cfg.songMaxBpm,
      reverse: this.cfg.reverse,
      receptorY: 0,
      height: this.height,
      nowSeconds: 0,
      nowBeat: 0,
    };
    this.layout();

    // Rebake text sprites once real web fonts arrive (same as SpriteStore).
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          this.atlas.clear();
          this.glyphs.clear();
          this.skin.clear();
        })
        .catch(() => undefined);
    }
  }

  static async create(
    canvas: HTMLCanvasElement,
    numTracks: number,
    config: Partial<GpuFieldConfig> = {},
  ): Promise<GpuNoteField | null> {
    try {
      const gpu = navigator.gpu;
      if (!gpu) return null;
      const adapter = await withTimeout(gpu.requestAdapter(), 3000);
      if (!adapter) return null;
      // Opt into timestamp queries when the adapter has them, so the benchmark
      // can measure real GPU time per presented frame (gpuTimer.ts).
      const requiredFeatures: GPUFeatureName[] = adapter.features.has('timestamp-query')
        ? ['timestamp-query']
        : [];
      const device = await withTimeout(adapter.requestDevice({ requiredFeatures }), 3000);
      if (!device) return null;
      const ctx = canvas.getContext('webgpu');
      if (!ctx) return null;
      const format = gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: 'opaque' });
      // Surface the first validation error loudly — a broken pipeline
      // otherwise renders black at full fps, which reads as "working".
      let reported = false;
      device.addEventListener?.('uncapturederror', (e) => {
        if (reported) return;
        reported = true;
        console.error(
          '[gpu-notefield] WebGPU error:',
          (e as GPUUncapturedErrorEvent).error.message,
        );
      });
      const field = new GpuNoteField(device, ctx, canvas, format, numTracks, config);
      device.lost
        .then(() => {
          field.lost = true;
          field.onLost?.();
        })
        .catch(() => {
          field.lost = true;
          field.onLost?.();
        });
      return field;
    } catch {
      return null;
    }
  }

  get isLost(): boolean {
    return this.lost;
  }

  /** Resolves once all GPU work submitted so far has actually completed — the
   *  benchmark awaits this to flush pending timestamp readbacks. */
  gpuIdle(): Promise<void> {
    return this.device.queue.onSubmittedWorkDone();
  }

  /** True when GPU timestamp queries are available (adapter had the feature). */
  get gpuTimingAvailable(): boolean {
    return this.timer.enabled;
  }

  /** Start a fresh GPU-time collection window (call at the measure-phase start
   *  to drop prewarm/warmup frames). */
  resetGpuTimes(): void {
    this.timer.reset();
  }

  /** Diagnostic counters for stutter hunting: cumulative sprite bakes (a mid-run
   *  bake is a big one-frame raster) and instance-buffer regrows. */
  perfStats(): { bakes: number; grows: number } {
    return { bakes: this.atlas.bakes, grows: this.batch.grows + this.hudBatch.grows };
  }

  /** Real GPU ms of each presented frame timed since resetGpuTimes(). Readbacks
   *  lag ~a frame, so drain after awaiting gpuIdle(). */
  gpuFrameTimes(): number[] {
    return this.timer.read();
  }

  setBackground(
    media: HTMLVideoElement | HTMLImageElement | ImageBitmap | HTMLCanvasElement | null,
  ): void {
    this.media.setSource(media);
  }

  /** Enable (or clear) the procedural GPU attract background — drawn when no
   *  song media is set. Lazily builds the pipeline the first time it's used. */
  setAttract(cfg: AttractConfig | null): void {
    this.attractCfg = cfg;
    if (cfg) {
      this.attract ??= new AttractGpu(this.device, this.format);
      this.attract.setConfig(cfg);
    }
  }

  /** Live-inject a dance step into the attract dancer (keyboard test mode). */
  pushAttractStep(atBeat: number, cols: number, lCol: number, rCol: number): void {
    this.attract?.pushStep(atBeat, cols, lCol, rCol);
  }

  /** True once the attract 3D dancer has loaded and rendered its first frame — the
   *  benchmark warms up on this so the dance scenario measures the dancer, not just
   *  the neon background while it's still loading. */
  attractDancerRendered(): boolean {
    return this.attract?.dancerRendered ?? false;
  }

  /** Per-beat elapsed times (see beatTimes()) enabling the guide-line pass;
   *  null turns beat lines off. */
  setBeatTimes(times: Float64Array | null): void {
    this.beatLineTimes = times;
  }

  /**
   * (Re)build the atlas + quad batch for the current display: sprites bake at
   * the actual devicePixelRatio (1..2 — exactly backing-store sharp), and the
   * texture grows to 4096² when the design scale × bake scale would overflow
   * 2048² (a 4K fullscreen reaches ds 3; the widest HUD sprites are ~520·ds
   * css). No-op when nothing changed.
   */
  private ensureAtlas(): void {
    const scale = Math.min(2, Math.max(1, this.dpr));
    const size = this.ds * scale > 2.5 ? 4096 : 2048;
    if (this.atlasSize === size && this.atlasScale === scale) return;
    this.atlasSize = size;
    this.atlasScale = scale;
    this.batch?.destroy();
    this.hudBatch?.destroy();
    this.atlas?.destroy();
    this.atlas = new GpuAtlas(this.device, size, scale);
    const atlasView = this.atlas.texture.createView();
    this.batch = new QuadBatch(this.device, this.format, atlasView);
    // Separate quad batch for the HUD panels' text/digits: it flushes AFTER the
    // panel-background shapes so the text sits on top of them.
    this.hudBatch = new QuadBatch(this.device, this.format, atlasView);
    this.shapes ??= new ShapeBatch(this.device, this.format);
    this.underShapes ??= new ShapeBatch(this.device, this.format);
    this.glyphs = new GlyphBank(this.atlas);
    this.skin.clear(); // sprite keys point at the old atlas
  }

  applyConfig(patch: Partial<GpuFieldConfig>): void {
    const c = this.cfg;
    let resetCursor = false;
    if (patch.scrollMode !== undefined && patch.scrollMode !== c.scrollMode) {
      c.scrollMode = patch.scrollMode;
      resetCursor = true;
    }
    if (patch.scrollValue !== undefined && patch.scrollValue !== c.scrollValue) {
      c.scrollValue = patch.scrollValue;
      resetCursor = true;
    }
    if (patch.songMaxBpm !== undefined && patch.songMaxBpm !== c.songMaxBpm) {
      c.songMaxBpm = patch.songMaxBpm > 0 ? patch.songMaxBpm : FALLBACK_MAX_BPM;
      resetCursor = true;
    }
    if (patch.reverse !== undefined && patch.reverse !== c.reverse) {
      c.reverse = patch.reverse;
      resetCursor = true;
    }
    if (patch.bare !== undefined) c.bare = patch.bare;
    if (patch.bgDim !== undefined) c.bgDim = Math.max(0, Math.min(1, patch.bgDim));
    if (patch.columnAngles !== undefined) c.columnAngles = patch.columnAngles;
    if (patch.meta !== undefined) c.meta = patch.meta;
    if (patch.noteSkin !== undefined && patch.noteSkin !== c.noteSkin) {
      c.noteSkin = patch.noteSkin;
      this.skin = makeSkin(patch.noteSkin);
      this.atlas.clear(); // old skin's sprites; the new skin rebakes lazily
      this.glyphs.clear();
      this.lastDs = -1;
    }
    this.layout();
    if (resetCursor) this.firstVisibleIdx = 0;
  }

  resize(width: number, height: number, dpr = 1): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.layout();
    this.firstVisibleIdx = 0;
  }

  /**
   * Draw one synthetic frame that touches every sprite and both blend
   * pipelines, so the atlas bakes and the WebGPU/driver pipelines compile
   * up front instead of hitching on the first notes / first explosion. Call
   * it once after resize(), before the real loop (the session does it behind
   * the READY splash; the bench before its measured window). The frame is
   * immediately overwritten by the first real draw().
   *
   * The fakes are cast to Judge/ActiveNote — prewarm only reads the render
   * path's fields (track, row, beat, time, note.type, the tail/hold fields),
   * and building a real Judge here would couple the renderer to the model.
   */
  prewarm(): void {
    if (this.lost) return;
    try {
      // Bake every sprite variant the active skin can draw, so nothing
      // rasterizes mid-song (the 4K DoEndRasterCHROMIUM hitch).
      this.skin.prewarm(
        this.makeCtx({
          viewKey: 'main',
          numTracks: this.numTracks,
          columnAngles: this.cfg.columnAngles,
          meta: this.cfg.meta,
        }),
      );
      // Two synthetic frames to compile both blend pipelines + the shape
      // pipelines and warm the submit path (danger then hot gauge/life). Fakes
      // are cast to Judge/ActiveNote — the render path only reads presentation
      // fields, and building a real Judge would couple the renderer to the model.
      const mk = (
        track: number,
        beat: number,
        type: TapNoteType,
        extra: Record<string, unknown> = {},
      ) => ({
        track,
        row: beatToNoteRow(beat),
        beat,
        time: beat * 0.3,
        note: { type },
        tailTime: beat * 0.3 + 1,
        tailRow: beatToNoteRow(beat + 2),
        isRoll: false,
        isHold: type === TapNoteType.HoldHead,
        hidden: false,
        holdResolved: false,
        hns: 0,
        holdInitiated: false,
        holdLife: 1,
        tns: 0,
        offset: 0,
        judgable: true,
        ...extra,
      });
      const notes = [
        mk(0, 1, TapNoteType.Tap),
        mk(3, 1.25, TapNoteType.Tap),
        mk(2, 1 + 1 / 3, TapNoteType.Tap),
        mk(1, 1.5, TapNoteType.Tap),
        mk(2, 2.5, TapNoteType.Mine),
        mk(0, 3, TapNoteType.HoldHead),
        mk(1, 3.5, TapNoteType.HoldHead, { isRoll: true }),
        mk(3, 4, TapNoteType.HoldHead, { holdResolved: true }),
      ];
      const mkJudge = (life: number) =>
        ({
          notes,
          combo: 137,
          maxCombo: 137,
          life,
          failed: false,
          grade: 'AA',
          percentDancePoints: 0.418607,
          tapCounts: {},
          judgmentSeq: 1,
          lastTns: TapNoteScore.W1,
        }) as unknown as Judge;
      const fb: Feedback = {
        lastJudgment: { tns: TapNoteScore.W1, atSeconds: 0 },
        laneFlash: [0, -999, -999, -999],
        laneHit: [
          { tns: TapNoteScore.W1, atSeconds: 0 }, // explosion → additive pipeline
          null,
          { tns: TapNoteScore.W2, atSeconds: 0 },
          null,
        ],
      };
      this.draw(mkJudge(0.12), 0.01, 0.02, 0.5, fb);
      this.draw(mkJudge(1), 0.02, 0.04, 0.5, fb);
    } catch {
      // Prewarm is best-effort; a failure must not break real rendering.
    }
  }

  /** Metrics for a view of `viewW` css px hosting `numTracks` lanes, at a design
   *  scale from its own width. `mainDs` normalises the scroll speed so a smaller
   *  rival scrolls proportionally slower (tighter beat spacing). */
  private computeMetrics(viewW: number, numTracks: number, mainDs: number): ViewMetrics {
    const ds = Math.max(MIN_DESIGN_SCALE, Math.min(this.height / DESIGN_SIZE, viewW / DESIGN_SIZE));
    const colW = LANE_W * ds;
    const arrowS = ARROW_HALF * ds;
    const off = this.skin.receptorOffset * ds;
    const receptorY = this.cfg.reverse ? this.height - off : off;
    const fieldLeft = this.skin.fieldLeft(this.cfg.bare, viewW, numTracks, colW, ds);
    return { viewW, ds, colW, arrowS, fieldLeft, receptorY, scrollScale: ds / mainDs };
  }

  /** Make `m` the active view — the singletons makeCtx / the scroll math read.
   *  Called by drawView before each view so its chrome/notes size to that view. */
  private applyMetrics(m: ViewMetrics): void {
    this.viewW = m.viewW;
    this.ds = m.ds;
    this.colW = m.colW;
    this.arrowS = m.arrowS;
    this.fieldLeft = m.fieldLeft;
    this.receptorY = m.receptorY;
    const s = this.scroll;
    s.receptorY = m.receptorY;
    // Scale the scroll speed by this view's design scale so beat spacing shrinks
    // with the arrows (main scrollScale is 1 — solo / 2-player are unchanged).
    s.value = this.cfg.scrollValue * m.scrollScale;
  }

  private layout(): void {
    // The main field stays a fixed size regardless of player count: full canvas
    // solo, the left W/2 half once any rival joins. The rivals share the OTHER
    // W/2 equally, so each rival is (W/2)/rivals.length wide and shrinks
    // everything (its own ds), while the main keeps the 2-player half-cab scale.
    const hasRivals = this.rivals.length > 0;
    const mainW = hasRivals ? this.width / 2 : this.width;
    // Provisional ds from mainW to normalise scroll speeds (main → scrollScale 1).
    const mainDs = Math.max(
      MIN_DESIGN_SCALE,
      Math.min(this.height / DESIGN_SIZE, mainW / DESIGN_SIZE),
    );
    this.mainMetrics = this.computeMetrics(mainW, this.numTracks, mainDs);
    const rivalW = hasRivals ? this.width / 2 / this.rivals.length : 0;
    for (const rv of this.rivals) {
      rv.metrics = this.computeMetrics(rivalW, rv.numTracks, mainDs);
    }
    const s = this.scroll;
    s.mode = this.cfg.scrollMode;
    s.songMaxBpm = this.cfg.songMaxBpm;
    s.reverse = this.cfg.reverse;
    s.height = this.height;
    // Activate the main view as the default (solo draw + prewarm read these).
    this.applyMetrics(this.mainMetrics);
  }

  /** Set the side-by-side rival field views (live versus); pass [] for solo.
   *  Each rival's judged state is passed per frame via draw()'s rivals argument,
   *  matched by index. Layout re-slices the canvas into 1 + rivals.length views. */
  setRivals(cfgs: RivalConfig[]): void {
    const zero: ViewMetrics = {
      viewW: 0,
      ds: 1,
      colW: 0,
      arrowS: 0,
      fieldLeft: 0,
      receptorY: 0,
      scrollScale: 1,
    };
    this.rivals = cfgs.map((c) => ({
      ...c,
      metrics: zero, // real metrics filled by layout() below
      firstVisibleIdx: 0,
      lastCombo: 0,
      comboPopAt: -10,
    }));
    this.layout();
  }

  /** Number of rival views currently laid out (0 = solo full-width field). */
  get rivalCount(): number {
    return this.rivals.length;
  }

  /** A shared 4×4 white sprite for solid fills / gradient-tinted quads. */
  private sprWhite() {
    return this.atlas.sprite('white', 4, 4, (c) => {
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, 4, 4);
    });
  }

  /** Snapshot the field's rendering primitives + one view's layout for the
   *  skin hooks. Views are view-local: the batches' originX places them. */
  private makeCtx(view: {
    viewKey: string;
    numTracks: number;
    columnAngles: readonly number[];
    meta: RenderMeta;
  }): SkinCtx {
    // fieldLeft / colW / ds / receptorY / viewW are the ACTIVE view's (set by
    // drawView via applyMetrics) so each view sizes to its own column.
    const laneX = (t: number) => this.fieldLeft + this.colW / 2 + t * this.colW;
    return {
      batch: this.batch,
      hud: this.hudBatch,
      shapes: this.shapes,
      underShapes: this.underShapes,
      atlas: this.atlas,
      glyphs: this.glyphs,
      ds: this.ds,
      colW: this.colW,
      arrowS: this.arrowS,
      fieldLeft: this.fieldLeft,
      receptorY: this.receptorY,
      numTracks: view.numTracks,
      width: this.viewW,
      height: this.height,
      reverse: this.cfg.reverse,
      meta: view.meta,
      viewKey: view.viewKey,
      laneX,
      angle: (t) => view.columnAngles[t] ?? 0,
      white: () => this.sprWhite(),
    };
  }

  // --- The frame ------------------------------------------------------------

  draw(
    judge: Judge,
    now: number,
    beat: number,
    progress: number,
    fb: Feedback,
    rivals?: { judge: Judge; feedback: Feedback }[],
  ): void {
    if (this.lost) return;
    const { width, height } = this;
    // Display changes: dpr/size changes swap in a right-sized atlas; a design-
    // scale change on the same atlas just rebakes (sprites are ds-dependent).
    // Keyed on the MAIN view's ds — sprites bake at that (largest) scale and the
    // smaller rival views just sample them down, so per-view ds never rebakes.
    const ds = this.mainMetrics.ds;
    this.ensureAtlas();
    if (ds !== this.lastDs) {
      this.lastDs = ds;
      this.atlas.clear();
      this.glyphs.clear();
      this.skin.clear();
    }
    const beatPulse = 1 - (beat - Math.floor(beat));
    const s = this.scroll;
    s.nowSeconds = now;
    s.nowBeat = beat;

    const b = this.batch;
    b.begin(width, height);
    this.hudBatch.begin(width, height); // panel text, flushed over the panel shapes
    this.shapes.begin(width, height); // HUD backgrounds over the notes
    this.underShapes.begin(width, height); // chrome/density under the notes
    const white = this.sprWhite();

    // 1. Background dim is folded into the media pass (media.draw below darkens
    // the blit in-shader), so there is no separate full-canvas dim quad here —
    // it spans the full canvas identically, even with two field views on it.

    // 2-9. Each field view draws view-locally; the batches' originX places it,
    // and its own metrics (applied inside drawView) size it. The main sits at
    // x=0 with the fixed main width; rivals tile the right half after it.
    const main = this.drawView(
      {
        viewKey: 'main',
        numTracks: this.numTracks,
        columnAngles: this.cfg.columnAngles,
        meta: this.cfg.meta,
        firstVisibleIdx: this.firstVisibleIdx,
        lastCombo: this.lastCombo,
        comboPopAt: this.comboPopAt,
      },
      this.mainMetrics,
      0,
      judge,
      fb,
      now,
      beat,
      progress,
      beatPulse,
      white,
    );
    this.firstVisibleIdx = main.firstVisibleIdx;
    this.lastCombo = main.lastCombo;
    this.comboPopAt = main.comboPopAt;
    // Each rival view is one slice of the right half, drawn from its own judged
    // state (rivals[i]) and its own persisted cursor/metrics (this.rivals[i]).
    if (rivals) {
      const count = Math.min(this.rivals.length, rivals.length);
      const mainW = this.mainMetrics.viewW;
      for (let i = 0; i < count; i++) {
        const view = this.rivals[i];
        const src = rivals[i];
        if (!src) continue;
        const r = this.drawView(
          {
            viewKey: `rival${i}`,
            numTracks: view.numTracks,
            columnAngles: view.columnAngles,
            meta: view.meta,
            firstVisibleIdx: view.firstVisibleIdx,
            lastCombo: view.lastCombo,
            comboPopAt: view.comboPopAt,
          },
          view.metrics,
          mainW + i * view.metrics.viewW,
          src.judge,
          src.feedback,
          now,
          beat,
          progress,
          beatPulse,
          white,
        );
        view.firstVisibleIdx = r.firstVisibleIdx;
        view.lastCombo = r.lastCombo;
        view.comboPopAt = r.comboPopAt;
      }
    }
    b.originX = 0;
    this.hudBatch.originX = 0;
    this.shapes.originX = 0;
    this.underShapes.originX = 0;

    // --- Encode ---------------------------------------------------------------
    try {
      // #0b0c0e clear like the 2D field; the surface is non-srgb unorm so the
      // clear values are raw byte fractions. Descriptor is reused per frame —
      // only the swapchain view + timestamp writes change.
      this.colorAttachment.view = this.ctx.getCurrentTexture().createView();
      this.passDesc.timestampWrites = this.timer.timestampWrites();
      const enc = this.device.createCommandEncoder();
      const attractActive = this.attractCfg && this.attract && !this.media.active;
      // The attract's 3D model (if loaded) renders to its own offscreen target
      // on this encoder, BEFORE the main pass, so it can use its own depth.
      if (attractActive) this.attract!.renderModel(enc, width, height, now, beat, this.cfg.bgDim);
      const pass = enc.beginRenderPass(this.passDesc);
      if (attractActive) {
        this.attract!.draw(pass, width, height, now, beat, this.cfg.bgDim);
      } else {
        this.media.draw(pass, width, height, this.cfg.bgDim);
      }
      this.underShapes.flush(pass); // SL chrome + density, UNDER the notes
      this.batch.flush(pass); // field, notes, explosions (textured quads)
      this.shapes.flush(pass); // HUD backgrounds (geometry) over the field
      this.hudBatch.flush(pass); // HUD text/digits over their backgrounds
      pass.end();
      this.timer.resolve(enc);
      this.submitScratch[0] = enc.finish();
      this.device.queue.submit(this.submitScratch);
      this.timer.afterSubmit();
    } catch {
      this.lost = true;
      this.onLost?.();
    }
  }

  /** Render one field view (chrome -> HUD -> notes -> explosions -> overlay)
   *  view-locally; originX places it on the shared canvas. Returns the view's
   *  advanced cursor/combo state (the caller persists it). */
  private drawView(
    view: {
      viewKey: string;
      numTracks: number;
      columnAngles: readonly number[];
      meta: RenderMeta;
      firstVisibleIdx: number;
      lastCombo: number;
      comboPopAt: number;
    },
    metrics: ViewMetrics,
    originX: number,
    judge: Judge,
    fb: Feedback,
    now: number,
    beat: number,
    progress: number,
    beatPulse: number,
    white: ReturnType<GpuNoteField['sprWhite']>,
  ): { firstVisibleIdx: number; lastCombo: number; comboPopAt: number } {
    // Size the field to THIS view (arrows/lanes/receptor/scroll speed) before
    // any skin call reads the singletons via makeCtx.
    this.applyMetrics(metrics);
    this.batch.originX = originX;
    this.hudBatch.originX = originX;
    this.shapes.originX = originX;
    this.underShapes.originX = originX;
    const ctx = this.makeCtx(view);
    const s = this.scroll;

    // 2. Field chrome (lane filter, danger).
    this.skin.chrome(ctx, judge, beatPulse);

    // 3. HUD under the notes (SL side panel + density graph; A3 draws nothing).
    if (!this.cfg.bare) this.skin.hudUnderlay(ctx, judge, progress, now, beatPulse);

    // 4. Beat/measure guide lines — skin opt-in, under the notes.
    if (white && this.beatLineTimes && this.skin.beatLines) {
      this.pushBeatLines(white, this.fieldLeft, view.numTracks);
    }

    // 5. Receptors (under holds and notes — the corrected layering).
    for (let t = 0; t < view.numTracks; t++) {
      const flashAge = now - (fb.laneFlash[t] ?? -1);
      const pressed = flashAge >= 0 && flashAge < RECEPTOR_FLASH;
      this.skin.receptor(ctx, t, pressed, beatPulse);
    }

    // 6-7. Holds, then taps/heads/mines (same windowed loops as the 2D field).
    const notes = judge.notes;
    const firstVisibleIdx = advanceCursor(s, notes, view.firstVisibleIdx);
    for (let i = firstVisibleIdx; i < notes.length; i++) {
      const n = notes[i];
      let headY = yOf(s, n.time, n.beat);
      if (notYet(s, headY)) break;
      if (!shouldDrawHoldBody(n)) continue;
      const tailY = yOf(s, n.tailTime, noteRowToBeat(n.tailRow));
      const held = holdIsHeld(n, now);
      if (held) headY = this.receptorY;
      this.skin.hold(
        ctx,
        n.track,
        Math.min(headY, tailY),
        Math.max(headY, tailY),
        held,
        holdIsAlive(n),
        n.isRoll,
        beatPulse,
        getNoteType(n.row),
      );
    }

    for (let i = firstVisibleIdx; i < notes.length; i++) {
      const n = notes[i];
      const isHoldHead = n.note.type === TapNoteType.HoldHead;
      const headState = isHoldHead ? holdHeadState(n, now) : null;
      if (headState === 'gone') continue;
      const engaged = headState === 'engaged';
      const y = engaged ? this.receptorY : yOf(s, n.time, n.beat);
      if (!engaged) {
        if (notYet(s, y)) break;
        if (passed(s, y)) continue;
      }
      if (!isHoldHead && !shouldDrawNote(n)) continue;
      if (n.note.type === TapNoteType.Mine) {
        this.skin.mine(ctx, ctx.laneX(n.track), y, now, beatPulse);
      } else {
        const quant = getNoteType(n.row);
        const style: TapNoteStyle = isHoldHead
          ? headState === 'dropped'
            ? 'deadHead'
            : engaged
              ? 'heldHead'
              : 'holdHead'
          : 'tap';
        this.skin.note(ctx, n.track, y, quant, style, now, beat, beatPulse);
      }
    }

    // 8. Hit explosions (additive).
    for (let t = 0; t < view.numTracks; t++) {
      const hit = fb.laneHit[t];
      if (!hit) continue;
      const age = now - hit.atSeconds;
      if (age < 0 || age >= this.skin.explosionSeconds) continue;
      this.skin.explosion(ctx, t, hit.tns, age / this.skin.explosionSeconds);
    }

    // 9. Judgment + combo (both skins) + A3 gauge/panels, over the notes.
    let { lastCombo, comboPopAt } = view;
    if (!this.cfg.bare) {
      if (judge.combo !== lastCombo) {
        if (judge.combo > lastCombo) comboPopAt = now;
        lastCombo = judge.combo;
      }
      this.skin.hudOverlay(ctx, judge, progress, fb, now, beatPulse, comboPopAt);
    }
    return { firstVisibleIdx, lastCombo, comboPopAt };
  }

  // --- Pass builders ----------------------------------------------------------

  /**
   * Horizontal guide lines at every beat, brighter on measure boundaries,
   * scrolling with the field. Beats are monotonic in screen-y under every
   * scroll mode, so a bounded scan out from nowBeat in both directions covers
   * exactly the on-screen ones. Times past the precomputed array extrapolate
   * with the final interval (only C-mod under a BPM change reads them; X/M
   * ignore time entirely).
   */
  private pushBeatLines(
    white: NonNullable<ReturnType<GpuNoteField['sprWhite']>>,
    fieldLeft: number,
    numTracks: number,
  ): void {
    const b = this.batch;
    const s = this.scroll;
    const { ds, height } = this;
    const times = this.beatLineTimes;
    if (!times) return;
    const nb = s.nowBeat;
    const w = numTracks * this.colW + 28 * ds; // span the lane-cover width
    const cx = fieldLeft + (numTracks * this.colW) / 2;
    const cull = 40 * ds;
    const last = times.length - 1;
    const dLast = last >= 1 ? times[last] - times[last - 1] : 0.5;
    const yFor = (B: number): number =>
      yOf(s, B <= last ? times[B] : times[last] + (B - last) * dLast, B);
    const line = (B: number, y: number): void => {
      const measure = B % 4 === 0;
      b.push(cx, y, w, (measure ? 2 : 1.4) * ds, white, 1, 1, 1, measure ? 0.22 : 0.1);
    };
    const CAP = 512; // guard against pathologically small spacing
    let n = 0;
    // Down from nowBeat (inclusive of the beat at/just below it), then up.
    for (let B = Math.floor(nb); B >= 0 && n < CAP; B--, n++) {
      const y = yFor(B);
      if (y < -cull || y > height + cull) break;
      line(B, y);
    }
    for (let B = Math.floor(nb) + 1; n < CAP; B++, n++) {
      const y = yFor(B);
      if (y < -cull || y > height + cull) break;
      line(B, y);
    }
  }

  destroy(): void {
    this.lost = true;
    try {
      this.batch.destroy();
      this.hudBatch.destroy();
      this.shapes.destroy();
      this.timer.destroy();
      this.media.destroy();
      this.attract?.destroy();
      this.atlas.destroy();
      this.device.destroy();
    } catch {
      // already lost
    }
  }
}
