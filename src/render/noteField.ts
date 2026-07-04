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
const RECEPTOR_FLASH = 0.11; // seconds the receptor stays lit after a press
const EXPLOSION = 0.26; // seconds for the hit explosion ring/glow
const JUDGMENT_LIFE = 0.7; // seconds the judgment label shows (design keyframes)
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
  // Combo pop animation state (visual only).
  private lastCombo = 0;
  private comboPopAt = -10;

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
    // Dim so arrows stay readable (design: rgba(5,6,8,.6)).
    ctx.fillStyle = 'rgba(5,6,8,0.6)';
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

    this.drawHud(ctx, judge, now, progress, fb);
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
}
