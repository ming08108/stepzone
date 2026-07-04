/**
 * Arcade-style canvas note field (DDR/ITG look): directional arrows colored by
 * quantization, pulsing receptors, hit flashes, holds, and a full-screen HUD.
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

/** Arrow rotation per dance-single column: Left, Down, Up, Right. */
const ANGLES = [-Math.PI / 2, Math.PI, 0, Math.PI / 2];

const SPACING = 64; // base pixels per beat (ITG ARROW_SPACING)
const HIT_FLASH = 0.18; // seconds
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

export class NoteFieldRenderer {
  width = 800;
  height = 720;
  private dpr = 1;
  private meta: RenderMeta = { title: '', subtitle: '', difficulty: '' };

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
  private transparentBg = false; // let a WebGPU layer behind show through
  private reverse = false; // downscroll: receptors at the bottom
  private appearance: 'visible' | 'hidden' | 'sudden' = 'visible';
  private firstVisibleIdx = 0; // forward-only cursor into the time-sorted notes

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
    return this.fieldLeft + this.colW / 2 + track * this.colW;
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
    // Dim so arrows stay readable.
    ctx.fillStyle = 'rgba(7,8,12,0.6)';
    ctx.fillRect(0, 0, this.width, this.height);
  }

  /** Effective receptor Y (bottom of the field under reverse). */
  private recY(): number {
    return this.reverse ? this.height - this.receptorY : this.receptorY;
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
    fill: string | null,
    stroke: string | null,
    lineWidth = 3,
    alpha = 1,
  ): void {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(this.angle(track));
    ctx.scale(scale, scale);
    traceArrow(ctx, this.arrowS);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
    if (fill) {
      // STEPLINE signature: a bright inner outline (arrow scaled 0.72 about center).
      ctx.scale(0.72, 0.72);
      traceArrow(ctx, this.arrowS);
      ctx.lineWidth = 3.2 / 0.72;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
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
    const { width, height } = this;
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
        ctx.fillStyle = '#07080c';
        ctx.fillRect(0, 0, width, height);
      }
    } else if (this.transparentBg) {
      ctx.clearRect(0, 0, width, height);
    } else {
      ctx.fillStyle = '#07080c';
      ctx.fillRect(0, 0, width, height);
    }
    // STEPLINE left-aligned playfield panel: translucent dark with hairline sides.
    const pL = this.panelLeft;
    const pR = this.panelLeft + this.panelWidth;
    ctx.fillStyle = 'rgba(5,6,8,0.55)';
    ctx.fillRect(pL, 0, this.panelWidth, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pL + 0.5, 0);
    ctx.lineTo(pL + 0.5, height);
    ctx.moveTo(pR - 0.5, 0);
    ctx.lineTo(pR - 0.5, height);
    ctx.stroke();
    // Receptor glow line.
    const recY = this.recY();
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(pL, recY - 44 * this.ds, this.panelWidth, 88 * this.ds);

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

    // Receptors (pulse to the beat).
    const frac = beat - Math.floor(beat);
    const pulse = 1 + 0.12 * (1 - frac);
    for (let t = 0; t < this.numTracks; t++) {
      const x = this.laneX(t);
      const flashAge = now - (fb.laneFlash[t] ?? -1);
      const pressed = flashAge >= 0 && flashAge < 0.1;
      this.arrow(
        ctx,
        x,
        recY,
        t,
        pulse,
        pressed ? 'rgba(255,255,255,0.12)' : null,
        `rgba(190,200,220,${pressed ? 0.95 : 0.5})`,
        3,
      );
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
        const c = QUANT_COLOR[getNoteType(n.row)];
        this.arrow(ctx, this.laneX(n.track), y, n.track, 1, c, '#0a0b0d', 5, a);
      }
    }

    // Hit explosions.
    for (let t = 0; t < this.numTracks; t++) {
      const hit = fb.laneHit[t];
      if (!hit) continue;
      const age = now - hit.atSeconds;
      if (age < 0 || age >= HIT_FLASH) continue;
      const k = age / HIT_FLASH;
      const j = JUDGMENT[hit.tns];
      const color = j ? j.color : '#ffffff';
      this.arrow(ctx, this.laneX(t), recY, t, 1 + k * 0.8, null, color, 4, 1 - k);
    }

    this.drawHud(ctx, judge, now, progress, fb);
  }

  private drawHold(ctx: CanvasRenderingContext2D, n: ActiveNote): void {
    const x = this.laneX(n.track);
    let headY = this.yOf(n.time, n.beat);
    const tailY = this.yOf(n.tailTime, noteRowToBeat(n.tailRow));
    if (n.holdInitiated && this.nowSeconds >= n.time) headY = this.recY();
    const top = Math.min(headY, tailY);
    const bottom = Math.max(headY, tailY);
    const alive = !n.holdInitiated || n.holdLife > 0;
    const w = this.arrowS;
    ctx.save();
    ctx.fillStyle = alive ? 'rgba(89,240,127,0.35)' : 'rgba(120,120,120,0.3)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, top, w, Math.max(0, bottom - top), w / 2);
    ctx.fill();
    if (alive) {
      ctx.strokeStyle = 'rgba(89,240,127,0.6)';
      ctx.lineWidth = 2 * this.ds;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawMine(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const r = this.arrowS * 0.8;
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = '#ff4d4d';
    ctx.fillStyle = 'rgba(255,77,77,0.18)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
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

    // Life bar (top of the playfield panel).
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(lx, 14 * ds, lw, 8 * ds);
    const life = judge.failed ? 0 : judge.life;
    if (life > 0) {
      if (life < 0.25) ctx.fillStyle = '#ff4d3d';
      else {
        const g = ctx.createLinearGradient(lx, 0, lx + lw, 0);
        g.addColorStop(0, '#ff4d3d');
        g.addColorStop(1, '#ffd23d');
        ctx.fillStyle = g;
      }
      ctx.fillRect(lx, 14 * ds, Math.max(2, lw * life), 8 * ds);
    }
    // Song progress (bottom of the panel).
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(lx, height - 14 * ds, lw, 4 * ds);
    ctx.fillStyle = '#ff4d3d';
    ctx.fillRect(lx, height - 14 * ds, lw * Math.max(0, Math.min(1, progress)), 4 * ds);
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

    // Judgment (centered over the panel, pops).
    if (fb.lastJudgment) {
      const age = now - fb.lastJudgment.atSeconds;
      const j = JUDGMENT[fb.lastJudgment.tns];
      if (j && age >= 0 && age < 0.7) {
        const pop = age < 0.08 ? 1.4 - (age / 0.08) * 0.4 : 1;
        ctx.save();
        ctx.globalAlpha = age > 0.5 ? Math.max(0, 1 - (age - 0.5) / 0.2) : 1;
        ctx.translate(pcx, height * 0.42);
        ctx.scale(pop, pop);
        ctx.fillStyle = j.color;
        ctx.font = font(700, 38);
        ctx.textAlign = 'center';
        ctx.fillText(j.label, 0, 0);
        ctx.restore();
      }
    }

    // Combo (centered over the panel).
    if (judge.combo > 3) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ececec';
      ctx.font = font(700, 52);
      ctx.fillText(String(judge.combo), pcx, height * 0.5);
      ctx.restore();
    }
  }
}
