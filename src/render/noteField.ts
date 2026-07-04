/**
 * Canvas note-field renderer. Upscroll, constant-time (CMod) spacing, drawing
 * receptors, notes (colored by quantization), holds, and the HUD. See spec
 * doc 8. Purely presentational — reads the Judge, never mutates it.
 */

import { DANCE_SINGLE_LABELS } from '../input/keymap';
import type { ActiveNote, Judge } from '../gameplay/judge';
import { getNoteType, NoteType, TapNoteScore, TapNoteType } from '../notes/noteTypes';

const QUANT_COLOR: Record<NoteType, string> = {
  [NoteType.N4TH]: '#e64b4b',
  [NoteType.N8TH]: '#4b7be6',
  [NoteType.N12TH]: '#9b4be6',
  [NoteType.N16TH]: '#e6cf4b',
  [NoteType.N24TH]: '#e64bb4',
  [NoteType.N32ND]: '#e6944b',
  [NoteType.N48TH]: '#4be6c4',
  [NoteType.N64TH]: '#9ce64b',
  [NoteType.N192ND]: '#8a8a8a',
};

const JUDGMENT: Record<number, { label: string; color: string }> = {
  [TapNoteScore.W1]: { label: 'MARVELOUS', color: '#7ff0ff' },
  [TapNoteScore.W2]: { label: 'PERFECT', color: '#ffd94b' },
  [TapNoteScore.W3]: { label: 'GREAT', color: '#5be06a' },
  [TapNoteScore.W4]: { label: 'GOOD', color: '#4b8be6' },
  [TapNoteScore.W5]: { label: 'WAY OFF', color: '#a06ee6' },
  [TapNoteScore.Miss]: { label: 'MISS', color: '#e64b4b' },
  [TapNoteScore.HitMine]: { label: 'MINE!', color: '#e64b4b' },
};

export interface Feedback {
  lastJudgment: { tns: TapNoteScore; atSeconds: number } | null;
  /** Per-column time (seconds) of the last press, for receptor glow. */
  laneFlash: number[];
}

const RECEPTOR_Y = 120;
const COL_W = 88;
const NOTE_R = 30;
const PPS = 520; // pixels per second (CMod scroll)

export class NoteFieldRenderer {
  width = 800;
  height = 720;

  constructor(readonly numTracks: number) {}

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  private laneX(track: number): number {
    const fieldW = this.numTracks * COL_W;
    const left = (this.width - fieldW) / 2 + COL_W / 2;
    return left + track * COL_W;
  }

  private yOf(noteTime: number, now: number): number {
    return RECEPTOR_Y + (noteTime - now) * PPS;
  }

  draw(ctx: CanvasRenderingContext2D, judge: Judge, now: number, fb: Feedback): void {
    const { width, height } = this;
    ctx.clearRect(0, 0, width, height);

    // Background lanes.
    ctx.fillStyle = '#0e1016';
    ctx.fillRect(0, 0, width, height);
    for (let t = 0; t < this.numTracks; t++) {
      const x = this.laneX(t);
      ctx.fillStyle = t % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(x - COL_W / 2, 0, COL_W, height);
    }

    // Holds first (behind arrows).
    for (const n of judge.notes) {
      if (n.note.type !== TapNoteType.HoldHead || n.holdResolved) continue;
      this.drawHold(ctx, n, now);
    }

    // Receptors.
    for (let t = 0; t < this.numTracks; t++) {
      const x = this.laneX(t);
      const flash = now - (fb.laneFlash[t] ?? -1);
      const glow = flash >= 0 && flash < 0.12 ? 1 - flash / 0.12 : 0;
      this.drawReceptor(ctx, x, RECEPTOR_Y, DANCE_SINGLE_LABELS[t] ?? '', glow);
    }

    // Tap notes (and unhit hold heads).
    for (const n of judge.notes) {
      const isHold = n.note.type === TapNoteType.HoldHead;
      if (isHold) {
        if (n.holdResolved || n.tns !== TapNoteScore.None) continue; // held head sticks via hold body
      } else if (n.hidden || n.note.type === TapNoteType.AutoKeysound) {
        continue;
      }
      const y = this.yOf(n.time, now);
      if (y < -NOTE_R || y > height + NOTE_R) continue;
      if (n.note.type === TapNoteType.Mine) this.drawMine(ctx, this.laneX(n.track), y);
      else this.drawNote(ctx, this.laneX(n.track), y, QUANT_COLOR[getNoteType(n.row)], n.track);
    }

    this.drawHud(ctx, judge, now, fb);
  }

  private drawHold(ctx: CanvasRenderingContext2D, n: ActiveNote, now: number): void {
    const x = this.laneX(n.track);
    let headY = this.yOf(n.time, now);
    const tailY = this.yOf(n.tailTime, now);
    if (n.holdInitiated && now >= n.time) headY = RECEPTOR_Y; // stick to receptor while held
    const top = Math.min(headY, tailY);
    const bottom = Math.max(headY, tailY);
    const alive = !n.holdInitiated || n.holdLife > 0;
    ctx.fillStyle = alive ? 'rgba(90,224,106,0.35)' : 'rgba(120,120,120,0.25)';
    const w = NOTE_R * 1.1;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, top, w, Math.max(0, bottom - top), 8);
    ctx.fill();
  }

  private drawReceptor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    label: string,
    glow: number,
  ): void {
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${0.35 + glow * 0.6})`;
    ctx.lineWidth = 2 + glow * 3;
    ctx.beginPath();
    ctx.roundRect(x - NOTE_R, y - NOTE_R, NOTE_R * 2, NOTE_R * 2, 10);
    ctx.stroke();
    if (glow > 0) {
      ctx.fillStyle = `rgba(255,255,255,${glow * 0.18})`;
      ctx.fill();
    }
    ctx.fillStyle = `rgba(255,255,255,${0.4 + glow * 0.5})`;
    ctx.font = '600 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 1);
    ctx.restore();
  }

  private drawNote(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    color: string,
    track: number,
  ): void {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - NOTE_R, y - NOTE_R, NOTE_R * 2, NOTE_R * 2, 10);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.font = '700 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(DANCE_SINGLE_LABELS[track] ?? '', x, y + 1);
    ctx.restore();
  }

  private drawMine(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.save();
    ctx.strokeStyle = '#e64b4b';
    ctx.fillStyle = 'rgba(230,75,75,0.2)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, NOTE_R * 0.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e64b4b';
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✳', x, y + 1);
    ctx.restore();
  }

  private drawHud(ctx: CanvasRenderingContext2D, judge: Judge, now: number, fb: Feedback): void {
    const cx = this.width / 2;

    // Judgment label (fades over 0.6s).
    if (fb.lastJudgment) {
      const age = now - fb.lastJudgment.atSeconds;
      const j = JUDGMENT[fb.lastJudgment.tns];
      if (j && age >= 0 && age < 0.6) {
        ctx.save();
        ctx.globalAlpha = 1 - age / 0.6;
        ctx.fillStyle = j.color;
        ctx.font = '800 34px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(j.label, cx, RECEPTOR_Y + 150);
        ctx.restore();
      }
    }

    // Combo.
    if (judge.combo > 1) {
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.font = '800 52px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(judge.combo), cx, RECEPTOR_Y + 230);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '600 16px system-ui, sans-serif';
      ctx.fillText('COMBO', cx, RECEPTOR_Y + 250);
      ctx.restore();
    }

    // Score % + grade (top-right).
    ctx.save();
    ctx.fillStyle = '#e6e8ee';
    ctx.font = '700 26px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${(judge.percentDancePoints * 100).toFixed(2)}%`, this.width - 20, 40);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.fillText(`grade ${judge.grade}`, this.width - 20, 62);
    ctx.restore();

    // Life bar (top-left).
    ctx.save();
    const barW = 200;
    const barH = 14;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(20, 30, barW, barH);
    const life = judge.failed ? 0 : judge.life;
    ctx.fillStyle = life < 0.25 ? '#e64b4b' : life >= 1 ? '#7ff0ff' : '#5be06a';
    ctx.fillRect(20, 30, barW * life, barH);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(20, 30, barW, barH);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('LIFE', 20, 24);
    ctx.restore();
  }
}
