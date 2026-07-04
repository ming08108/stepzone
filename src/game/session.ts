/**
 * Ties the pieces into a playable session: Web Audio clock + judgment engine +
 * canvas renderer, driven by requestAnimationFrame. Input arrives via press()/
 * release() with the raw event timestamp so judging stays on the audible axis
 * (spec doc 6). See the core loop in spec doc 9 §9.5.
 */

import { WebAudioClock } from '../audio/clock';
import { makeClickTrack, type Click } from '../audio/synth';
import { Judge } from '../gameplay/judge';
import { DEFAULT_WINDOWS } from '../gameplay/windows';
import { readGamepad } from '../input/gamepad';
import { noteRowToBeat, TapNoteScore } from '../notes/noteTypes';
import { remapTracks, turnPermutation, type Turn } from '../notes/transforms';
import { columnAnglesFor } from '../render/columns';
import { NoteFieldRenderer, type Feedback } from '../render/noteField';
import { difficultyToString } from '../song/difficulty';
import type { Song } from '../song/song';
import type { Steps } from '../song/steps';
import type { TimingData } from '../timing/timingData';

const LEAD_IN_SECONDS = 2;
const TAIL_SECONDS = 2;

/** Playback options applied to a session. */
export interface SessionConfig {
  scrollMode: 'C' | 'X' | 'M';
  scrollValue: number;
  musicRate: number;
  audioOffsetMs: number;
  visualOffsetMs: number;
  turn: Turn;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  scrollMode: 'C',
  scrollValue: 550,
  musicRate: 1,
  audioOffsetMs: 0,
  visualOffsetMs: 0,
  turn: 'none',
};

export class GameSession {
  readonly judge: Judge;
  private readonly clock = new WebAudioClock();
  private readonly renderer: NoteFieldRenderer;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly timing: TimingData;
  private readonly held: boolean[];
  private readonly feedback: Feedback;
  private readonly clicks: Click[] = [];
  private endSeconds: number;

  /** True once real decoded audio is playing (false = metronome fallback). */
  usingRealAudio = false;

  private dpr = 1;
  private raf = 0;
  private running = false;
  private lastSeq = 0;
  private readonly prevPad = [false, false, false, false];
  private readonly visualOffsetSeconds: number;
  private readonly musicRate: number;
  private bgVideo: HTMLVideoElement | null = null;

  onEnd?: (judge: Judge) => void;

  constructor(
    song: Song,
    chart: Steps,
    private readonly canvas: HTMLCanvasElement,
    config: SessionConfig = DEFAULT_SESSION_CONFIG,
  ) {
    this.timing = chart.getTimingData(song.timing);
    const nd = chart.getNoteData();
    // Apply the turn mod to a copy for play; the parsed chart is untouched.
    const playNd =
      config.turn === 'none'
        ? nd
        : remapTracks(
            nd,
            turnPermutation(
              config.turn,
              nd.numTracks,
              `${song.title}${chart.stepsType}${chart.meter}`,
            ),
          );

    this.judge = new Judge(playNd, this.timing, DEFAULT_WINDOWS, config.musicRate);
    this.renderer = new NoteFieldRenderer(nd.numTracks);
    const maxBpm = this.timing.bpms.reduce((m, b) => Math.max(m, b.bps * 60), 0) || 200;
    this.renderer.setScroll(config.scrollMode, config.scrollValue, maxBpm);
    this.renderer.setColumnAngles(columnAnglesFor(chart.stepsType, nd.numTracks));
    this.clock.sync.playbackRate = config.musicRate;
    this.clock.sync.audioOffsetSeconds = config.audioOffsetMs / 1000;
    this.visualOffsetSeconds = config.visualOffsetMs / 1000;
    this.musicRate = config.musicRate;
    this.renderer.setMeta({
      title: song.title || 'Untitled',
      subtitle: song.artist,
      difficulty: `${chart.stepsType}  ·  ${difficultyToString(chart.difficulty).toUpperCase()} ${chart.meter}`,
    });

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx2d = ctx;
    this.held = new Array<boolean>(nd.numTracks).fill(false);
    this.feedback = {
      lastJudgment: null,
      laneFlash: new Array<number>(nd.numTracks).fill(-999),
      laneHit: new Array<Feedback['laneHit'][number]>(nd.numTracks).fill(null),
    };

    // Metronome clicks on every beat, accented on downbeats.
    const lastBeat = noteRowToBeat(nd.lastRow());
    for (let beat = 0; beat <= Math.ceil(lastBeat); beat++) {
      const t = this.timing.getElapsedTimeFromBeat(beat);
      if (t >= 0) this.clicks.push({ time: t, accent: beat % 4 === 0 });
    }

    let end = 0;
    for (const n of this.judge.notes) end = Math.max(end, n.tailTime);
    this.endSeconds = end + TAIL_SECONDS;

    this.resize(canvas.clientWidth || 800, canvas.clientHeight || 720);
  }

  /** Current audible song position in seconds (dev/testing hook). */
  get songNow(): number {
    return this.clock.songSecondsNow();
  }

  /** Set (or clear) the background video/image drawn behind the field. */
  setBackground(media: HTMLVideoElement | HTMLImageElement | null): void {
    this.renderer.setBackground(media);
    this.bgVideo = media instanceof HTMLVideoElement ? media : null;
    if (this.bgVideo) this.bgVideo.playbackRate = this.musicRate;
  }

  /** Resize to a logical (CSS) size; the backing store is scaled by devicePixelRatio. */
  resize(width: number, height: number): void {
    this.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.renderer.resize(width, height, this.dpr);
  }

  /**
   * Start playback. Pass the song's encoded audio bytes to play the real track;
   * omit it (or pass null) to play a synthesized metronome instead.
   */
  async start(encodedAudio: ArrayBuffer | null = null): Promise<void> {
    await this.clock.resume();
    let usedAudio = false;
    if (encodedAudio) {
      try {
        await this.clock.load(encodedAudio);
        // Play until the later of the last note and the end of the music.
        this.endSeconds = Math.max(this.endSeconds, this.clock.durationSeconds);
        usedAudio = true;
      } catch {
        // Unsupported/corrupt audio — fall back to the metronome below.
      }
    }
    this.usingRealAudio = usedAudio;
    if (!usedAudio) {
      const buffer = makeClickTrack(this.clock.ctx, this.clicks, this.endSeconds + 0.5);
      this.clock.setBuffer(buffer);
    }
    this.clock.start(0, LEAD_IN_SECONDS); // negative song time during lead-in
    this.running = true;
    this.raf = requestAnimationFrame(this.loop);
  }

  press(track: number, eventTimeStampMs: number): void {
    if (track < 0 || track >= this.held.length) return;
    this.held[track] = true;
    const t = this.clock.songSecondsAtEvent(eventTimeStampMs);
    this.feedback.laneFlash[track] = t;
    const ev = this.judge.step(track, t, false);
    if (ev && ev.tns !== TapNoteScore.None) {
      this.feedback.laneHit[track] = { tns: ev.tns, atSeconds: t };
    }
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

    // Gamepad / dance pad (poll-only; frame-quantized timing).
    const pad = readGamepad();
    if (pad.connected) {
      const ts = performance.now();
      for (let c = 0; c < this.prevPad.length && c < this.held.length; c++) {
        if (pad.columns[c] && !this.prevPad[c]) this.press(c, ts);
        else if (!pad.columns[c] && this.prevPad[c]) this.release(c, ts);
        this.prevPad[c] = pad.columns[c];
      }
    }

    // Keep a background video loosely synced to the song.
    if (this.bgVideo && now >= 0) {
      const v = this.bgVideo;
      if (v.paused) {
        v.currentTime = Math.max(0, now);
        void v.play().catch(() => {});
      } else if (Math.abs(v.currentTime - now) > 0.35) {
        v.currentTime = Math.max(0, now);
      }
    }

    this.judge.update(now, this.held);

    if (this.judge.judgmentSeq !== this.lastSeq) {
      this.lastSeq = this.judge.judgmentSeq;
      this.feedback.lastJudgment = { tns: this.judge.lastTns, atSeconds: now };
    }

    // Rendering uses a visually-offset clock (judgment stays on the raw `now`).
    const visualNow = now - this.visualOffsetSeconds;
    const beat = this.timing.getBeatFromElapsedTime(visualNow);
    const progress = now <= 0 ? 0 : Math.min(1, now / this.endSeconds);
    this.renderer.draw(this.ctx2d, this.judge, visualNow, beat, progress, this.feedback);

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
    this.bgVideo?.pause();
  }
}
