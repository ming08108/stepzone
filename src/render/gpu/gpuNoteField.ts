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
 *   3 HUD under the arrows: judgment label, combo (A3 ComboUnderField)
 *   4 receptors
 *   5 hold bodies
 *   6 taps / hold heads / mines
 *   7 hit explosions (additive)
 *   8 HUD over the arrows: dance gauge, song panel, score panel
 *
 * The dance gauge's animated fills (flowing green bands, the maxed-gauge
 * rainbow, the top sheen) are scrolling patterns clipped by a baked
 * segment-shape alpha mask — the instanced-quad shader's mask/repeatU/phaseU
 * path — reproducing the 2D theme's ctx.clip() compositing exactly.
 */

import type { Judge } from '../../gameplay/judge';
import { getNoteType, noteRowToBeat, TapNoteScore, TapNoteType } from '../../notes/noteTypes';
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
import { RECEPTOR_FLASH, type Feedback } from '../theme';
import {
  A3_EXPLOSION,
  A3_JUDGMENT,
  COMBO_PLAIN,
  COMBO_TINT,
  HOLD_GREEN,
  HOLD_GREY,
  HOLD_PURPLE,
  JUDGMENT_INK,
  JUDGMENT_LIFE,
  NOTE_GREEN,
  NOTE_GREY,
  QUANT_BAND,
  QUANT_TUBE,
  TUBE_GREY,
  measureWidth,
  paintBoom,
  paintCombo,
  paintGaugeChrome,
  paintGaugeDividers,
  paintHoldTile,
  paintJudgment,
  paintMineArcs,
  paintMineOrb,
  paintNote,
  paintReceptor,
  paintScorePanel,
  paintSongPanel,
  roundFont,
  traceSegments,
  type HoldSkin,
} from '../themes/ddrA3';
import { GpuAtlas } from './atlas';
import { MediaLayer } from './media';
import { cropUV, QuadBatch } from './quads';
import { NoteType } from '../../notes/noteTypes';

/** Renderer config subset the GPU field consumes (arcade skin only in v1). */
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
};

const RECEPTOR_OFFSET = 118; // A3 step zone, design px (matches DdrA3Theme)

/** Parse #rgb/#rrggbb/rgb()/rgba() into 0..1 floats. */
function parseColor(s: string): [number, number, number, number] {
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const n =
      hex.length === 3
        ? hex.split('').map((c) => c + c)
        : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
    return [parseInt(n[0], 16) / 255, parseInt(n[1], 16) / 255, parseInt(n[2], 16) / 255, 1];
  }
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return [1, 1, 1, 1];
  const p = m[1].split(',').map((v) => parseFloat(v));
  return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
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
  private colW = LANE_W;
  private arrowS = ARROW_HALF;
  private fieldLeft = 0;
  private receptorY = 0;
  private lastDs = -1;

  private firstVisibleIdx = 0;
  private lastCombo = 0;
  private comboPopAt = -10;
  private readonly scroll: ScrollState;

  private readonly atlas: GpuAtlas;
  private readonly batch: QuadBatch;
  private readonly media: MediaLayer;

  private constructor(
    private readonly device: GPUDevice,
    private readonly ctx: GPUCanvasContext,
    private readonly canvas: HTMLCanvasElement,
    format: GPUTextureFormat,
    readonly numTracks: number,
    config: Partial<GpuFieldConfig>,
  ) {
    this.cfg = { ...DEFAULT_GPU_CONFIG, ...config };
    if (this.cfg.songMaxBpm <= 0) this.cfg.songMaxBpm = FALLBACK_MAX_BPM;
    if (this.cfg.columnAngles.length === 0) this.cfg.columnAngles = columnAnglesFor('', numTracks);
    this.atlas = new GpuAtlas(device);
    this.batch = new QuadBatch(device, format, this.atlas.texture.createView());
    this.media = new MediaLayer(device, format);

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
      document.fonts.ready.then(() => this.atlas.clear()).catch(() => undefined);
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
      const device = await withTimeout(adapter.requestDevice(), 3000);
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

  setBackground(media: HTMLVideoElement | HTMLImageElement | ImageBitmap | null): void {
    this.media.setSource(media);
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
    this.layout();
    if (resetCursor) this.firstVisibleIdx = 0;
  }

  resize(width: number, height: number, dpr = 1): void {
    this.width = width;
    this.height = height;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.layout();
    this.firstVisibleIdx = 0;
  }

  private layout(): void {
    const ds = Math.max(
      MIN_DESIGN_SCALE,
      Math.min(this.height / DESIGN_SIZE, this.width / DESIGN_SIZE),
    );
    this.ds = ds;
    this.colW = LANE_W * ds;
    this.arrowS = ARROW_HALF * ds;
    const off = RECEPTOR_OFFSET * ds;
    this.receptorY = this.cfg.reverse ? this.height - off : off;
    const fieldW = this.numTracks * this.colW;
    this.fieldLeft = this.cfg.bare
      ? (this.width - fieldW) / 2
      : Math.max(24 * ds, 0.22 * this.width - fieldW / 2);
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

  // --- Sprite getters (baked on demand; keys mirror the 2D SpriteStore) -----

  private sprWhite() {
    return this.atlas.sprite('white', 4, 4, (c) => {
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, 4, 4);
    });
  }

  private sprNote(band: typeof NOTE_GREEN, tube: string) {
    const m = this.arrowS + 9 * this.ds;
    return this.atlas.sprite(`note:${band[1]}`, 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintNote(c, this.arrowS, this.ds, band, tube);
    });
  }

  private sprReceptor(kind: 'dim' | 'bright' | 'press') {
    const s = this.arrowS * 0.95;
    const m = s + 8 * this.ds;
    return this.atlas.sprite(`rec:${kind}`, 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintReceptor(c, s, this.ds, kind === 'bright' ? 1 : 0, kind === 'press');
    });
  }

  private sprGradStrip(key: string, stops: Array<[number, string]>, horizontal = false) {
    const w = horizontal ? 128 : 16;
    const h = horizontal ? 16 : 128;
    return this.atlas.sprite(key, w, h, (c) => {
      const g = horizontal
        ? c.createLinearGradient(0, 0, w, 0)
        : c.createLinearGradient(0, 0, 0, h);
      for (const [at, color] of stops) g.addColorStop(at, color);
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
  }

  // --- The frame ------------------------------------------------------------

  draw(judge: Judge, now: number, beat: number, progress: number, fb: Feedback): void {
    if (this.lost) return;
    const { width, height, ds } = this;
    if (ds !== this.lastDs) {
      this.lastDs = ds;
      this.atlas.clear();
    }
    const beatPulse = 1 - (beat - Math.floor(beat));
    const s = this.scroll;
    s.nowSeconds = now;
    s.nowBeat = beat;

    const b = this.batch;
    b.begin(width, height);
    const white = this.sprWhite();

    // 2. Field chrome (lane filter + DANGER) — drawn even in bare mode.
    if (white) this.pushChrome(judge, beatPulse, white);

    // 3. HUD under the arrows.
    if (!this.cfg.bare) {
      if (judge.combo !== this.lastCombo) {
        if (judge.combo > this.lastCombo) this.comboPopAt = now;
        this.lastCombo = judge.combo;
      }
      this.pushJudgment(fb, now);
      this.pushCombo(judge, fb, now);
    }

    // 4. Receptors (under holds and notes — the corrected layering).
    const f = beatPulse * beatPulse;
    for (let t = 0; t < this.numTracks; t++) {
      const flashAge = now - (fb.laneFlash[t] ?? -1);
      const pressed = flashAge >= 0 && flashAge < RECEPTOR_FLASH;
      const m = this.arrowS * 0.95 + 8 * this.ds;
      const x = this.laneX(t);
      const rot = this.angle(t);
      if (pressed) {
        const spr = this.sprReceptor('press');
        if (spr) b.push(x, this.receptorY, 2 * m * 0.94, 2 * m * 0.94, spr, 1, 1, 1, 1, { rot });
      } else {
        const dim = this.sprReceptor('dim');
        if (dim) b.push(x, this.receptorY, 2 * m, 2 * m, dim, 1, 1, 1, 1, { rot });
        if (f > 0.02) {
          const bright = this.sprReceptor('bright');
          if (bright) b.push(x, this.receptorY, 2 * m, 2 * m, bright, 1, 1, 1, f, { rot });
        }
      }
    }

    // 5-6. Holds, then taps/heads/mines (same windowed loops as the 2D field).
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
      this.pushHoldBody(
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
        this.pushMine(this.laneX(n.track), y, now, beatPulse);
      } else {
        const quant = getNoteType(n.row);
        const dead = isHoldHead && headState === 'dropped';
        const band = dead ? NOTE_GREY : isHoldHead ? NOTE_GREEN : QUANT_BAND[quant];
        const tube = dead ? TUBE_GREY : isHoldHead ? QUANT_TUBE[NoteType.N12TH] : QUANT_TUBE[quant];
        const spr = this.sprNote(band, tube);
        const m = this.arrowS + 9 * this.ds;
        if (spr)
          b.push(this.laneX(n.track), y, 2 * m, 2 * m, spr, 1, 1, 1, 1, {
            rot: this.angle(n.track),
          });
      }
    }

    // 7. Hit explosions (additive).
    for (let t = 0; t < this.numTracks; t++) {
      const hit = fb.laneHit[t];
      if (!hit) continue;
      const age = now - hit.atSeconds;
      if (age < 0 || age >= A3_EXPLOSION) continue;
      this.pushExplosion(t, hit.tns, age / A3_EXPLOSION);
    }

    // 8. HUD over the arrows.
    if (!this.cfg.bare && white) {
      this.pushGauge(judge, now, beatPulse);
      this.pushSongPanel(progress, white);
      this.pushScorePanel(judge);
    }

    // --- Encode ---------------------------------------------------------------
    try {
      const view = this.ctx.getCurrentTexture().createView();
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view,
            // #0b0c0e like the 2D field. The surface is non-srgb unorm, so
            // clear values are raw byte fractions (canvas-equivalent), not
            // linear-light.
            clearValue: { r: 11 / 255, g: 12 / 255, b: 14 / 255, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      this.media.draw(pass, width, height);
      this.batch.flush(pass);
      pass.end();
      this.device.queue.submit([enc.finish()]);
    } catch {
      this.lost = true;
      this.onLost?.();
    }
  }

  // --- Pass builders ----------------------------------------------------------

  private pushChrome(
    judge: Judge,
    beatPulse: number,
    white: NonNullable<ReturnType<GpuNoteField['sprWhite']>>,
  ): void {
    const { ds, height } = this;
    const b = this.batch;
    const fieldW = this.numTracks * this.colW;
    const pad = 14 * ds;
    const x0 = this.fieldLeft - pad;
    const w = fieldW + 2 * pad;
    const soft = 14 * ds;

    // Dim overlay over song media (the 2D renderer dims inside drawBackground).
    if (this.media.active) {
      b.push(
        this.width / 2,
        height / 2,
        this.width,
        height,
        white,
        5 / 255,
        6 / 255,
        8 / 255,
        this.cfg.bgDim,
      );
    }

    const edge = this.sprGradStrip(
      'lf:edge',
      [
        [0, 'rgba(0,0,0,0)'],
        [1, 'rgba(0,0,0,1)'],
      ],
      true,
    );
    // Soft edges: gradient strip (transparent→black), alpha 0.55; right side mirrored.
    if (edge) {
      b.push(x0, height / 2, 2 * soft, height, edge, 1, 1, 1, 0.55);
      b.push(x0 + w, height / 2, -2 * soft, height, edge, 1, 1, 1, 0.55);
    }
    b.push(x0 + w / 2, height / 2, w - 2 * soft, height, white, 0, 0, 0, 0.55);

    if (!judge.failed && judge.life < 0.25) {
      // DANGER: red wash + glowing rope lines + rotated lettering.
      b.push(x0 + w / 2, height / 2, w, height, white, 144 / 255, 0, 0, 0.16 + 0.14 * beatPulse);
      const glow = 0.55 + 0.45 * beatPulse;
      const rope = this.sprGradStrip(
        'danger:rope',
        [
          [0, 'rgba(250,238,0,0)'],
          [0.35, 'rgba(250,238,0,0.55)'],
          [0.46, 'rgba(250,238,0,1)'],
          [0.54, 'rgba(250,238,0,1)'],
          [0.65, 'rgba(250,238,0,0.55)'],
          [1, 'rgba(250,238,0,0)'],
        ],
        true,
      );
      const text = this.atlas.sprite('danger:text', 200 * ds, 26 * ds, (c) => {
        c.font = roundFont(20 * ds);
        c.textAlign = 'center';
        c.strokeStyle = '#faee00';
        c.lineWidth = 1.5 * ds;
        c.strokeText('D A N G E R', 100 * ds, 19 * ds);
      });
      for (const x of [x0 + 5 * ds, x0 + w - 5 * ds]) {
        if (rope) b.push(x, height / 2, 26 * ds, height, rope, 1, 1, 1, glow);
        if (text)
          b.push(x - 7 * ds, height / 2, 200 * ds, 26 * ds, text, 1, 1, 1, glow, {
            rot: -Math.PI / 2,
          });
      }
    }
  }

  private pushJudgment(fb: Feedback, now: number): void {
    if (!fb.lastJudgment) return;
    const age = now - fb.lastJudgment.atSeconds;
    const tns = fb.lastJudgment.tns;
    const j = A3_JUDGMENT[tns];
    if (!j || age < 0 || age >= JUDGMENT_LIFE) return;
    const ink = JUDGMENT_INK[tns] ?? JUDGMENT_INK[TapNoteScore.W4];
    const { ds } = this;
    const cx = this.fieldLeft + (this.numTracks * this.colW) / 2;
    const dir = this.cfg.reverse ? -1 : 1;
    const y = this.receptorY + dir * 1.38 * this.colW;
    const squash = age < 0.036 ? 1.5 - 0.5 * (age / 0.036) : 1;
    const px = 37 * ds;
    const pad = 18 * ds;
    const textW = measureWidth(roundFont(px), j.label);
    if (textW === null) return;
    const w = textW + 2 * pad;
    const h = px * 1.1 + 2 * pad;
    const spr = this.atlas.sprite(`judg:${tns}`, w, h, (c) =>
      paintJudgment(c, j.label, ink, px, ds, pad, false),
    );
    // Sprite anchor: drawImage(-w/2, -(pad+px*0.78)) under scale(1, squash).
    const cyOff = h / 2 - (pad + px * 0.78);
    if (spr) this.batch.push(cx, y + squash * cyOff, w, h * squash, spr);
    const shimmer = tns === TapNoteScore.W1 && Math.floor(age / 0.025) % 2 === 0;
    if (shimmer) {
      const shine = this.atlas.sprite(`judgshine:${tns}`, w, h, (c) =>
        paintJudgment(c, j.label, ink, px, ds, pad, true),
      );
      if (shine) this.batch.push(cx, y + squash * cyOff, w, h * squash, shine, 1, 1, 1, 0.35);
    }
  }

  private pushCombo(judge: Judge, fb: Feedback, now: number): void {
    if (judge.combo < 4) return;
    const { ds } = this;
    const cx = this.fieldLeft + (this.numTracks * this.colW) / 2;
    const dir = this.cfg.reverse ? -1 : 1;
    const yMid = this.receptorY + dir * 2.42 * this.colW;
    const tint = (fb.lastJudgment && COMBO_TINT[fb.lastJudgment.tns]) || COMBO_PLAIN;
    const c = judge.combo;
    const count = String(c);
    const zoom = c >= 1000 ? 0.78 : c >= 100 ? 0.9 : 0.6 + 0.03 * Math.min(9, Math.floor(c / 10));
    const px = this.colW * zoom;
    const k = Math.max(0, Math.min(1, (now - this.comboPopAt) / 0.05));
    const pop = 1 + 0.3 * (1 - k);
    const baseline = yMid + px * 0.36;
    const joinX = cx + 0.34 * this.colW;
    const numW = measureWidth(roundFont(px), count);
    const wordW = measureWidth(roundFont(px * 0.42), 'combo');
    if (numW === null || wordW === null) return;
    const pad = px * 0.14;
    const joinOff = pad + numW * 0.84;
    const w = joinOff + 6 * ds + wordW + pad;
    const baseY = px * 0.92;
    const h = px * 1.12;
    const spr = this.atlas.slot('combo', `${count}|${tint[1]}|${Math.round(px * 10)}`, w, h, (cc) =>
      paintCombo(cc, count, tint, px, ds, joinOff, baseY),
    );
    // Anchor: drawImage(-joinOff, -baseY) from translate(joinX, baseline) scale(pop).
    if (spr)
      this.batch.push(
        joinX + pop * (w / 2 - joinOff),
        baseline + pop * (h / 2 - baseY),
        w * pop,
        h * pop,
        spr,
      );
  }

  private holdSkinOf(alive: boolean, roll: boolean): { skin: HoldSkin; variant: string } {
    if (!alive) return { skin: HOLD_GREY, variant: 'grey' };
    return roll ? { skin: HOLD_PURPLE, variant: 'purple' } : { skin: HOLD_GREEN, variant: 'green' };
  }

  private pushHoldBody(
    track: number,
    top: number,
    bottom: number,
    held: boolean,
    alive: boolean,
    roll: boolean,
    beatPulse: number,
  ): void {
    const { ds } = this;
    const b = this.batch;
    const x = this.laneX(track);
    const w = this.arrowS * 1.66;
    const h = Math.max(1, bottom - top);
    const capR = w * 0.48;
    const reverse = this.cfg.reverse;
    const { skin, variant } = this.holdSkinOf(alive, roll);
    const white = this.sprWhite();

    // Straight section stops capR short of the tail (rounded end); the cap
    // sprite finishes it. Reverse puts the tail — and so the cap — at the top.
    const capH = Math.min(capR, h);
    const bodyH = h - capH;
    const bodyTop = reverse ? top + capH : top;
    const bodyCenter = bodyTop + bodyH / 2;

    // Stream gradient: light→core→light across max(h, 220ds), like the 2D theme.
    const grad = this.sprGradStrip(`holdgrad:${variant}`, [
      [0, skin.light],
      [0.5, skin.core],
      [1, skin.light],
    ]);
    const span = Math.max(h, 220 * ds);
    if (grad && bodyH > 0) {
      const gradUV = cropUV(grad, 0, 0, 1, h / span);
      b.push(x, bodyCenter, w, bodyH, gradUV);
    }

    // Chevron + rail tile, anchored at the head end.
    const period = 17 * ds;
    const tile = this.atlas.sprite(`holdtile:${variant}:${Math.round(w)}`, w, period, (c) =>
      paintHoldTile(c, w, period, ds, skin),
    );
    if (tile && bodyH > 0)
      b.push(x, bodyCenter, w, bodyH, tile, 1, 1, 1, 1, {
        repeatV: bodyH / period,
        flipV: reverse,
      });

    // Cylindrical shading.
    const shade = this.sprGradStrip(
      'holdshade',
      [
        [0, 'rgba(0,0,0,0.32)'],
        [0.22, 'rgba(0,0,0,0)'],
        [0.5, 'rgba(255,255,255,0.10)'],
        [0.78, 'rgba(0,0,0,0)'],
        [1, 'rgba(0,0,0,0.32)'],
      ],
      true,
    );
    if (shade && bodyH > 0) b.push(x, bodyCenter, w, bodyH, shade);

    // Rounded tail cap (baked with gradient end, shading and outline).
    const cap = this.atlas.sprite(
      `holdcap:${variant}:${Math.round(w)}`,
      w + 4 * ds,
      capR + 2 * ds,
      (c) => {
        c.translate(2 * ds, -capR + 2 * ds);
        c.beginPath();
        c.roundRect(0, 0, w, 2 * capR - 2 * ds, [0, 0, capR, capR]);
        const g = c.createLinearGradient(0, 0, 0, 2 * capR);
        g.addColorStop(0, skin.core);
        g.addColorStop(1, skin.light);
        c.fillStyle = g;
        c.fill();
        const sh = c.createLinearGradient(0, 0, w, 0);
        sh.addColorStop(0, 'rgba(0,0,0,0.32)');
        sh.addColorStop(0.22, 'rgba(0,0,0,0)');
        sh.addColorStop(0.5, 'rgba(255,255,255,0.10)');
        sh.addColorStop(0.78, 'rgba(0,0,0,0)');
        sh.addColorStop(1, 'rgba(0,0,0,0.32)');
        c.fillStyle = sh;
        c.fill();
        c.strokeStyle = skin.outline;
        c.lineWidth = 1.8 * ds;
        c.stroke();
      },
    );
    if (cap && capH > 0) {
      const capCy = reverse ? top + capH / 2 : bottom - capH / 2;
      b.push(x, capCy, w + 4 * ds, capH + 2 * ds, cap, 1, 1, 1, 1, { flipV: reverse });
    }

    // Side outlines along the straight section.
    if (white && bodyH > 0) {
      const [or, og, ob, oa] = parseColor(skin.outline);
      b.push(x - w / 2, bodyCenter, 1.8 * ds, bodyH, white, or, og, ob, oa);
      b.push(x + w / 2, bodyCenter, 1.8 * ds, bodyH, white, or, og, ob, oa);
    }

    // Engaged shimmer washing with the beat.
    if (alive && held && white) {
      b.push(x, top + h / 2, w, h, white, 1, 1, 1, 0.08 + 0.14 * beatPulse);
    }
  }

  private pushMine(x: number, y: number, now: number, beatPulse: number): void {
    const { ds } = this;
    const b = this.batch;
    const r = this.arrowS * 0.62;
    const m = r + 12 * ds;
    const orb = this.atlas.sprite('mine:orb', 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintMineOrb(c, r, ds);
    });
    if (orb) b.push(x, y, 2 * m, 2 * m, orb);
    const arcs = this.atlas.sprite('mine:arcs', 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintMineArcs(c, r, ds);
    });
    if (arcs) b.push(x, y, 2 * m, 2 * m, arcs, 1, 1, 1, 1, { rot: now * 3 });
    const core = this.atlas.sprite('mine:core', 2 * r * 0.25, 2 * r * 0.25, (c) => {
      c.fillStyle = '#f0faff';
      c.beginPath();
      c.arc(r * 0.25, r * 0.25, r * 0.2, 0, Math.PI * 2);
      c.fill();
    });
    if (core) b.push(x, y, 2 * r * 0.25, 2 * r * 0.25, core, 1, 1, 1, 0.4 + 0.6 * beatPulse);
  }

  private pushExplosion(track: number, tns: TapNoteScore, k: number): void {
    const { ds } = this;
    const b = this.batch;
    const s = this.arrowS;
    const fade = 1 - k;
    const x = this.laneX(track);
    const y = this.receptorY;
    const m = s + 18 * ds;
    const boom = this.atlas.sprite('boom', 2 * m, 2 * m, (c) => {
      c.translate(m, m);
      paintBoom(c, s, ds);
    });
    const sc = 1 + 0.32 * k;
    if (boom)
      b.push(x, y, 2 * m * sc, 2 * m * sc, boom, 1, 1, 1, 0.42 * fade, {
        rot: this.angle(track),
        add: true,
      });
    // Four-point star: two tier-tinted diamonds + two brighter white ones.
    const ray = this.atlas.sprite('ray', 24, 48, (c) => {
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.moveTo(12, 0);
      c.lineTo(24, 24);
      c.lineTo(12, 48);
      c.lineTo(0, 24);
      c.closePath();
      c.fill();
    });
    if (!ray) return;
    const j = A3_JUDGMENT[tns];
    const [jr, jg, jb] = parseColor(j ? j.color : '#ffffff');
    const rr = s * (0.9 + 1.15 * k);
    const ww = s * 0.13 * fade;
    for (let i = 0; i < 2; i++) {
      const rot = Math.PI / 4 + (i * Math.PI) / 2;
      b.push(x, y, 2 * ww, 2 * rr, ray, jr, jg, jb, 0.25 * fade, { rot, add: true });
      b.push(x, y, 2 * ww * 0.6, 2 * rr * 0.92, ray, 1, 1, 1, 0.6 * fade, { rot, add: true });
    }
  }

  private pushGauge(judge: Judge, now: number, beatPulse: number): void {
    const { ds } = this;
    const b = this.batch;
    const fieldW = this.numTracks * this.colW;
    const cx = this.fieldLeft + fieldW / 2;
    const gw = fieldW + 1.6 * this.colW;
    const gh = 26 * ds;
    const gx = Math.max(6 * ds, cx - gw / 2);
    const gy = 12 * ds;
    const capL = 24 * ds;
    const capR = 16 * ds;
    const tx = gx + capL;
    const tw = gw - capL - capR;
    const life = judge.failed ? 0 : Math.max(0, Math.min(1, judge.life));
    const danger = !judge.failed && judge.life < 0.25;
    const hot = life >= 1;
    const o = 4 * ds;
    const sprW = gw + 8 * ds;
    const sprH = gh + 8 * ds;

    const chrome = this.atlas.sprite(`gauge:chrome:${Math.round(gw)}`, sprW, sprH, (c) =>
      paintGaugeChrome(c, gw, gh, ds, capL, capR),
    );
    if (chrome) b.push(gx - o + sprW / 2, gy - o + sprH / 2, sprW, sprH, chrome);

    const fillW = tw + 8 * ds;
    if (life > 0) {
      const fw = Math.max(2 * ds, fillW * life);
      const frac = Math.min(1, fw / fillW);
      // White chevron-pill segment shapes — the alpha mask every animated
      // fill layer clips against (what ctx.clip(segments) did in 2D).
      const mask = this.atlas.sprite(`gauge:mask:${Math.round(tw)}`, fillW, gh, (c) => {
        const path = new Path2D();
        traceSegments(path, tw, gh, ds);
        c.fillStyle = '#ffffff';
        c.fill(path);
      });
      const maskCrop = mask ? cropUV(mask, 0, 0, frac, 1) : null;
      if (danger) {
        if (maskCrop) {
          const a = 0.55 + 0.45 * beatPulse;
          b.push(tx + fw / 2, gy + gh / 2, fw, gh, maskCrop, 244 / 255, 32 / 255, 8 / 255, a);
        }
      } else if (hot) {
        // Maxed gauge: one baked color cycle scrolling through the segments
        // (period tw, like the 2D gradient that spanned off-tw..off+tw).
        const rainbow = this.atlas.sprite('gauge:rainbow', 256, 16, (c) => {
          const cycle = [
            '#ff2fd4',
            '#ff3a3a',
            '#ffd52a',
            '#2fe23a',
            '#2ad4ff',
            '#4a3aff',
            '#ff2fd4',
          ];
          const g = c.createLinearGradient(0, 0, 256, 0);
          for (let i = 0; i < cycle.length; i++) g.addColorStop(i / (cycle.length - 1), cycle[i]);
          c.fillStyle = g;
          c.fillRect(0, 0, 256, 16);
        });
        if (rainbow && maskCrop)
          b.push(tx + fw / 2, gy + gh / 2, fw, gh, rainbow, 1, 1, 1, 1, {
            repeatU: fw / tw,
            phaseU: -((now * 0.35) % 1),
            mask: maskCrop,
          });
      } else {
        const fill = this.atlas.sprite(`gauge:fill:${Math.round(tw)}`, fillW, gh, (c) => {
          const path = new Path2D();
          traceSegments(path, tw, gh, ds);
          c.save();
          c.clip(path);
          const sg = c.createLinearGradient(0, 0, 0, gh);
          sg.addColorStop(0, '#66f5b0');
          sg.addColorStop(0.45, '#0ddf75');
          sg.addColorStop(1, '#00a854');
          c.fillStyle = sg;
          c.fillRect(0, 0, fillW, gh);
          c.restore();
        });
        if (fill) b.push(tx + fw / 2, gy + gh / 2, fw, gh, cropUV(fill, 0, 0, frac, 1));
        // Flowing lighter bands drifting along the stream: the exact 2D band
        // parallelogram baked as one tile, scrolled with repeatU/phaseU,
        // clipped by the segment mask.
        const period = 56 * ds;
        const band = this.atlas.sprite(`gauge:band:${Math.round(gh)}`, period, gh, (c) => {
          c.fillStyle = '#ffffff';
          c.beginPath();
          c.moveTo(0, gh);
          c.lineTo(gh * 0.7, 0);
          c.lineTo(gh * 0.7 + 10 * ds, 0);
          c.lineTo(10 * ds, gh);
          c.closePath();
          c.fill();
        });
        if (band && maskCrop)
          b.push(tx + fw / 2, gy + gh / 2, fw, gh, band, 1, 1, 1, 0.22, {
            repeatU: fw / period,
            phaseU: -((now * 0.5) % 1),
            mask: maskCrop,
          });
        // Top sheen inside the fill, clipped to the segments like the 2D clip.
        const white = this.sprWhite();
        if (white && mask)
          b.push(tx + fw / 2, gy + 3.5 * ds, fw, 3 * ds, white, 1, 1, 1, 0.28, {
            mask: cropUV(mask, 0, (2 * ds) / gh, frac, (5 * ds) / gh),
          });
      }
    }

    const div = this.atlas.sprite(`gauge:div:${Math.round(tw)}`, fillW, gh, (c) =>
      paintGaugeDividers(c, tw, gh, ds),
    );
    if (div) b.push(tx + fillW / 2, gy + gh / 2, fillW, gh, div);
  }

  private pushSongPanel(
    progress: number,
    white: NonNullable<ReturnType<GpuNoteField['sprWhite']>>,
  ): void {
    const { ds, width, height } = this;
    const b = this.batch;
    const pw = Math.min(0.36 * width, 430 * ds);
    const ph = 52 * ds;
    const px = (width - pw) / 2;
    const py = height - ph - 8 * ds;
    const meta = this.cfg.meta;
    const spr = this.atlas.slot(
      'song',
      `${meta.title}|${meta.subtitle}|${Math.round(pw)}`,
      pw,
      ph,
      (c) => paintSongPanel(c, pw, ph, ds, meta.title, meta.subtitle),
    );
    if (spr) b.push(px + pw / 2, py + ph / 2, pw, ph, spr);
    const prog = Math.max(0, Math.min(1, progress));
    const barY = py + ph - 1.25 * ds;
    b.push(px + pw / 2, barY, pw, 2.5 * ds, white, 1, 1, 1, 0.12);
    if (prog > 0)
      b.push(
        px + (pw * prog) / 2,
        barY,
        pw * prog,
        2.5 * ds,
        white,
        216 / 255,
        182 / 255,
        42 / 255,
        0.9,
      );
  }

  private pushScorePanel(judge: Judge): void {
    const { ds, height } = this;
    const pw = 280 * ds;
    const px = 16 * ds;
    const rowH = 23 * ds;
    const scoreH = 38 * ds;
    const py = height - rowH - scoreH - 12 * ds;
    const m = 4 * ds;
    const digits = String(
      Math.max(0, Math.min(9999999, Math.round(judge.percentDancePoints * 1000000))),
    ).padStart(7, '0');
    const diff = this.cfg.meta.difficulty.toUpperCase();
    const grade = judge.grade;
    const w = pw + 2 * m;
    const h = rowH + scoreH + 2 * ds + 2 * m;
    const spr = this.atlas.slot(
      'score',
      `${digits}|${grade}|${diff}|${Math.round(pw)}`,
      w,
      h,
      (c) => paintScorePanel(c, pw, rowH, scoreH, ds, m, digits, diff, grade),
    );
    if (spr) this.batch.push(px - m + w / 2, py - m + h / 2, w, h, spr);
  }

  destroy(): void {
    this.lost = true;
    try {
      this.batch.destroy();
      this.media.destroy();
      this.atlas.destroy();
      this.device.destroy();
    } catch {
      // already lost
    }
  }
}
