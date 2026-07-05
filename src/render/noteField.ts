/**
 * Canvas note field orchestrator. Owns the per-frame loop and everything the
 * themes share — background compositing, the design-grid layout, scroll math
 * (render/scroll.ts), the forward-only cull cursor, and the
 * shared passes (holds, receptors, notes, explosions, combo pop-state) — and
 * delegates all styling to the active Theme (render/theme.ts): 'arcade' is the
 * DDR A3 look (render/themes/ddrA3.ts), 'itg' is Simply Love
 * (render/themes/simplyLove.ts). Configured with a single NoteFieldConfig
 * (defaults derive from DEFAULT_PLAY_OPTIONS, so renderer and session can't
 * drift). Purely presentational — reads the Judge, never mutates it. Works in
 * logical (CSS) pixels; the caller sets a devicePixelRatio transform via
 * resize().
 */

import { DEFAULT_PLAY_OPTIONS, type NoteSkin, type PlayOptions } from '../game/playOptions';
import type { Judge } from '../gameplay/judge';
import { getNoteType, noteRowToBeat, TapNoteType } from '../notes/noteTypes';
import { columnAnglesFor } from './columns';
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
} from './scroll';
import {
  RECEPTOR_FLASH,
  type Feedback,
  type FieldView,
  type RenderMeta,
  type Theme,
} from './theme';
import { DdrA3Theme } from './themes/ddrA3';
import { SimplyLoveTheme } from './themes/simplyLove';

export type { Feedback, RenderMeta } from './theme';

// Design grid: the playfield is authored on a 720px-tall reference layout and
// scaled by ds = min(height, width) / 720. Height sets the scale; the width
// term only clamps it so the field never overruns a narrow canvas; the floor
// keeps tiny canvases legible.
const DESIGN_SIZE = 720;
const MIN_DESIGN_SCALE = 0.5;
/** Lane width in design px. */
const LANE_W = 88;
/** Arrow half-extent in design px (an 80px arrow). */
const ARROW_HALF = 40;

/**
 * Renderer configuration: the render subset of the shared PlayOptions plus
 * renderer-only knobs. Defaults derive from DEFAULT_PLAY_OPTIONS — one source
 * of truth for noteSkin/scroll fallbacks (review finding #24).
 */
export interface NoteFieldConfig extends Pick<
  PlayOptions,
  'scrollMode' | 'scrollValue' | 'reverse' | 'noteSkin'
> {
  /** Peak BPM of the chart (drives MMod); see songMaxBpm() in render/scroll.ts. */
  songMaxBpm: number;
  /** Dark-overlay alpha on the background media (0 = full brightness, 1 = black). */
  bgDim: number;
  /** With no bg media, clear to transparent so a WebGPU layer behind shows. */
  transparentBg: boolean;
  /** Draw only the notefield (receptors + notes), no HUD — the Options preview. */
  bare: boolean;
  /** Per-column arrow rotation (radians); see render/columns.ts. */
  columnAngles: readonly number[];
  meta: RenderMeta;
}

export const DEFAULT_NOTE_FIELD_CONFIG: NoteFieldConfig = {
  scrollMode: DEFAULT_PLAY_OPTIONS.scrollMode,
  scrollValue: DEFAULT_PLAY_OPTIONS.scrollValue,
  reverse: DEFAULT_PLAY_OPTIONS.reverse,
  noteSkin: DEFAULT_PLAY_OPTIONS.noteSkin,
  songMaxBpm: FALLBACK_MAX_BPM,
  bgDim: 0.6,
  transparentBg: false,
  bare: false,
  columnAngles: [],
  meta: { title: '', subtitle: '', difficulty: '' },
};

function createTheme(skin: NoteSkin): Theme {
  return skin === 'itg' ? new SimplyLoveTheme() : new DdrA3Theme();
}

export class NoteFieldRenderer {
  width = 800;
  height = 720;
  private dpr = 1;
  private cfg: NoteFieldConfig;
  private theme: Theme;
  private background: HTMLVideoElement | HTMLImageElement | null = null;
  /** Forward-only cursor into the time-sorted notes; reset on geometry changes. */
  private firstVisibleIdx = 0;
  // Combo pop animation state (visual only), shared by every theme's overlay.
  private lastCombo = 0;
  private comboPopAt = -10;
  // Single mutable view/scroll-state instances, updated per frame — the hot
  // loops allocate nothing.
  private readonly view: FieldView;
  private readonly scroll: ScrollState;

  constructor(
    readonly numTracks: number,
    config: Partial<NoteFieldConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_NOTE_FIELD_CONFIG, ...config };
    if (this.cfg.songMaxBpm <= 0) this.cfg.songMaxBpm = FALLBACK_MAX_BPM;
    if (this.cfg.columnAngles.length === 0) this.cfg.columnAngles = columnAnglesFor('', numTracks);
    this.theme = createTheme(this.cfg.noteSkin);
    this.view = {
      width: this.width,
      height: this.height,
      ds: 1,
      numTracks,
      colW: LANE_W,
      arrowS: ARROW_HALF,
      fieldLeft: 0,
      receptorY: 0,
      reverse: this.cfg.reverse,
      bare: this.cfg.bare,
      nowSeconds: 0,
      nowBeat: 0,
      beatPulse: 0,
      meta: this.cfg.meta,
      laneX: (track) => this.view.fieldLeft + this.view.colW / 2 + track * this.view.colW,
      angle: (track) => this.cfg.columnAngles[track] ?? 0,
    };
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
  }

  /**
   * Apply a (partial) configuration change. Geometry-affecting changes reset
   * the cull cursor so notes can't vanish when scroll slows down or flips.
   * Cheap when nothing changed — the Options preview calls this every frame.
   */
  applyConfig(patch: Partial<NoteFieldConfig>): void {
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
    if (patch.noteSkin !== undefined && patch.noteSkin !== c.noteSkin) {
      c.noteSkin = patch.noteSkin;
      this.theme = createTheme(patch.noteSkin);
      resetCursor = true;
    }
    if (patch.bare !== undefined) c.bare = patch.bare;
    if (patch.bgDim !== undefined) c.bgDim = Math.max(0, Math.min(1, patch.bgDim));
    if (patch.transparentBg !== undefined) c.transparentBg = patch.transparentBg;
    if (patch.columnAngles !== undefined) c.columnAngles = patch.columnAngles;
    if (patch.meta !== undefined) c.meta = patch.meta;
    this.layout();
    if (resetCursor) this.firstVisibleIdx = 0;
  }

  /** Background video/image drawn behind the field, or null. */
  setBackground(media: HTMLVideoElement | HTMLImageElement | null): void {
    this.background = media;
  }

  resize(width: number, height: number, dpr = 1): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.layout();
    // Culling depends on the canvas extent — start the window scan over.
    this.firstVisibleIdx = 0;
  }

  /** Recompute the derived layout in the view + scroll state (no allocation). */
  private layout(): void {
    const ds = Math.max(
      MIN_DESIGN_SCALE,
      Math.min(this.height / DESIGN_SIZE, this.width / DESIGN_SIZE),
    );
    const v = this.view;
    v.width = this.width;
    v.height = this.height;
    v.ds = ds;
    v.colW = LANE_W * ds;
    v.arrowS = ARROW_HALF * ds;
    v.reverse = this.cfg.reverse;
    v.bare = this.cfg.bare;
    v.meta = this.cfg.meta;
    const off = this.theme.receptorOffset * ds;
    v.receptorY = this.cfg.reverse ? this.height - off : off;
    v.fieldLeft = this.theme.fieldLeft(v);
    const s = this.scroll;
    s.mode = this.cfg.scrollMode;
    s.value = this.cfg.scrollValue;
    s.songMaxBpm = this.cfg.songMaxBpm;
    s.reverse = this.cfg.reverse;
    s.receptorY = v.receptorY;
    s.height = this.height;
  }

  private drawBackground(
    ctx: CanvasRenderingContext2D,
    bg: HTMLVideoElement | HTMLImageElement,
  ): void {
    let bw = 0;
    let bh = 0;
    if (bg instanceof HTMLVideoElement) {
      bw = bg.videoWidth;
      bh = bg.videoHeight;
    } else {
      bw = bg.naturalWidth;
      bh = bg.naturalHeight;
    }
    if (bw <= 0 || bh <= 0) return;
    const scale = Math.max(this.width / bw, this.height / bh);
    const dw = bw * scale;
    const dh = bh * scale;
    ctx.drawImage(bg, (this.width - dw) / 2, (this.height - dh) / 2, dw, dh);
    // Dim so arrows stay readable (configurable via bgMode; design default .6).
    ctx.fillStyle = `rgba(5,6,8,${this.cfg.bgDim})`;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  draw(
    ctx: CanvasRenderingContext2D,
    judge: Judge,
    now: number,
    beat: number,
    progress: number,
    fb: Feedback,
  ): void {
    const { width, height } = this;
    const v = this.view;
    const s = this.scroll;
    v.nowSeconds = now;
    v.nowBeat = beat;
    // Sawtooth beat pulse: peaks on each beat, decays linearly to the next.
    v.beatPulse = 1 - (beat - Math.floor(beat));
    s.nowSeconds = now;
    s.nowBeat = beat;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;

    // Background: dimmed media, transparent (WebGPU layer behind), or solid dark.
    if (this.background) {
      ctx.clearRect(0, 0, width, height);
      try {
        this.drawBackground(ctx, this.background);
      } catch {
        ctx.fillStyle = '#0b0c0e';
        ctx.fillRect(0, 0, width, height);
      }
    } else if (this.cfg.transparentBg) {
      ctx.clearRect(0, 0, width, height);
    } else {
      ctx.fillStyle = '#0b0c0e';
      ctx.fillRect(0, 0, width, height);
    }

    const theme = this.theme;
    theme.drawFieldChrome(ctx, v, judge);
    if (!this.cfg.bare) {
      // Combo pop-state (visual only), shared by every theme's HUD hooks.
      if (judge.combo !== this.lastCombo) {
        if (judge.combo > this.lastCombo) this.comboPopAt = now;
        this.lastCombo = judge.combo;
      }
      theme.drawHudUnderlay(ctx, v, judge, progress, fb, this.comboPopAt);
    }

    // Advance the visible-window cursor past notes that have scrolled off the
    // exit side (their tail included) — O(visible) drawing.
    const notes = judge.notes;
    this.firstVisibleIdx = advanceCursor(s, notes, this.firstVisibleIdx);

    // Holds behind arrows (windowed).
    for (let i = this.firstVisibleIdx; i < notes.length; i++) {
      const n = notes[i];
      let headY = yOf(s, n.time, n.beat);
      if (notYet(s, headY)) break;
      if (!shouldDrawHoldBody(n)) continue;
      const tailY = yOf(s, n.tailTime, noteRowToBeat(n.tailRow));
      const held = holdIsHeld(n, now);
      if (held) headY = v.receptorY;
      const top = Math.min(headY, tailY);
      const bottom = Math.max(headY, tailY);
      theme.drawHoldBody(ctx, v, n.track, top, bottom, held, holdIsAlive(n), n.isRoll);
    }

    // Receptors; a recent press flashes/dips them for RECEPTOR_FLASH seconds.
    for (let t = 0; t < this.numTracks; t++) {
      const flashAge = now - (fb.laneFlash[t] ?? -1);
      const pressed = flashAge >= 0 && flashAge < RECEPTOR_FLASH;
      theme.drawReceptor(ctx, v, t, pressed);
    }

    // Notes, mines and hold heads (windowed). Freeze heads follow the DDR
    // lifecycle: they scroll in, sit pinned ON the receptor while the hold is
    // engaged, grey out and scroll off when dropped, and vanish once Held.
    for (let i = this.firstVisibleIdx; i < notes.length; i++) {
      const n = notes[i];
      const isHoldHead = n.note.type === TapNoteType.HoldHead;
      const headState = isHoldHead ? holdHeadState(n, now) : null;
      if (headState === 'gone') continue;
      const engaged = headState === 'engaged';
      const y = engaged ? v.receptorY : yOf(s, n.time, n.beat);
      if (!engaged) {
        if (notYet(s, y)) break;
        if (passed(s, y)) continue;
      }
      if (!isHoldHead && !shouldDrawNote(n)) continue;
      if (n.note.type === TapNoteType.Mine) theme.drawMine(ctx, v, v.laneX(n.track), y);
      else
        theme.drawTapNote(
          ctx,
          v,
          n.track,
          y,
          getNoteType(n.row),
          isHoldHead ? (headState === 'dropped' ? 'deadHead' : 'holdHead') : 'tap',
        );
    }

    // Hit explosions over the receptors.
    for (let t = 0; t < this.numTracks; t++) {
      const hit = fb.laneHit[t];
      if (!hit) continue;
      const age = now - hit.atSeconds;
      if (age < 0 || age >= theme.explosionSeconds) continue;
      theme.drawExplosion(ctx, v, t, hit.tns, age / theme.explosionSeconds);
    }

    if (!this.cfg.bare) theme.drawHudOverlay(ctx, v, judge, progress, fb, this.comboPopAt);
  }
}
