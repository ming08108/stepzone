/**
 * Ties the pieces into a playable session: Web Audio clock + judgment engine +
 * canvas renderer, driven by requestAnimationFrame. Input arrives via press()/
 * release() with the raw event timestamp so judging stays on the audible axis
 * (spec doc 6). See the core loop in spec doc 9 §9.5.
 */

import { WebAudioClock } from '../audio/clock';
import { makeClickTrack, type Click } from '../audio/synth';
import { Judge } from '../gameplay/judge';
import { beatToNoteRow, noteRowToBeat } from '../notes/noteTypes';
import { NoteFieldRenderer, type Feedback } from '../render/noteField';
import type { Song } from '../song/song';
import type { Steps } from '../song/steps';

const LEAD_IN_SECONDS = 2;
const TAIL_SECONDS = 2;

export class GameSession {
  readonly judge: Judge;
  private readonly clock = new WebAudioClock();
  private readonly renderer: NoteFieldRenderer;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly held: boolean[];
  private readonly feedback: Feedback;
  private readonly clicks: Click[] = [];
  private readonly endSeconds: number;

  private raf = 0;
  private running = false;
  private lastSeq = 0;

  onEnd?: (judge: Judge) => void;

  constructor(
    song: Song,
    chart: Steps,
    private readonly canvas: HTMLCanvasElement,
  ) {
    const timing = chart.getTimingData(song.timing);
    const nd = chart.getNoteData();

    this.judge = new Judge(nd, timing);
    this.renderer = new NoteFieldRenderer(nd.numTracks);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx2d = ctx;
    this.held = new Array<boolean>(nd.numTracks).fill(false);
    this.feedback = { lastJudgment: null, laneFlash: new Array<number>(nd.numTracks).fill(-999) };

    // Metronome clicks on every beat, accented on downbeats.
    const lastBeat = noteRowToBeat(nd.lastRow());
    for (let beat = 0; beat <= Math.ceil(lastBeat); beat++) {
      const t = timing.getElapsedTimeFromBeat(beat);
      if (t >= 0 && beatToNoteRow(beat) >= 0) {
        this.clicks.push({ time: t, accent: beat % 4 === 0 });
      }
    }

    let end = 0;
    for (const n of this.judge.notes) end = Math.max(end, n.tailTime);
    this.endSeconds = end + TAIL_SECONDS;

    this.resize(canvas.width, canvas.height);
  }

  /** Current audible song position in seconds (dev/testing hook). */
  get songNow(): number {
    return this.clock.songSecondsNow();
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.renderer.resize(width, height);
  }

  async start(): Promise<void> {
    await this.clock.resume();
    const buffer = makeClickTrack(this.clock.ctx, this.clicks, this.endSeconds + 0.5);
    this.clock.setBuffer(buffer);
    this.clock.start(0, LEAD_IN_SECONDS); // negative song time during lead-in
    this.running = true;
    this.raf = requestAnimationFrame(this.loop);
  }

  press(track: number, eventTimeStampMs: number): void {
    if (track < 0 || track >= this.held.length) return;
    this.held[track] = true;
    const t = this.clock.songSecondsAtEvent(eventTimeStampMs);
    this.feedback.laneFlash[track] = t;
    this.judge.step(track, t, false);
  }

  release(track: number, eventTimeStampMs: number): void {
    if (track < 0 || track >= this.held.length) return;
    this.held[track] = false;
    const t = this.clock.songSecondsAtEvent(eventTimeStampMs);
    this.judge.step(track, t, true);
  }

  private loop = (): void => {
    if (!this.running) return;
    const now = this.clock.songSecondsNow();
    this.judge.update(now, this.held);

    if (this.judge.judgmentSeq !== this.lastSeq) {
      this.lastSeq = this.judge.judgmentSeq;
      this.feedback.lastJudgment = { tns: this.judge.lastTns, atSeconds: now };
    }

    this.renderer.draw(this.ctx2d, this.judge, now, this.feedback);

    if (now >= this.endSeconds) {
      this.finish();
      return;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private finish(): void {
    this.running = false;
    this.clock.stop();
    this.onEnd?.(this.judge);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.clock.stop();
  }
}
