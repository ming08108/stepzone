/**
 * Canvas note field: directional arrows colored by quantization, pulsing
 * receptors, hit flashes, holds, and a full-screen HUD. Two selectable styles
 * (setStyle): 'arcade' — the left-aligned STEPLINE panel — and 'itg' — a
 * centered Simply Love (ITGmania) field: cel-noteskin arrows plus the SL
 * gameplay HUD (black header, LifeMeterBar, Wendy score, step-density graph).
 * Upscroll, constant-time (CMod) spacing. See spec doc 8. Purely presentational
 * — reads the Judge, never mutates it. Works in logical (CSS) pixels; the caller
 * sets a devicePixelRatio transform via resize().
 */

import type { ActiveNote, Judge } from '../gameplay/judge';
import {
  getNoteType,
  noteRowToBeat,
  NoteType,
  TapNoteScore,
  TapNoteType,
} from '../notes/noteTypes';

// STEPLINE note quantization palette (4th red, 8th blue, 12th purple, 16th green).
const QUANT_COLOR: Record<NoteType, string> = {
  [NoteType.N4TH]: '#ff4455',
  [NoteType.N8TH]: '#3d7bff',
  [NoteType.N12TH]: '#c86bff',
  [NoteType.N16TH]: '#59f07f',
  [NoteType.N24TH]: '#ff9d3d',
  [NoteType.N32ND]: '#ff9d3d',
  [NoteType.N48TH]: '#ff9d3d',
  [NoteType.N64TH]: '#ff9d3d',
  [NoteType.N192ND]: '#ff9d3d',
};

// ITG note quantization palette (classic StepMania/ITG noteskin colors).
const ITG_QUANT_COLOR: Record<NoteType, string> = {
  [NoteType.N4TH]: '#ff2f2f',
  [NoteType.N8TH]: '#3d7bff',
  [NoteType.N12TH]: '#c44cff',
  [NoteType.N16TH]: '#41d94b',
  [NoteType.N24TH]: '#ff5fdd',
  [NoteType.N32ND]: '#ffa93d',
  [NoteType.N48TH]: '#3df0ff',
  [NoteType.N64TH]: '#9aa0a8',
  [NoteType.N192ND]: '#9aa0a8',
};

// STEPLINE judgment colors.
const JUDGMENT: Record<number, { label: string; color: string }> = {
  [TapNoteScore.W1]: { label: 'FANTASTIC', color: '#38f0ff' },
  [TapNoteScore.W2]: { label: 'EXCELLENT', color: '#ffd23d' },
  [TapNoteScore.W3]: { label: 'GREAT', color: '#59f07f' },
  [TapNoteScore.W4]: { label: 'DECENT', color: '#c86bff' },
  [TapNoteScore.W5]: { label: 'WAY OFF', color: '#ff9d3d' },
  [TapNoteScore.Miss]: { label: 'MISS', color: '#ff4d3d' },
  [TapNoteScore.HitMine]: { label: 'MINE!', color: '#ff4d3d' },
};

// ITG judgment tiers: title-case labels in the SL.JudgmentColors["ITG"] set.
const ITG_JUDGMENT: Record<number, { label: string; color: string }> = {
  [TapNoteScore.W1]: { label: 'Fantastic', color: '#21cce8' },
  [TapNoteScore.W2]: { label: 'Excellent', color: '#e29c18' },
  [TapNoteScore.W3]: { label: 'Great', color: '#66c955' },
  [TapNoteScore.W4]: { label: 'Decent', color: '#b45cff' },
  [TapNoteScore.W5]: { label: 'Way Off', color: '#c9855e' },
  [TapNoteScore.Miss]: { label: 'Miss', color: '#ff3030' },
  [TapNoteScore.HitMine]: { label: 'Mine!', color: '#ff3030' },
};

/** Arrow rotation per dance-single column: Left, Down, Up, Right. */
const ANGLES = [-Math.PI / 2, Math.PI, 0, Math.PI / 2];

const SPACING = 64; // base pixels per beat (ITG ARROW_SPACING)
const RECEPTOR_FLASH = 0.11; // seconds the receptor stays lit after a press
const EXPLOSION = 0.26; // seconds for the hit explosion ring/glow
const ITG_EXPLOSION = 0.22; // seconds for the cel-style hit explosion bloom
const JUDGMENT_LIFE = 0.7; // seconds the judgment label shows (design keyframes)
const SL_JUDGMENT_LIFE = 0.9; // SL judgment tween: pop 0.1s, hold ~0.67s, shrink 0.2s
const DRAW_CULL = 100; // px beyond the field before a note is culled

export interface Feedback {
  lastJudgment: { tns: TapNoteScore; atSeconds: number } | null;
  /** Per-column time (s) of the last press, for the receptor glow. */
  laneFlash: number[];
  /** Per-column last successful hit, for the explosion. */
  laneHit: Array<{ tns: TapNoteScore; atSeconds: number } | null>;
}

export interface RenderMeta {
  title: string;
  subtitle: string;
  difficulty: string;
}

function traceArrow(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(-s, 0);
  ctx.lineTo(-0.42 * s, 0);
  ctx.lineTo(-0.42 * s, 0.78 * s);
  ctx.lineTo(0.42 * s, 0.78 * s);
  ctx.lineTo(0.42 * s, 0);
  ctx.lineTo(s, 0);
  ctx.closePath();
}

// Simply Love palette bits used by the ITG-style HUD.
const SL_ACCENT = '#ff5d47'; // SL.Colors[1] — the signature coral
const SL_GRAPH_BG = '#1e282f'; // density-graph backing (SL UpperNPSGraph quad)
const SL_GRAPH_LO = '#00adc0'; // histogram base color (SL-Histogram "blue")
const SL_GRAPH_HI = '#8200a1'; // histogram peak color (SL-Histogram "purple")
// SL full-combo pulse pairs (Player combo.lua): all-Fantastic blue,
// all-Excellent gold, all-Great green; anything less is plain white.
const SL_COMBO_W1: readonly [string, string] = ['#c8ffff', '#6bf0ff'];
const SL_COMBO_W2: readonly [string, string] = ['#fdffc9', '#fddb85'];
const SL_COMBO_W3: readonly [string, string] = ['#c9ffc9', '#94fec1'];

/**
 * ITG "cel" noteskin arrow geometry, traced from the noteskin's tap-note mesh
 * ("_down tap note model.txt"): three concentric rings — the notched-chevron
 * silhouette, the bevel band, and the flat front face — normalized to a
 * half-extent of 1 (model units / 32), tip up like traceArrow.
 */
type CelRing = ReadonlyArray<readonly [number, number]>;
const CEL_OUTLINE: CelRing = [
  [0, -0.971],
  [1.002, 0.031],
  [0.594, 0.44],
  [0.344, 0.19],
  [0.344, 0.938],
  [-0.344, 0.938],
  [-0.344, 0.19],
  [-0.594, 0.44],
  [-1.002, 0.031],
];
const CEL_BEVEL: CelRing = [
  [0, -0.883],
  [0.914, 0.031],
  [0.594, 0.351],
  [0.281, 0.039],
  [0.281, 0.875],
  [-0.281, 0.875],
  [-0.281, 0.039],
  [-0.594, 0.351],
  [-0.914, 0.031],
];
const CEL_FACE: CelRing = [
  [0, -0.75],
  [0.781, 0.031],
  [0.594, 0.219],
  [0.188, -0.188],
  [0.188, 0.781],
  [-0.188, 0.781],
  [-0.188, -0.188],
  [-0.594, 0.219],
  [-0.781, 0.031],
];

function traceCel(ctx: CanvasRenderingContext2D, s: number, ring: CelRing): void {
  ctx.beginPath();
  ctx.moveTo(ring[0][0] * s, ring[0][1] * s);
  for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0] * s, ring[i][1] * s);
  ctx.closePath();
}

/** Linear blend between two #rrggbb colors, t in [0,1]. */
function lerpHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => {
    const va = (pa >> shift) & 255;
    const vb = (pb >> shift) & 255;
    return Math.round(va + (vb - va) * t);
  };
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/** Styling for one arrow draw. Widths are in design units (80px arrow), ds-scaled. */
interface ArrowStyle {
  fill?: string | null;
  stroke?: string | null;
  lineWidth?: number;
  alpha?: number;
  /** Inner-outline color (the STEPLINE noteskin signature); omit for none. */
  inner?: string | null;
  innerWidth?: number;
  /** Soft drop shadow under the body so notes pop off the background. */
  shadow?: boolean;
  /** Glow color for hit explosions (applied to fill and stroke). */
  glow?: string | null;
  glowBlur?: number;
}

export class NoteFieldRenderer {
  width = 800;
  height = 720;
  private dpr = 1;
  private meta: RenderMeta = { title: '', subtitle: '', difficulty: '' };
  private bare = false; // skip the HUD (life/progress/score/combo/judgment) — preview

  private receptorY = 90;
  private colW = 110;
  private arrowS = 46;
  // STEPLINE: left-aligned arcade P1 playfield, scaled to the canvas height.
  private ds = 1;
  private fieldLeft = 144;
  private panelLeft = 132;
  private panelWidth = 400;

  // Scroll: C = constant px/sec, X = px/beat * multiplier, M = X scaled to the
  // song's peak BPM (so the fastest section scrolls at the target rate).
  private scrollMode: 'C' | 'X' | 'M' = 'C';
  private scrollValue = 550;
  private songMaxBpm = 200;
  private nowSeconds = 0;
  private nowBeat = 0;
  private columnAngles: number[] = [];
  private background: HTMLVideoElement | HTMLImageElement | null = null;
  private bgDim = 0.6; // dark overlay alpha on the song background
  private transparentBg = false; // let a WebGPU layer behind show through
  private reverse = false; // downscroll: receptors at the bottom
  private appearance: 'visible' | 'hidden' | 'sudden' = 'visible';
  private style: 'arcade' | 'itg' = 'arcade';
  private firstVisibleIdx = 0; // forward-only cursor into the time-sorted notes
  // Combo pop animation state (visual only).
  private lastCombo = 0;
  private comboPopAt = -10;
  // Cached per-measure NPS histogram for the SL step-density graph.
  private density: {
    src: unknown;
    bins: Array<{ t0: number; t1: number; h: number }>;
    lastT: number;
  } | null = null;

  constructor(readonly numTracks: number) {}

  setMeta(meta: RenderMeta): void {
    this.meta = meta;
  }

  setScroll(mode: 'C' | 'X' | 'M', value: number, songMaxBpm = 200): void {
    this.scrollMode = mode;
    this.scrollValue = value;
    this.songMaxBpm = songMaxBpm > 0 ? songMaxBpm : 200;
  }

  /** Per-column arrow rotation (radians); see render/columns.ts. */
  setColumnAngles(angles: number[]): void {
    this.columnAngles = angles;
  }

  /** Background video/image drawn behind the field, or null. */
  setBackground(media: HTMLVideoElement | HTMLImageElement | null): void {
    this.background = media;
  }

  /** Dark-overlay alpha on the background (0 = full brightness, 1 = black). */
  setBgDim(dim: number): void {
    this.bgDim = Math.max(0, Math.min(1, dim));
  }

  /** When true (and no bg media), clear to transparent so a WebGPU layer shows. */
  setTransparentBg(v: boolean): void {
    this.transparentBg = v;
  }

  /** Reverse (downscroll) puts the receptors at the bottom. */
  setReverse(v: boolean): void {
    this.reverse = v;
  }

  /** Appearance mod: fade arrows near ('hidden') or far from ('sudden') the receptor. */
  setAppearance(a: 'visible' | 'hidden' | 'sudden'): void {
    this.appearance = a;
  }

  /** Note field style: 'arcade' (STEPLINE panel) or 'itg' (centered ITGmania). */
  setStyle(style: 'arcade' | 'itg'): void {
    this.style = style;
  }

  /** Draw only the notefield (receptors + notes), no HUD — used by the preview. */
  setBare(bare: boolean): void {
    this.bare = bare;
  }

  resize(width: number, height: number, dpr = 1): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    // STEPLINE: a left-aligned arcade P1 playfield, scaled to the canvas height
    // (design reference is 1280×720). Clamp so it never overruns a narrow canvas.
    const ds = Math.max(0.5, Math.min(height / 720, width / 720));
    this.ds = ds;
    this.colW = 88 * ds; // lane width (design: 88)
    this.arrowS = 40 * ds; // 80px arrow, half-extent
    this.panelLeft = 132 * ds;
    this.fieldLeft = this.panelLeft + 12 * ds; // lanes inset 12 into the panel
    this.panelWidth = (this.numTracks * 88 + 24) * ds;
    this.receptorY = 96 * ds;
  }

  private laneX(track: number): number {
    // ITG centers a single playfield; arcade left-aligns it in a side panel.
    const left =
      this.style === 'itg' ? (this.width - this.numTracks * this.colW) / 2 : this.fieldLeft;
    return left + this.colW / 2 + track * this.colW;
  }

  private angle(track: number): number {
    return this.columnAngles[track] ?? ANGLES[track] ?? 0;
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
    ctx.fillStyle = `rgba(5,6,8,${this.bgDim})`;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  /** Effective receptor Y (bottom of the field under reverse). The Simply
   *  Love layout seats the receptors just under its 110px header (SL puts its
   *  header at 80/480 of the screen); the bare preview keeps them high. */
  private recY(): number {
    const off = this.style === 'itg' && !this.bare ? 176 * this.ds : this.receptorY;
    return this.reverse ? this.height - off : off;
  }

  private yOf(timeSeconds: number, beatValue: number): number {
    const rec = this.recY();
    const dir = this.reverse ? -1 : 1;
    if (this.scrollMode === 'C') {
      const pxPerSec = (this.scrollValue / 60) * SPACING;
      return rec + dir * (timeSeconds - this.nowSeconds) * pxPerSec;
    }
    // X: multiplier is scrollValue. M: multiplier fits the peak BPM to the target.
    const mult = this.scrollMode === 'M' ? this.scrollValue / this.songMaxBpm : this.scrollValue;
    return rec + dir * (beatValue - this.nowBeat) * SPACING * mult;
  }

  /** Alpha for hidden/sudden mods: 0 at the receptor (hidden) or far away (sudden). */
  private appearanceAlpha(y: number): number {
    if (this.appearance === 'visible') return 1;
    const p = Math.abs(y - this.recY()) / Math.max(1, this.height);
    const step = (a: number, b: number, x: number) => Math.max(0, Math.min(1, (x - a) / (b - a)));
    return this.appearance === 'hidden' ? step(0.12, 0.4, p) : 1 - step(0.5, 0.78, p);
  }

  /** Has this y scrolled off the exit side of the field? */
  private passed(y: number): boolean {
    return this.reverse ? y > this.height + DRAW_CULL : y < -DRAW_CULL;
  }

  /** Is this y not yet on screen (still approaching)? */
  private notYet(y: number): boolean {
    return this.reverse ? y < -DRAW_CULL : y > this.height + DRAW_CULL;
  }

  private arrow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    track: number,
    scale: number,
    style: ArrowStyle,
  ): void {
    const {
      fill = null,
      stroke = null,
      lineWidth = 5,
      alpha = 1,
      inner = null,
      innerWidth = 3.5,
      shadow = false,
      glow = null,
      glowBlur = 16,
    } = style;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(this.angle(track));
    ctx.scale(scale, scale);
    if (glow) {
      ctx.shadowColor = glow;
      ctx.shadowBlur = glowBlur * this.ds;
    } else if (shadow) {
      // Design: drop-shadow(0 2px 6px rgba(0,0,0,.5)) so notes pop off the bg.
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 6 * this.ds;
      ctx.shadowOffsetY = 2 * this.ds;
    }
    traceArrow(ctx, this.arrowS);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.lineWidth = lineWidth * this.ds;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
    if (inner) {
      if (shadow && !glow) {
        // The inner outline should not re-cast the drop shadow.
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
      }
      // STEPLINE signature: an inner outline (arrow scaled 0.72 about center).
      ctx.scale(0.72, 0.72);
      traceArrow(ctx, this.arrowS);
      ctx.lineWidth = (innerWidth * this.ds) / 0.72;
      ctx.strokeStyle = inner;
      ctx.stroke();
    }
    ctx.restore();
  }

  draw(
    ctx: CanvasRenderingContext2D,
    judge: Judge,
    now: number,
    beat: number,
    progress: number,
    fb: Feedback,
  ): void {
    const { width, height, ds } = this;
    this.nowSeconds = now;
    this.nowBeat = beat;
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
    } else if (this.transparentBg) {
      ctx.clearRect(0, 0, width, height);
    } else {
      ctx.fillStyle = '#0b0c0e';
      ctx.fillRect(0, 0, width, height);
    }

    // ITG style: centered field, flat arrows, restrained feedback.
    if (this.style === 'itg') {
      this.drawItg(ctx, judge, now, beat, progress, fb);
      return;
    }

    // Sawtooth beat pulse: peaks on each beat, decays linearly to the next.
    const beatPulse = 1 - (beat - Math.floor(beat));
    const recY = this.recY();

    // STEPLINE left-aligned playfield panel: translucent dark with hairline sides.
    const pL = this.panelLeft;
    const pR = this.panelLeft + this.panelWidth;
    ctx.fillStyle = 'rgba(5,6,8,0.55)';
    ctx.fillRect(pL, 0, this.panelWidth, height);
    // Faint lane separators give the field its arcade structure.
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = 1; t < this.numTracks; t++) {
      const x = Math.round(this.fieldLeft + t * this.colW) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.beginPath();
    ctx.moveTo(pL + 0.5, 0);
    ctx.lineTo(pL + 0.5, height);
    ctx.moveTo(pR - 0.5, 0);
    ctx.lineTo(pR - 0.5, height);
    ctx.stroke();
    // Scrims seat the life bar / progress bar against bright backgrounds.
    let scrim = ctx.createLinearGradient(0, 0, 0, 110 * ds);
    scrim.addColorStop(0, 'rgba(5,6,8,0.6)');
    scrim.addColorStop(1, 'rgba(5,6,8,0)');
    ctx.fillStyle = scrim;
    ctx.fillRect(pL, 0, this.panelWidth, 110 * ds);
    scrim = ctx.createLinearGradient(0, height - 90 * ds, 0, height);
    scrim.addColorStop(0, 'rgba(5,6,8,0)');
    scrim.addColorStop(1, 'rgba(5,6,8,0.6)');
    ctx.fillStyle = scrim;
    ctx.fillRect(pL, height - 90 * ds, this.panelWidth, 90 * ds);
    // Receptor band, breathing gently with the beat.
    ctx.fillStyle = `rgba(255,255,255,${(0.03 + 0.025 * beatPulse).toFixed(3)})`;
    ctx.fillRect(pL, recY - 44 * ds, this.panelWidth, 88 * ds);

    // Advance the visible-window cursor past notes that have scrolled off the
    // exit side (their tail included). Notes are time-sorted and scroll is
    // monotonic, so this only moves forward — O(visible) drawing (todo #14).
    const notes = judge.notes;
    while (this.firstVisibleIdx < notes.length) {
      const n = notes[this.firstVisibleIdx];
      const endY =
        n.note.type === TapNoteType.HoldHead
          ? this.yOf(n.tailTime, noteRowToBeat(n.tailRow))
          : this.yOf(n.time, n.beat);
      if (this.passed(endY)) this.firstVisibleIdx++;
      else break;
    }

    // Holds behind arrows (windowed).
    for (let i = this.firstVisibleIdx; i < notes.length; i++) {
      const n = notes[i];
      if (this.notYet(this.yOf(n.time, n.beat))) break;
      if (n.note.type === TapNoteType.HoldHead && !n.holdResolved) this.drawHold(ctx, n);
    }

    // Receptors: stroke brightness pulses on the beat (design: .4 + .45·pulse);
    // a press flashes the fill bright white for ~110ms and dips the scale.
    const recStroke = `rgba(236,236,236,${(0.4 + 0.45 * beatPulse).toFixed(3)})`;
    for (let t = 0; t < this.numTracks; t++) {
      const x = this.laneX(t);
      const flashAge = now - (fb.laneFlash[t] ?? -1);
      const pressed = flashAge >= 0 && flashAge < RECEPTOR_FLASH;
      this.arrow(ctx, x, recY, t, pressed ? 0.94 : 1, {
        fill: pressed ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.05)',
        stroke: pressed ? 'rgba(236,236,236,0.95)' : recStroke,
        lineWidth: 5,
        inner: 'rgba(236,236,236,0.25)',
        innerWidth: 4,
      });
    }

    // Notes and unhit hold heads (windowed).
    for (let i = this.firstVisibleIdx; i < notes.length; i++) {
      const n = notes[i];
      const y = this.yOf(n.time, n.beat);
      if (this.notYet(y)) break;
      if (this.passed(y)) continue;
      if (n.note.type === TapNoteType.HoldHead) {
        if (n.holdResolved || n.tns !== TapNoteScore.None) continue;
      } else if (n.hidden || n.note.type === TapNoteType.AutoKeysound) {
        continue;
      }
      const a = this.appearanceAlpha(y);
      if (a <= 0.01) continue;
      if (n.note.type === TapNoteType.Mine) this.drawMine(ctx, this.laneX(n.track), y);
      else {
        this.arrow(ctx, this.laneX(n.track), y, n.track, 1, {
          fill: QUANT_COLOR[getNoteType(n.row)],
          stroke: '#0a0b0d',
          lineWidth: 6,
          alpha: a,
          inner: 'rgba(255,255,255,0.92)',
          shadow: true,
        });
      }
    }

    // Hit explosions: an additive glow ghost plus an expanding, fading ring in
    // the judgment color over the receptor.
    for (let t = 0; t < this.numTracks; t++) {
      const hit = fb.laneHit[t];
      if (!hit) continue;
      const age = now - hit.atSeconds;
      if (age < 0 || age >= EXPLOSION) continue;
      const k = age / EXPLOSION;
      const fade = 1 - k;
      const j = JUDGMENT[hit.tns];
      const color = j ? j.color : '#ffffff';
      const x = this.laneX(t);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this.arrow(ctx, x, recY, t, 1 + k * 0.4, {
        fill: color,
        alpha: 0.45 * fade,
        glow: color,
        glowBlur: 26,
      });
      ctx.restore();
      this.arrow(ctx, x, recY, t, 1 + k * 0.7, {
        stroke: color,
        lineWidth: 5,
        alpha: fade,
        glow: color,
        glowBlur: 20,
      });
    }

    if (!this.bare) this.drawHud(ctx, judge, now, progress, fb);
  }

  private drawHold(ctx: CanvasRenderingContext2D, n: ActiveNote): void {
    const x = this.laneX(n.track);
    let headY = this.yOf(n.time, n.beat);
    const tailY = this.yOf(n.tailTime, noteRowToBeat(n.tailRow));
    const held = n.holdInitiated && this.nowSeconds >= n.time;
    if (held) headY = this.recY();
    const top = Math.min(headY, tailY);
    const bottom = Math.max(headY, tailY);
    const alive = !n.holdInitiated || n.holdLife > 0;
    if (this.style === 'itg') {
      // Cel hold: a light silver tube with dark side rims and a rounded tail
      // cap ("Down Hold Body Active.png"); grey once dropped, aglow while held.
      const w = this.arrowS * 1.5;
      const r = w / 2;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(
        x - w / 2,
        top,
        w,
        Math.max(1, bottom - top),
        this.reverse ? [r, r, 0, 0] : [0, 0, r, r],
      );
      const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
      if (alive) {
        g.addColorStop(0, 'rgba(148,154,162,0.95)');
        g.addColorStop(0.18, 'rgba(238,240,244,0.95)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.95)');
        g.addColorStop(0.82, 'rgba(210,214,220,0.95)');
        g.addColorStop(1, 'rgba(128,133,141,0.95)');
      } else {
        g.addColorStop(0, 'rgba(70,72,78,0.8)');
        g.addColorStop(0.5, 'rgba(118,122,128,0.8)');
        g.addColorStop(1, 'rgba(70,72,78,0.8)');
      }
      if (alive && held) {
        // Hold explosion glow while the lane is engaged.
        ctx.shadowColor = 'rgba(255,255,255,0.6)';
        ctx.shadowBlur = 12 * this.ds;
      }
      ctx.fillStyle = g;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2 * this.ds;
      ctx.strokeStyle = alive ? '#14161a' : 'rgba(20,22,26,0.6)';
      ctx.stroke();
      ctx.restore();
      return;
    }
    const w = this.arrowS;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x - w / 2, top, w, Math.max(0, bottom - top), w / 2);
    if (alive && held) {
      // Actively held: glow so the lane reads as engaged.
      ctx.shadowColor = 'rgba(89,240,127,0.7)';
      ctx.shadowBlur = 14 * this.ds;
    }
    ctx.fillStyle = alive ? 'rgba(89,240,127,0.35)' : 'rgba(120,120,120,0.3)';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    if (alive) {
      ctx.strokeStyle = held ? 'rgba(89,240,127,0.9)' : 'rgba(89,240,127,0.6)';
      ctx.lineWidth = 2 * this.ds;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawMine(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    if (this.style === 'itg') {
      // Cel mine: a dark metal orb with three rotating shell plates and a
      // red core pulsing on the beat ("_mine tex.png" / "_mine model.txt").
      const r = this.arrowS * 0.66;
      const beatPulse = 1 - (this.nowBeat - Math.floor(this.nowBeat));
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(this.nowSeconds * 2.2);
      const body = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.15, 0, 0, r);
      body.addColorStop(0, '#4c5058');
      body.addColorStop(0.7, '#26282e');
      body.addColorStop(1, '#101114');
      ctx.fillStyle = body;
      ctx.strokeStyle = '#0c0d10';
      ctx.lineWidth = 2.5 * this.ds;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#b4b8c0';
      ctx.lineWidth = r * 0.3;
      for (let i = 0; i < 3; i++) {
        const a0 = (i / 3) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.68, a0 + 0.35, a0 + (Math.PI * 2) / 3 - 0.35);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(255,48,48,${(0.55 + 0.45 * beatPulse).toFixed(3)})`;
      ctx.shadowColor = 'rgba(255,48,48,0.8)';
      ctx.shadowBlur = 10 * this.ds * (0.5 + beatPulse);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    const r = this.arrowS * 0.8;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(this.nowSeconds * 1.6); // slow menacing spin
    const core = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r);
    core.addColorStop(0, 'rgba(255,120,110,0.55)');
    core.addColorStop(0.65, 'rgba(160,20,20,0.35)');
    core.addColorStop(1, 'rgba(60,4,4,0.25)');
    ctx.fillStyle = core;
    ctx.strokeStyle = '#ff4d3d';
    ctx.lineWidth = 3 * this.ds;
    ctx.shadowColor = 'rgba(255,77,61,0.6)';
    ctx.shadowBlur = 10 * this.ds;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Spikes.
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.moveTo(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55);
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawHud(
    ctx: CanvasRenderingContext2D,
    judge: Judge,
    now: number,
    progress: number,
    fb: Feedback,
  ): void {
    const { width, height, ds } = this;
    const font = (w: number, px: number) =>
      `${w} ${px * ds}px "Space Grotesk", system-ui, sans-serif`;
    const pL = this.panelLeft;
    const pW = this.panelWidth;
    const pR = pL + pW;
    const pcx = pL + pW / 2;
    const lx = pL + 14 * ds;
    const lw = pW - 28 * ds;
    const beatPulse = 1 - (this.nowBeat - Math.floor(this.nowBeat));

    // Life bar (top of the playfield panel): dark rim, gradient fill scaled to
    // the current life, a bright cap, and a beat-synced pulse when critical.
    const barY = 14 * ds;
    const barH = 8 * ds;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(lx, barY, lw, barH);
    const life = judge.failed ? 0 : judge.life;
    if (life > 0) {
      const fw = Math.max(2, lw * life);
      if (life < 0.25) {
        ctx.globalAlpha = 0.55 + 0.45 * beatPulse; // danger pulse
        ctx.fillStyle = '#ff4d3d';
        ctx.fillRect(lx, barY, fw, barH);
        ctx.globalAlpha = 1;
      } else {
        const g = ctx.createLinearGradient(lx, 0, lx + fw, 0);
        g.addColorStop(0, '#ff4d3d');
        g.addColorStop(1, '#ffd23d');
        ctx.fillStyle = g;
        ctx.fillRect(lx, barY, fw, barH);
      }
      if (life < 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(lx + fw - 1.5 * ds, barY, 1.5 * ds, barH);
      }
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(lx - 0.5, barY - 0.5, lw + 1, barH + 1);
    // Song progress (bottom of the panel) with a bright playhead cap.
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(lx, height - 14 * ds, lw, 4 * ds);
    const prog = Math.max(0, Math.min(1, progress));
    ctx.fillStyle = '#ff4d3d';
    ctx.fillRect(lx, height - 14 * ds, lw * prog, 4 * ds);
    if (prog > 0 && prog < 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(lx + lw * prog - 1 * ds, height - 14 * ds, 1.5 * ds, 4 * ds);
    }
    ctx.restore();

    // Song info (to the right of the panel).
    const ix = pR + 40 * ds;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ececec';
    ctx.font = font(700, 19);
    ctx.fillText(this.meta.title || 'notefield', ix, 30 * ds);
    ctx.fillStyle = 'rgba(236,236,236,0.6)';
    ctx.font = font(400, 13);
    ctx.fillText(this.meta.subtitle, ix, 50 * ds);
    ctx.fillStyle = '#ff4d3d';
    ctx.font = font(700, 12);
    ctx.fillText(this.meta.difficulty, ix, 70 * ds);
    ctx.restore();

    // Score (top-right).
    ctx.save();
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ececec';
    ctx.font = font(700, 34);
    ctx.fillText(`${(judge.percentDancePoints * 100).toFixed(2)}%`, width - 28 * ds, 42 * ds);
    ctx.fillStyle = 'rgba(236,236,236,0.5)';
    ctx.font = font(700, 11);
    ctx.fillText(`SCORE · GRADE ${judge.grade}`, width - 28 * ds, 60 * ds);
    ctx.fillStyle = 'rgba(236,236,236,0.6)';
    ctx.font = font(400, 13);
    ctx.fillText(`MAX COMBO ${judge.maxCombo}`, width - 28 * ds, 82 * ds);
    ctx.restore();

    // Judgment (centered over the panel): design keyframes — scale 1.4→1 with
    // fade-in over the first 18%, hold to 75%, then fade out (0.7s total).
    if (fb.lastJudgment) {
      const age = now - fb.lastJudgment.atSeconds;
      const j = JUDGMENT[fb.lastJudgment.tns];
      if (j && age >= 0 && age < JUDGMENT_LIFE) {
        const t = age / JUDGMENT_LIFE;
        const pop = t < 0.18 ? 1.4 - (t / 0.18) * 0.4 : 1;
        const alpha = t < 0.18 ? 0.35 + 0.65 * (t / 0.18) : t > 0.75 ? (1 - t) / 0.25 : 1;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(pcx, height * 0.42);
        ctx.scale(pop, pop);
        ctx.fillStyle = j.color;
        ctx.font = font(700, 38);
        ctx.textAlign = 'center';
        if ('letterSpacing' in ctx) ctx.letterSpacing = `${(3 * ds).toFixed(2)}px`;
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 14 * ds;
        ctx.shadowOffsetY = 2 * ds;
        ctx.fillText(j.label, 0, 0);
        ctx.restore();
      }
    }

    // Combo (centered over the panel) — pops briefly each time it increments.
    if (judge.combo !== this.lastCombo) {
      if (judge.combo > this.lastCombo) this.comboPopAt = now;
      this.lastCombo = judge.combo;
    }
    if (judge.combo > 3) {
      const k = Math.max(0, Math.min(1, (now - this.comboPopAt) / 0.13));
      const pop = 1 + 0.22 * (1 - k);
      ctx.save();
      ctx.translate(pcx, height * 0.5);
      ctx.scale(pop, pop);
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(236,236,236,0.92)';
      ctx.font = font(700, 52);
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 12 * ds;
      ctx.shadowOffsetY = 2 * ds;
      ctx.fillText(String(judge.combo), 0, 0);
      ctx.restore();
    }
  }

  /**
   * Simply Love (ITGmania) style: a centered playfield over the SL background
   * filter, cel-noteskin arrows, and the SL gameplay chrome — black header
   * with song meter + LifeMeterBar + Wendy score drawn under the field, and
   * judgment/combo drawn over it (SL draworder 101).
   */
  private drawItg(
    ctx: CanvasRenderingContext2D,
    judge: Judge,
    now: number,
    beat: number,
    progress: number,
    fb: Feedback,
  ): void {
    const { height, ds } = this;
    const beatPulse = 1 - (beat - Math.floor(beat));
    const recY = this.recY();
    const fieldW = this.numTracks * this.colW;
    const fieldL = (this.width - fieldW) / 2;

    // Notefield filter (SL BackgroundFilter): a plain dark strip behind the
    // lanes, flushed red on the beat while the life meter is in danger.
    ctx.fillStyle = 'rgba(3,4,6,0.5)';
    ctx.fillRect(fieldL - 8 * ds, 0, fieldW + 16 * ds, height);
    if (!judge.failed && judge.life < 0.25) {
      ctx.fillStyle = `rgba(255,32,32,${(0.06 + 0.1 * beatPulse).toFixed(3)})`;
      ctx.fillRect(fieldL - 8 * ds, 0, fieldW + 16 * ds, height);
    }

    // SL draws its header/meters/density graph under the arrows.
    if (!this.bare) this.drawSlUnderlay(ctx, judge, progress);

    // Advance the visible-window cursor (same forward-only scan as arcade).
    const notes = judge.notes;
    while (this.firstVisibleIdx < notes.length) {
      const n = notes[this.firstVisibleIdx];
      const endY =
        n.note.type === TapNoteType.HoldHead
          ? this.yOf(n.tailTime, noteRowToBeat(n.tailRow))
          : this.yOf(n.time, n.beat);
      if (this.passed(endY)) this.firstVisibleIdx++;
      else break;
    }

    // Holds behind arrows (windowed).
    for (let i = this.firstVisibleIdx; i < notes.length; i++) {
      const n = notes[i];
      if (this.notYet(this.yOf(n.time, n.beat))) break;
      if (n.note.type === TapNoteType.HoldHead && !n.holdResolved) this.drawHold(ctx, n);
    }

    // Receptors: cel silver arrows that flash bright on each beat (the cel
    // skin's diffuseramp); a press blooms them white and dips the scale.
    for (let t = 0; t < this.numTracks; t++) {
      const x = this.laneX(t);
      const flashAge = now - (fb.laneFlash[t] ?? -1);
      const pressed = flashAge >= 0 && flashAge < RECEPTOR_FLASH;
      this.itgReceptor(ctx, x, recY, t, pressed, beatPulse);
    }

    // Notes and unhit hold heads (windowed): cel-noteskin arrows.
    for (let i = this.firstVisibleIdx; i < notes.length; i++) {
      const n = notes[i];
      const y = this.yOf(n.time, n.beat);
      if (this.notYet(y)) break;
      if (this.passed(y)) continue;
      if (n.note.type === TapNoteType.HoldHead) {
        if (n.holdResolved || n.tns !== TapNoteScore.None) continue;
      } else if (n.hidden || n.note.type === TapNoteType.AutoKeysound) {
        continue;
      }
      const a = this.appearanceAlpha(y);
      if (a <= 0.01) continue;
      if (n.note.type === TapNoteType.Mine) this.drawMine(ctx, this.laneX(n.track), y);
      else {
        this.itgArrow(ctx, this.laneX(n.track), y, n.track, ITG_QUANT_COLOR[getNoteType(n.row)], a);
      }
    }

    // Hit explosion: the cel "Tap Explosion" — the arrow silhouette blooming
    // in the judgment color with a white-hot core, scaling up as it fades
    // (the "Down Tap Explosion Dim/Bright" sprites; Fantastics run brighter).
    for (let t = 0; t < this.numTracks; t++) {
      const hit = fb.laneHit[t];
      if (!hit) continue;
      const age = now - hit.atSeconds;
      if (age < 0 || age >= ITG_EXPLOSION) continue;
      const k = age / ITG_EXPLOSION;
      const fade = 1 - k;
      const j = ITG_JUDGMENT[hit.tns];
      const color = j ? j.color : '#ffffff';
      const bright = hit.tns === TapNoteScore.W1;
      ctx.save();
      ctx.translate(this.laneX(t), recY);
      ctx.rotate(this.angle(t));
      const sc = 1 + 0.18 * k;
      ctx.scale(sc, sc);
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = color;
      ctx.shadowBlur = (bright ? 30 : 20) * ds * fade;
      traceCel(ctx, this.arrowS, CEL_OUTLINE);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.5 * fade;
      ctx.fill();
      ctx.shadowBlur = 0;
      traceCel(ctx, this.arrowS * 0.88, CEL_OUTLINE);
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = (bright ? 0.8 : 0.55) * fade;
      ctx.fill();
      ctx.restore();
    }

    // Judgment and combo sit over the field, like SL's draworder-101 actors.
    if (!this.bare) this.drawSlOverlay(ctx, judge, now, fb);
  }

  /**
   * Cel-noteskin tap note (the Simply Love default): the classic beveled ITG
   * arrow — notched-chevron silhouette with a near-black rim, a silver bevel
   * band, a flat quantization-colored face with a light cel shade, and the
   * animated stripe scrolling through the stem (the model's "scroller" mesh,
   * which cel scrolls one texture-height per beat).
   */
  private itgArrow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    track: number,
    fill: string,
    alpha: number,
  ): void {
    const s = this.arrowS;
    const ds = this.ds;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(this.angle(track));
    // Silhouette / dark rim, stroked over itself to soften the corners.
    traceCel(ctx, s, CEL_OUTLINE);
    ctx.fillStyle = '#0d0e12';
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.5 * ds;
    ctx.strokeStyle = '#0d0e12';
    ctx.stroke();
    // Silver bevel band between rim and face, lit from the tip side.
    traceCel(ctx, s, CEL_BEVEL);
    let g = ctx.createLinearGradient(0, -s, 0, s);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(1, 'rgba(170,177,187,0.95)');
    ctx.fillStyle = g;
    ctx.fill();
    // Flat quantization-colored face with a subtle two-tone cel shade.
    traceCel(ctx, s, CEL_FACE);
    ctx.fillStyle = fill;
    ctx.fill();
    g = ctx.createLinearGradient(0, -s, 0, s);
    g.addColorStop(0, 'rgba(255,255,255,0.32)');
    g.addColorStop(0.45, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.2)');
    ctx.fillStyle = g;
    ctx.fill();
    // Hairline seam where the stem tucks into the chevron V.
    ctx.lineWidth = 1.5 * ds;
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.stroke();
    // Animated center stripe: a soft highlight sweeping tip→tail each beat
    // (drawn twice, one period apart, so the wrap is seamless).
    ctx.clip();
    const frac = this.nowBeat - Math.floor(this.nowBeat);
    for (const yC of [-s + frac * 2 * s, -3 * s + frac * 2 * s]) {
      const sg = ctx.createLinearGradient(0, yC - 0.9 * s, 0, yC + 0.9 * s);
      sg.addColorStop(0, 'rgba(255,255,255,0)');
      sg.addColorStop(0.5, 'rgba(255,255,255,0.34)');
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(-0.188 * s, -s, 0.376 * s, 2 * s);
    }
    ctx.restore();
  }

  /**
   * Cel receptor: the same silhouette in neutral silver, pulsing bright on
   * each beat (the skin's diffuseramp between 10% grey and white), with the
   * inset stem panel from the "Receptor Go" texture. A press blooms it white
   * and dips the scale, like the common noteskin's PressCommand.
   */
  private itgReceptor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    track: number,
    pressed: boolean,
    beatPulse: number,
  ): void {
    const s = this.arrowS;
    const ds = this.ds;
    const f = beatPulse * beatPulse; // sharp attack on the beat, quick decay
    const v = pressed ? 246 : Math.round(112 + 104 * f);
    const grey = (n: number) => {
      const c = Math.max(0, Math.min(255, Math.round(n)));
      return `rgb(${c},${c},${Math.min(255, c + 4)})`;
    };
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(this.angle(track));
    if (pressed) ctx.scale(0.92, 0.92);
    traceCel(ctx, s, CEL_OUTLINE);
    ctx.fillStyle = '#0d0e12';
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.5 * ds;
    ctx.strokeStyle = '#0d0e12';
    ctx.stroke();
    traceCel(ctx, s, CEL_BEVEL);
    const g = ctx.createLinearGradient(0, -s, 0, s);
    g.addColorStop(0, grey(v + 58));
    g.addColorStop(1, grey(v - 30));
    ctx.fillStyle = g;
    ctx.fill();
    traceCel(ctx, s, CEL_FACE);
    ctx.fillStyle = grey(v);
    ctx.fill();
    // Inset stem panel (the "Go" stripe housing) with its divider notch.
    ctx.clip();
    ctx.fillStyle = grey(v + 34);
    ctx.fillRect(-0.12 * s, -0.1 * s, 0.24 * s, 0.84 * s);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(-0.12 * s, 0.22 * s, 0.24 * s, 1.5 * ds);
    ctx.restore();
  }

  /**
   * Simply Love gameplay underlay: the full-width black header holding the
   * bordered song meter (title inside, SongInfoBar.lua), the LifeMeterBar
   * with its scrolling swoosh sheen (LifeMeter/Standard.lua), the Wendy
   * dance-percentage left of the field (Score.lua), and the step-density
   * graph along the bottom. Drawn before the notes, like SL's underlay.
   */
  private drawSlUnderlay(ctx: CanvasRenderingContext2D, judge: Judge, progress: number): void {
    const { width, ds } = this;
    const font = (w: number, px: number) =>
      `${w} ${px * ds}px "Space Grotesk", system-ui, sans-serif`;
    const cx = width / 2;
    const beat = this.nowBeat;
    const fieldW = this.numTracks * this.colW;

    // Header: SL's full-width black quad (80/480 of the screen, alpha .85).
    const headerH = 110 * ds;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(0, 0, width, headerH);

    // Song meter: white frame, black well, accent-colored stream + title.
    const mW = Math.min(465 * ds, width * 0.44);
    const mH = 33 * ds;
    const mX = cx - mW / 2;
    const mY = 30 * ds - mH / 2;
    const bd = 3 * ds; // frame thickness (SL: 2px of a 480-tall screen)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(mX, mY, mW, mH);
    ctx.fillStyle = '#000000';
    ctx.fillRect(mX + bd, mY + bd, mW - 2 * bd, mH - 2 * bd);
    const prog = Math.max(0, Math.min(1, progress));
    ctx.fillStyle = SL_ACCENT;
    ctx.fillRect(mX + bd, mY + bd, (mW - 2 * bd) * prog, mH - 2 * bd);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = font(700, 15);
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowOffsetY = 1.5 * ds;
    ctx.fillText(this.meta.title || 'notefield', cx, mY + mH / 2, mW - 16 * ds);
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetY = 0;
    if (this.meta.subtitle) {
      // Step artist / subtitle, tucked under the meter.
      ctx.fillStyle = 'rgba(236,236,236,0.55)';
      ctx.font = font(400, 12);
      ctx.fillText(this.meta.subtitle, cx, mY + mH + 14 * ds, mW);
    }

    // LifeMeterBar: white frame, black well, accent fill that turns white
    // when full ("Hot"), plus the beat-scrolled swoosh highlight.
    const lH = 27 * ds;
    let lW = 204 * ds;
    let lX = mX - 23 * ds - lW;
    if (lX < 10 * ds) {
      lW = Math.max(60 * ds, mX - 33 * ds);
      lX = mX - 23 * ds - lW;
    }
    const lY = 30 * ds - lH / 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(lX - bd, lY - bd, lW + 2 * bd, lH + 2 * bd);
    ctx.fillStyle = '#000000';
    ctx.fillRect(lX, lY, lW, lH);
    const life = judge.failed ? 0 : judge.life;
    const hot = life >= 1;
    if (life > 0) {
      const fw = Math.max(2, lW * life);
      ctx.fillStyle = hot ? '#ffffff' : SL_ACCENT;
      ctx.fillRect(lX, lY, fw, lH);
      // Swoosh: SL scrolls a soft diagonal gradient across the fill at half
      // the song's BPS, at alpha .2 (full strength while Hot).
      ctx.save();
      ctx.beginPath();
      ctx.rect(lX, lY, fw, lH);
      ctx.clip();
      const p = 1 - ((beat * 0.5) % 1);
      const gx0 = lX + (p * 2 - 2) * lW;
      const sw = ctx.createLinearGradient(gx0, lY + lH, gx0 + 2 * lW, lY);
      sw.addColorStop(0, 'rgba(255,255,255,0)');
      sw.addColorStop(0.5, `rgba(255,255,255,${hot ? 0.5 : 0.22})`);
      sw.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sw;
      ctx.fillRect(lX, lY, fw, lH);
      ctx.restore();
    }

    // Dance percentage (Score.lua: Wendy digits left of the field, no "%").
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ececec';
    ctx.font = font(800, 40);
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(1 * ds).toFixed(2)}px`;
    ctx.fillText((judge.percentDancePoints * 100).toFixed(2), cx - fieldW / 2 - 28 * ds, 92 * ds);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    // Difficulty, mirrored on the right of the field.
    ctx.textAlign = 'left';
    ctx.fillStyle = SL_ACCENT;
    ctx.font = font(700, 16);
    ctx.fillText(this.meta.difficulty, cx + fieldW / 2 + 28 * ds, 92 * ds);
    ctx.restore();

    this.drawDensityGraph(ctx, judge);
  }

  /**
   * SL step-density graph: per-measure NPS as a filled silhouette, blue at
   * the baseline blending toward purple at the peak (SL-Histogram.lua's
   * vertex colors), over the #1E282F backing, with the already-played span
   * swept to black like UpperNPSGraph's ProgressQuad.
   */
  private drawDensityGraph(ctx: CanvasRenderingContext2D, judge: Judge): void {
    const { width, height, ds } = this;
    if (this.density?.src !== judge.notes) this.buildDensity(judge.notes);
    const dg = this.density;
    if (!dg || dg.bins.length < 2 || dg.lastT <= 0) return;
    const H = 44 * ds;
    const top = height - H;
    ctx.save();
    ctx.fillStyle = SL_GRAPH_BG;
    ctx.fillRect(0, top, width, H);
    const xOf = (t: number) => (t / dg.lastT) * width;
    const g = ctx.createLinearGradient(0, height, 0, top);
    g.addColorStop(0, SL_GRAPH_LO);
    g.addColorStop(1, SL_GRAPH_HI);
    ctx.beginPath();
    ctx.moveTo(xOf(dg.bins[0].t0), height);
    for (const b of dg.bins) ctx.lineTo(xOf(b.t0), height - b.h * H);
    const last = dg.bins[dg.bins.length - 1];
    ctx.lineTo(xOf(last.t1), height);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    const played = Math.max(0, Math.min(1, this.nowSeconds / dg.lastT)) * width;
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(0, top, played, H);
    ctx.restore();
  }

  /**
   * Per-measure notes-per-second histogram (SL-Histogram's NPSperMeasure).
   * Measure-boundary times are interpolated from the chart's own (beat, time)
   * pairs, so BPM changes are respected without needing timing data here.
   * Cached per notes array; rebuilt when the song changes.
   */
  private buildDensity(notes: readonly ActiveNote[]): void {
    const bins: Array<{ t0: number; t1: number; h: number }> = [];
    const beats: number[] = [];
    const times: number[] = [];
    const counts = new Map<number, number>();
    let lastT = 0;
    let firstM = Infinity;
    let lastM = -1;
    for (const n of notes) {
      beats.push(n.beat);
      times.push(n.time);
      const end = n.note.type === TapNoteType.HoldHead ? n.tailTime : n.time;
      if (end > lastT) lastT = end;
      const kind = n.note.type;
      if (kind !== TapNoteType.Tap && kind !== TapNoteType.HoldHead && kind !== TapNoteType.Lift)
        continue;
      if (n.hidden) continue;
      const m = Math.floor(n.beat / 4);
      counts.set(m, (counts.get(m) ?? 0) + 1);
      if (m < firstM) firstM = m;
      if (m > lastM) lastM = m;
    }
    this.density = { src: notes, bins, lastT };
    if (lastM < 0 || beats.length < 2) return;
    // Piecewise-linear beat→time lookup; the cursor only moves forward since
    // measure boundaries are scanned in ascending order.
    let i = 0;
    const timeAt = (b: number): number => {
      while (i < beats.length - 1 && beats[i + 1] <= b) i++;
      let j = i;
      let k = i + 1;
      while (k < beats.length && beats[k] <= beats[j]) k++;
      if (k >= beats.length) {
        k = beats.length - 1;
        j = k - 1;
        while (j >= 0 && beats[j] >= beats[k]) j--;
        if (j < 0) return times[k]; // degenerate: the chart has no beat spread
      }
      const slope = (times[k] - times[j]) / (beats[k] - beats[j]);
      return Number.isFinite(slope) ? times[j] + (b - beats[j]) * slope : times[j];
    };
    let peak = 0;
    const raw: Array<{ t0: number; t1: number; nps: number }> = [];
    let t0 = timeAt(firstM * 4);
    for (let m = firstM; m <= lastM; m++) {
      const t1 = timeAt((m + 1) * 4);
      const nps = (counts.get(m) ?? 0) / Math.max(0.001, t1 - t0);
      raw.push({ t0, t1, nps });
      if (nps > peak) peak = nps;
      t0 = t1;
    }
    if (peak <= 0) return;
    for (const r of raw) bins.push({ t0: r.t0, t1: r.t1, h: Math.min(1, r.nps / peak) });
    const endT = raw[raw.length - 1].t1;
    if (endT > lastT) this.density.lastT = endT;
  }

  /**
   * SL overlay, drawn above the notes: the judgment label in the ITG colors
   * with the "Love" graphic's soft same-color glow and SL's zoom tween
   * (pop in slightly large, settle, hold, shrink away), and the bare combo
   * digits below — white, or pulsing SL's full-combo blue/gold/green pairs.
   */
  private drawSlOverlay(
    ctx: CanvasRenderingContext2D,
    judge: Judge,
    now: number,
    fb: Feedback,
  ): void {
    const { ds } = this;
    const font = (w: number, px: number) =>
      `${w} ${px * ds}px "Space Grotesk", system-ui, sans-serif`;
    const cx = this.width / 2;
    const recY = this.recY();
    // Anchored inside the field past the receptor line (flips under reverse).
    const anchorY = this.reverse ? recY - 215 * ds : recY + 215 * ds;

    if (fb.lastJudgment) {
      const age = now - fb.lastJudgment.atSeconds;
      const j = ITG_JUDGMENT[fb.lastJudgment.tns];
      if (j && age >= 0 && age < SL_JUDGMENT_LIFE) {
        const t = age / SL_JUDGMENT_LIFE;
        // SL's tween: zoom 0.8 → decelerate 0.75 → sleep → accelerate 0.
        let pop: number;
        if (t < 0.111) {
          const k = t / 0.111;
          pop = 1 + 0.067 * (1 - k * (2 - k));
        } else if (t < 0.778) {
          pop = 1;
        } else {
          const k = (t - 0.778) / 0.222;
          pop = Math.max(0, 1 - k * k);
        }
        if (pop > 0.02) {
          ctx.save();
          ctx.translate(cx, anchorY - 26 * ds);
          ctx.scale(pop, pop);
          ctx.textAlign = 'center';
          ctx.font = font(800, 34);
          if ('letterSpacing' in ctx) ctx.letterSpacing = `${(1.5 * ds).toFixed(2)}px`;
          ctx.shadowColor = j.color;
          ctx.shadowBlur = 18 * ds;
          ctx.fillStyle = j.color;
          ctx.fillText(j.label, 0, 0);
          ctx.shadowBlur = 0;
          ctx.lineWidth = 1.2 * ds;
          ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.strokeText(j.label, 0, 0);
          ctx.restore();
        }
      }
    }

    // Combo: digits only (SL shows no label), visible from 4 (ShowComboAt).
    if (judge.combo !== this.lastCombo) {
      if (judge.combo > this.lastCombo) this.comboPopAt = now;
      this.lastCombo = judge.combo;
    }
    if (judge.combo > 3) {
      const tc = judge.tapCounts;
      const broken =
        (tc[TapNoteScore.Miss] ?? 0) + (tc[TapNoteScore.W5] ?? 0) + (tc[TapNoteScore.W4] ?? 0);
      const w3 = tc[TapNoteScore.W3] ?? 0;
      const w2 = tc[TapNoteScore.W2] ?? 0;
      let pulse: readonly [string, string] | null = null;
      if (broken === 0) {
        if (w3 === 0 && w2 === 0) pulse = SL_COMBO_W1;
        else if (w3 === 0) pulse = SL_COMBO_W2;
        else pulse = SL_COMBO_W3;
      }
      let fill = 'rgba(255,255,255,0.98)';
      if (pulse) {
        const ph = (now % 0.8) / 0.8; // SL's diffuseshift, 0.8s period
        fill = lerpHex(pulse[0], pulse[1], ph < 0.5 ? ph * 2 : (1 - ph) * 2);
      }
      const k = Math.max(0, Math.min(1, (now - this.comboPopAt) / 0.13));
      const pop = 1 + 0.08 * (1 - k);
      ctx.save();
      ctx.translate(cx, anchorY + 36 * ds);
      ctx.scale(pop, pop);
      ctx.textAlign = 'center';
      ctx.font = font(800, 48);
      // Hard 45° drop shadow, like SL's shadowlength on the combo font.
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowOffsetX = 2 * ds;
      ctx.shadowOffsetY = 2 * ds;
      ctx.fillStyle = fill;
      ctx.fillText(String(judge.combo), 0, 0);
      ctx.restore();
    }
  }
}
