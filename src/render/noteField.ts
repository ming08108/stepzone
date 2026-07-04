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

const QUANT_COLOR: Record<NoteType, string> = {
  [NoteType.N4TH]: '#ff4d4d',
  [NoteType.N8TH]: '#4d7bff',
  [NoteType.N12TH]: '#b24dff',
  [NoteType.N16TH]: '#ffd24d',
  [NoteType.N24TH]: '#ff4dc4',
  [NoteType.N32ND]: '#ff934d',
  [NoteType.N48TH]: '#4de6c4',
  [NoteType.N64TH]: '#9cff4d',
  [NoteType.N192ND]: '#9aa0b0',
};

const JUDGMENT: Record<number, { label: string; color: string }> = {
  [TapNoteScore.W1]: { label: 'MARVELOUS', color: '#7ff0ff' },
  [TapNoteScore.W2]: { label: 'PERFECT', color: '#ffd94b' },
  [TapNoteScore.W3]: { label: 'GREAT', color: '#5be06a' },
  [TapNoteScore.W4]: { label: 'GOOD', color: '#4b8be6' },
  [TapNoteScore.W5]: { label: 'WAY OFF', color: '#a06ee6' },
  [TapNoteScore.Miss]: { label: 'MISS', color: '#ff4d4d' },
  [TapNoteScore.HitMine]: { label: 'MINE!', color: '#ff4d4d' },
};

/** Arrow rotation per dance-single column: Left, Down, Up, Right. */
const ANGLES = [-Math.PI / 2, Math.PI, 0, Math.PI / 2];

const SPACING = 64; // base pixels per beat (ITG ARROW_SPACING)
const HIT_FLASH = 0.18; // seconds

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

  private receptorY = 150;
  private colW = 110;
  private arrowS = 46;

  // Scroll: 'C' = constant px/sec (CMod), 'X' = px per beat * multiplier (XMod).
  private scrollMode: 'C' | 'X' = 'C';
  private scrollValue = 550;
  private nowSeconds = 0;
  private nowBeat = 0;

  constructor(readonly numTracks: number) {}

  setMeta(meta: RenderMeta): void {
    this.meta = meta;
  }

  setScroll(mode: 'C' | 'X', value: number): void {
    this.scrollMode = mode;
    this.scrollValue = value;
  }

  resize(width: number, height: number, dpr = 1): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.colW = Math.min(120, Math.max(64, (width * 0.86) / this.numTracks));
    this.arrowS = this.colW * 0.42;
    this.receptorY = Math.max(110, Math.min(180, height * 0.16));
  }

  private laneX(track: number): number {
    const fieldW = this.numTracks * this.colW;
    const left = (this.width - fieldW) / 2 + this.colW / 2;
    return left + track * this.colW;
  }

  private angle(track: number): number {
    return ANGLES[track] ?? 0;
  }

  private yOf(timeSeconds: number, beatValue: number): number {
    if (this.scrollMode === 'X') {
      return this.receptorY + (beatValue - this.nowBeat) * SPACING * this.scrollValue;
    }
    const pxPerSec = (this.scrollValue / 60) * SPACING;
    return this.receptorY + (timeSeconds - this.nowSeconds) * pxPerSec;
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

    // Background: dark with a slightly lit note highway.
    ctx.fillStyle = '#07080c';
    ctx.fillRect(0, 0, width, height);
    const fieldW = this.numTracks * this.colW;
    const fieldL = (width - fieldW) / 2;
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, 'rgba(255,255,255,0.05)');
    grad.addColorStop(1, 'rgba(255,255,255,0.015)');
    ctx.fillStyle = grad;
    ctx.fillRect(fieldL, 0, fieldW, height);
    // Receptor glow line.
    ctx.fillStyle = 'rgba(120,150,255,0.06)';
    ctx.fillRect(fieldL, this.receptorY - 44, fieldW, 88);

    // Holds behind arrows.
    for (const n of judge.notes) {
      if (n.note.type !== TapNoteType.HoldHead || n.holdResolved) continue;
      this.drawHold(ctx, n);
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
        this.receptorY,
        t,
        pulse,
        pressed ? 'rgba(255,255,255,0.12)' : null,
        `rgba(190,200,220,${pressed ? 0.95 : 0.5})`,
        3,
      );
    }

    // Notes (and unhit hold heads), nearest last so closer arrows draw on top.
    const drawList = judge.notes.filter((n) => {
      const isHold = n.note.type === TapNoteType.HoldHead;
      if (isHold) return !n.holdResolved && n.tns === TapNoteScore.None;
      return !n.hidden && n.note.type !== TapNoteType.AutoKeysound;
    });
    for (let i = drawList.length - 1; i >= 0; i--) {
      const n = drawList[i];
      const y = this.yOf(n.time, n.beat);
      if (y < -80 || y > height + 80) continue;
      if (n.note.type === TapNoteType.Mine) this.drawMine(ctx, this.laneX(n.track), y);
      else {
        const c = QUANT_COLOR[getNoteType(n.row)];
        this.arrow(ctx, this.laneX(n.track), y, n.track, 1, c, 'rgba(0,0,0,0.55)', 2);
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
      this.arrow(ctx, this.laneX(t), this.receptorY, t, 1 + k * 0.8, null, color, 4, 1 - k);
    }

    this.drawHud(ctx, judge, now, progress, fb);
  }

  private drawHold(ctx: CanvasRenderingContext2D, n: ActiveNote): void {
    const x = this.laneX(n.track);
    let headY = this.yOf(n.time, n.beat);
    const tailY = this.yOf(n.tailTime, noteRowToBeat(n.tailRow));
    if (n.holdInitiated && this.nowSeconds >= n.time) headY = this.receptorY;
    const top = Math.min(headY, tailY);
    const bottom = Math.max(headY, tailY);
    const alive = !n.holdInitiated || n.holdLife > 0;
    const w = this.arrowS * 0.9;
    ctx.save();
    ctx.fillStyle = alive ? 'rgba(90,224,106,0.55)' : 'rgba(120,120,120,0.3)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, top, w, Math.max(0, bottom - top), w / 2);
    ctx.fill();
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
    const { width, height } = this;
    const cx = width / 2;

    // Title / difficulty (top-left).
    ctx.save();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#eef1f8';
    ctx.font = '800 24px system-ui, sans-serif';
    ctx.fillText(this.meta.title || 'notefield', 28, 42);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.fillText(this.meta.subtitle, 28, 62);
    ctx.fillStyle = '#ffd24d';
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.fillText(this.meta.difficulty, 28, 84);
    ctx.restore();

    // Score % + grade (top-right).
    ctx.save();
    ctx.textAlign = 'right';
    ctx.fillStyle = '#eef1f8';
    ctx.font = '800 40px system-ui, sans-serif';
    ctx.fillText(`${(judge.percentDancePoints * 100).toFixed(2)}%`, width - 28, 48);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.fillText(`GRADE ${judge.grade}`, width - 28, 72);
    ctx.restore();

    // Life gauge (centered under the header).
    const gW = Math.min(460, width * 0.5);
    const gX = cx - gW / 2;
    const gY = 30;
    const gH = 16;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.roundRect(gX, gY, gW, gH, 8);
    ctx.fill();
    const life = judge.failed ? 0 : judge.life;
    const lifeGrad = ctx.createLinearGradient(gX, 0, gX + gW, 0);
    lifeGrad.addColorStop(0, '#ff4d4d');
    lifeGrad.addColorStop(0.5, '#ffd24d');
    lifeGrad.addColorStop(1, '#5be06a');
    ctx.fillStyle = life <= 0 ? '#552' : lifeGrad;
    ctx.beginPath();
    ctx.roundRect(gX, gY, Math.max(2, gW * life), gH, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(gX, gY, gW, gH, 8);
    ctx.stroke();
    ctx.restore();

    // Judgment label (fades).
    if (fb.lastJudgment) {
      const age = now - fb.lastJudgment.atSeconds;
      const j = JUDGMENT[fb.lastJudgment.tns];
      if (j && age >= 0 && age < 0.55) {
        const pop = age < 0.08 ? 1 + (0.08 - age) * 3 : 1;
        ctx.save();
        ctx.globalAlpha = Math.min(1, 1 - (age - 0.35) / 0.2);
        ctx.translate(cx, this.receptorY + height * 0.24);
        ctx.scale(pop, pop);
        ctx.fillStyle = j.color;
        ctx.font = '900 44px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(j.label, 0, 0);
        ctx.restore();
      }
    }

    // Combo.
    if (judge.combo > 1) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.font = '900 68px system-ui, sans-serif';
      ctx.fillText(String(judge.combo), cx, this.receptorY + height * 0.36);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '800 18px system-ui, sans-serif';
      ctx.fillText('COMBO', cx, this.receptorY + height * 0.36 + 26);
      ctx.restore();
    }

    // Song progress (thin bar at the bottom).
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, height - 6, width, 6);
    ctx.fillStyle = '#6ea8fe';
    ctx.fillRect(0, height - 6, width * Math.max(0, Math.min(1, progress)), 6);
    ctx.restore();
  }
}
