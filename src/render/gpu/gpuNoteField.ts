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
} from '../noteField';
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
import { RECEPTOR_FLASH, type Feedback, type TapNoteStyle } from '../theme';
import type { NoteSkin } from '../../game/playOptions';
import { GpuAtlas } from './atlas';
import { GlyphBank } from './glyphs';
import { GpuTimer } from './gpuTimer';
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

  /** Real GPU ms of each presented frame timed since resetGpuTimes(). Readbacks
   *  lag ~a frame, so drain after awaiting gpuIdle(). */
  gpuFrameTimes(): number[] {
    return this.timer.read();
  }

  setBackground(media: HTMLVideoElement | HTMLImageElement | ImageBitmap | null): void {
    this.media.setSource(media);
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
      this.skin.prewarm(this.makeCtx());
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

  private layout(): void {
    const ds = Math.max(
      MIN_DESIGN_SCALE,
      Math.min(this.height / DESIGN_SIZE, this.width / DESIGN_SIZE),
    );
    this.ds = ds;
    this.colW = LANE_W * ds;
    this.arrowS = ARROW_HALF * ds;
    const off = this.skin.receptorOffset * ds;
    this.receptorY = this.cfg.reverse ? this.height - off : off;
    this.fieldLeft = this.skin.fieldLeft(this.cfg.bare, this.width, this.numTracks, this.colW, ds);
    const s = this.scroll;
    s.mode = this.cfg.scrollMode;
    s.value = this.cfg.scrollValue;
    s.songMaxBpm = this.cfg.songMaxBpm;
    s.reverse = this.cfg.reverse;
    s.receptorY = this.receptorY;
    s.height = this.height;
  }

  private laneX(track: number): number {
    return this.fieldLeft + this.colW / 2 + track * this.colW;
  }

  private angle(track: number): number {
    return this.cfg.columnAngles[track] ?? 0;
  }

  /** A shared 4×4 white sprite for solid fills / gradient-tinted quads. */
  private sprWhite() {
    return this.atlas.sprite('white', 4, 4, (c) => {
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, 4, 4);
    });
  }

  /** Snapshot the field's rendering primitives + layout for the skin hooks. */
  private makeCtx(): SkinCtx {
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
      numTracks: this.numTracks,
      width: this.width,
      height: this.height,
      reverse: this.cfg.reverse,
      meta: this.cfg.meta,
      laneX: (t) => this.laneX(t),
      angle: (t) => this.angle(t),
      white: () => this.sprWhite(),
    };
  }

  // --- The frame ------------------------------------------------------------

  draw(judge: Judge, now: number, beat: number, progress: number, fb: Feedback): void {
    if (this.lost) return;
    const { width, height, ds } = this;
    // Display changes: dpr/size changes swap in a right-sized atlas; a design-
    // scale change on the same atlas just rebakes (sprites are ds-dependent).
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
    const ctx = this.makeCtx();
    const white = this.sprWhite();

    // 1. Dim over the song media (the field owns the background pass; the skin
    // chrome draws over this).
    if (white && this.media.active && this.cfg.bgDim > 0) {
      b.push(width / 2, height / 2, width, height, white, 0, 0, 0, this.cfg.bgDim);
    }

    // 2. Field chrome (lane filter, danger).
    this.skin.chrome(ctx, judge, beatPulse);

    // 3. HUD under the notes (SL side panel + density graph; A3 draws nothing).
    if (!this.cfg.bare) this.skin.hudUnderlay(ctx, judge, progress, now, beatPulse);

    // 4. Beat/measure guide lines — skin opt-in, under the notes.
    if (white && this.beatLineTimes && this.skin.beatLines) this.pushBeatLines(white);

    // 5. Receptors (under holds and notes — the corrected layering).
    for (let t = 0; t < this.numTracks; t++) {
      const flashAge = now - (fb.laneFlash[t] ?? -1);
      const pressed = flashAge >= 0 && flashAge < RECEPTOR_FLASH;
      this.skin.receptor(ctx, t, pressed, beatPulse);
    }

    // 6-7. Holds, then taps/heads/mines (same windowed loops as the 2D field).
    const notes = judge.notes;
    this.firstVisibleIdx = advanceCursor(s, notes, this.firstVisibleIdx);
    for (let i = this.firstVisibleIdx; i < notes.length; i++) {
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
      );
    }

    for (let i = this.firstVisibleIdx; i < notes.length; i++) {
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
        this.skin.mine(ctx, this.laneX(n.track), y, now, beatPulse);
      } else {
        const quant = getNoteType(n.row);
        const style: TapNoteStyle = isHoldHead
          ? headState === 'dropped'
            ? 'deadHead'
            : 'holdHead'
          : 'tap';
        this.skin.note(ctx, n.track, y, quant, style, now, beat, beatPulse);
      }
    }

    // 8. Hit explosions (additive).
    for (let t = 0; t < this.numTracks; t++) {
      const hit = fb.laneHit[t];
      if (!hit) continue;
      const age = now - hit.atSeconds;
      if (age < 0 || age >= this.skin.explosionSeconds) continue;
      this.skin.explosion(ctx, t, hit.tns, age / this.skin.explosionSeconds);
    }

    // 9. Judgment + combo (both skins) + A3 gauge/panels, over the notes.
    if (!this.cfg.bare) {
      if (judge.combo !== this.lastCombo) {
        if (judge.combo > this.lastCombo) this.comboPopAt = now;
        this.lastCombo = judge.combo;
      }
      this.skin.hudOverlay(ctx, judge, progress, fb, now, beatPulse, this.comboPopAt);
    }

    // --- Encode ---------------------------------------------------------------
    try {
      // #0b0c0e clear like the 2D field; the surface is non-srgb unorm so the
      // clear values are raw byte fractions. Descriptor is reused per frame —
      // only the swapchain view + timestamp writes change.
      this.colorAttachment.view = this.ctx.getCurrentTexture().createView();
      this.passDesc.timestampWrites = this.timer.timestampWrites();
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass(this.passDesc);
      this.media.draw(pass, width, height);
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

  // --- Pass builders ----------------------------------------------------------

  /**
   * Horizontal guide lines at every beat, brighter on measure boundaries,
   * scrolling with the field. Beats are monotonic in screen-y under every
   * scroll mode, so a bounded scan out from nowBeat in both directions covers
   * exactly the on-screen ones. Times past the precomputed array extrapolate
   * with the final interval (only C-mod under a BPM change reads them; X/M
   * ignore time entirely).
   */
  private pushBeatLines(white: NonNullable<ReturnType<GpuNoteField['sprWhite']>>): void {
    const b = this.batch;
    const s = this.scroll;
    const { ds, height } = this;
    const times = this.beatLineTimes;
    if (!times) return;
    const nb = s.nowBeat;
    const w = this.numTracks * this.colW + 28 * ds; // span the lane-cover width
    const cx = this.fieldLeft + (this.numTracks * this.colW) / 2;
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
      this.atlas.destroy();
      this.device.destroy();
    } catch {
      // already lost
    }
  }
}
