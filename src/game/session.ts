/**
 * Ties the pieces into a playable session: Web Audio clock + judgment engine +
 * canvas renderer, driven by requestAnimationFrame. The engine is device-
 * agnostic: ALL input arrives via press()/release() with the raw event
 * timestamp so judging stays on the audible axis (spec doc 6) — the unified
 * input bus (src/input/inputBus.ts) feeds it from Play.tsx. See the core loop
 * in spec doc 9 §9.5.
 */

import { WebAudioClock } from '../audio/clock';
import { makeClickTrack, type Click } from '../audio/synth';
import { Judge } from '../gameplay/judge';
import { DEFAULT_WINDOWS } from '../gameplay/windows';
import { noteRowToBeat, TapNoteScore } from '../notes/noteTypes';
import { remapTracks, turnPermutation } from '../notes/transforms';
import {
  DEFAULT_PLAY_OPTIONS,
  PRACTICE_LEAD_SECONDS,
  PRACTICE_TAIL_SECONDS,
  type PlayOptions,
  type PracticeSection,
} from './playOptions';
import { columnAnglesFor } from '../render/columns';
import { beatTimes, GpuNoteField } from '../render/gpu/gpuNoteField';
import { NoteFieldRenderer, type Feedback, type NoteFieldConfig } from '../render/noteField';
import { songMaxBpm } from '../render/scroll';
import { difficultyToString } from '../song/difficulty';
import type { Song } from '../song/song';
import type { Steps } from '../song/steps';
import type { TimingData } from '../timing/timingData';

const LEAD_IN_SECONDS = 2;
const TAIL_SECONDS = 2;

/**
 * Playback options applied to a session — the shared PlayOptions shape
 * (src/game/playOptions.ts), which the persisted Settings also extends, so the
 * two can't drift, plus the per-play (never persisted) practice section.
 */
export type SessionConfig = PlayOptions & {
  /** Loop this beat range over and over (practice mode); null = play through. */
  practice?: PracticeSection | null;
};

export const DEFAULT_SESSION_CONFIG: SessionConfig = { ...DEFAULT_PLAY_OPTIONS };

export class GameSession {
  readonly judge: Judge;
  private readonly clock = new WebAudioClock();
  // The field renderer is decided in start(): GPU init is async, and a canvas
  // element can only ever hold one context type — so nothing touches the
  // canvas until then. Exactly one of gpuField / (renderer + ctx2d) is live.
  private renderer: NoteFieldRenderer | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private gpuField: GpuNoteField | null = null;
  private readonly rendererConfig: Partial<NoteFieldConfig>;
  private bgMedia: HTMLVideoElement | HTMLImageElement | ImageBitmap | null = null;
  private readonly beatLineTimes: Float64Array;
  private readonly timing: TimingData;
  private readonly held: boolean[];
  private readonly feedback: Feedback;
  private readonly clicks: Click[] = [];
  private endSeconds: number;

  /** True once real decoded audio is playing (false = metronome fallback). */
  usingRealAudio = false;
  /** Per-tap timing errors in seconds (negative = early), for the results graph. */
  readonly offsets: number[] = [];
  /** Steps successfully hit this session (W1–W5). Session-lifetime: unlike the
   *  judge's counts it survives practice-loop resets, so the global lifetime
   *  step counter (app/stats.ts) can bank it once when the session ends. */
  stepsTaken = 0;

  private dpr = 1;
  private raf = 0;
  private running = false;
  /** Set by stop(); start() bails out if it fired during an await. */
  private stopped = false;
  private lastSeq = 0;
  private readonly visualOffsetSeconds: number;
  private readonly musicRate: number;
  /** Practice loop bounds in song-seconds; practice=false means play through. */
  private readonly practice: boolean;
  private readonly loopStartSeconds: number = 0;
  private readonly loopEndSeconds: number = 0;
  private loopCount = 1;
  private bgVideo: HTMLVideoElement | null = null;
  private energy = 0;
  private logicalW = 800;
  private logicalH = 720;

  onEnd?: (judge: Judge) => void;
  /** Practice mode: fired each time the loop restarts, with the new pass number. */
  onLoop?: (count: number) => void;

  constructor(
    song: Song,
    chart: Steps,
    private canvas: HTMLCanvasElement,
    private readonly config: SessionConfig = DEFAULT_SESSION_CONFIG,
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
              `${song.displayFullTitle}${chart.stepsType}${chart.meter}`,
            ),
          );

    const practice = config.practice ?? null;
    this.practice = practice !== null;
    if (practice) {
      this.loopStartSeconds = this.timing.getElapsedTimeFromBeat(practice.startBeat);
      this.loopEndSeconds = this.timing.getElapsedTimeFromBeat(practice.endBeat);
    }

    this.judge = new Judge(
      playNd,
      this.timing,
      DEFAULT_WINDOWS,
      config.musicRate,
      practice ? { startSeconds: this.loopStartSeconds, endSeconds: this.loopEndSeconds } : null,
    );
    this.rendererConfig = {
      scrollMode: config.scrollMode,
      scrollValue: config.scrollValue,
      songMaxBpm: songMaxBpm(this.timing.bpms),
      reverse: config.reverse,
      noteSkin: config.noteSkin,
      bgDim: config.bgMode === 'full' ? 0.25 : 0.6,
      columnAngles: columnAnglesFor(chart.stepsType, nd.numTracks),
      meta: {
        title: song.displayFullTitle || 'Untitled',
        subtitle: song.artist,
        difficulty: `${chart.stepsType}  ·  ${difficultyToString(chart.difficulty).toUpperCase()} ${chart.meter}`,
      },
    };
    this.clock.sync.playbackRate = config.musicRate;
    this.clock.sync.audioOffsetSeconds = config.audioOffsetMs / 1000;
    this.visualOffsetSeconds = config.visualOffsetMs / 1000;
    this.musicRate = config.musicRate;
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
    // Per-beat times for the GPU field's beat-line pass.
    this.beatLineTimes = beatTimes((beat) => this.timing.getElapsedTimeFromBeat(beat), lastBeat);

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
  setBackground(media: HTMLVideoElement | HTMLImageElement | ImageBitmap | null): void {
    this.bgMedia = media;
    this.gpuField?.setBackground(media);
    this.renderer?.setBackground(media);
    this.bgVideo = media instanceof HTMLVideoElement ? media : null;
    if (this.bgVideo) this.bgVideo.playbackRate = this.musicRate;
  }

  /** True once start() picked (and successfully initialized) the GPU field. */
  get usingGpuRenderer(): boolean {
    return this.gpuField !== null;
  }

  /** Resize to a logical (CSS) size; the backing store is scaled by devicePixelRatio. */
  resize(width: number, height: number): void {
    this.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    this.logicalW = width;
    this.logicalH = height;
    if (this.gpuField) {
      this.gpuField.resize(width, height, this.dpr); // sets the backing store
    } else {
      this.canvas.width = Math.round(width * this.dpr);
      this.canvas.height = Math.round(height * this.dpr);
      this.renderer?.resize(width, height, this.dpr);
    }
  }

  /** Build the 2D renderer on `el` (start()'s canvas path, or GPU fallback). */
  private setupCanvasRenderer(el: HTMLCanvasElement): void {
    const ctx = el.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.canvas = el;
    this.ctx2d = ctx;
    this.renderer = new NoteFieldRenderer(this.held.length, this.rendererConfig);
    if (this.bgMedia) this.renderer.setBackground(this.bgMedia);
    this.resize(this.logicalW, this.logicalH);
  }

  /**
   * Drop to the canvas renderer after the GPU path failed (init or device
   * loss). The old canvas may already hold a dead 'webgpu' context — and a
   * canvas can never switch context types — so it is replaced with a fresh
   * element in the same spot.
   */
  private fallbackToCanvas(): void {
    if (this.renderer) return; // already fell back
    this.gpuField?.destroy();
    this.gpuField = null;
    const old = this.canvas;
    const fresh = old.cloneNode(false) as HTMLCanvasElement;
    old.parentElement?.insertBefore(fresh, old);
    old.remove();
    this.setupCanvasRenderer(fresh);
  }

  /**
   * Start playback. Pass the song's encoded audio bytes to play the real track;
   * omit it (or pass null) to play a synthesized metronome instead.
   */
  async start(encodedAudio: ArrayBuffer | null = null): Promise<void> {
    // Pick the field renderer first (once per session). The arcade skin is
    // WebGPU-only (its canvas theme was removed); anything failing here lands
    // on the canvas renderer, which draws the Simply Love look.
    if (!this.renderer && !this.gpuField) {
      if (this.config.noteSkin === 'arcade') {
        const gpu = await GpuNoteField.create(this.canvas, this.held.length, this.rendererConfig);
        // stop() may have run during the await (StrictMode's doubled mount
        // starts and immediately replaces a session) — don't touch the
        // disposed clock, and don't leak the fresh device.
        if (this.stopped) {
          gpu?.destroy();
          return;
        }
        if (gpu) {
          this.gpuField = gpu;
          gpu.onLost = () => this.fallbackToCanvas();
          gpu.resize(this.logicalW, this.logicalH, this.dpr);
          gpu.setBeatTimes(this.beatLineTimes);
          if (this.bgMedia) gpu.setBackground(this.bgMedia);
        } else {
          this.fallbackToCanvas();
        }
      } else {
        this.setupCanvasRenderer(this.canvas);
      }
    }
    if (this.stopped) return;
    await this.clock.resume();
    let usedAudio = false;
    if (encodedAudio) {
      try {
        await this.clock.load(encodedAudio);
        // Play until the later of the last note and the end of the music.
        this.endSeconds = Math.max(this.endSeconds, this.clock.durationSeconds);
        usedAudio = true;
      } catch (err) {
        // Unsupported/corrupt audio — fall back to the metronome below.
        console.warn('Song audio failed to decode; playing the metronome instead.', err);
      }
    }
    this.usingRealAudio = usedAudio;
    if (!usedAudio) {
      const buffer = makeClickTrack(this.clock.ctx, this.clicks, this.endSeconds + 0.5);
      this.clock.setBuffer(buffer);
    }
    // Practice starts just before the section; song time < the section start
    // during the pre-roll (like the negative time of a normal lead-in).
    this.clock.start(this.startOffsetSeconds(), LEAD_IN_SECONDS);
    this.running = true;
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Where in the song playback (re)starts: 0, or just before the practice section. */
  private startOffsetSeconds(): number {
    return this.practice ? Math.max(0, this.loopStartSeconds - PRACTICE_LEAD_SECONDS) : 0;
  }

  /** Jump back to the section start for another practice pass, judging afresh. */
  private restartLoop(): void {
    this.loopCount++;
    this.judge.reset();
    this.lastSeq = this.judge.judgmentSeq;
    this.feedback.lastJudgment = null;
    this.feedback.laneFlash.fill(-999);
    this.feedback.laneHit.fill(null);
    this.offsets.length = 0;
    this.energy = 0;
    this.clock.start(this.startOffsetSeconds(), 0.25);
    this.onLoop?.(this.loopCount);
  }

  press(track: number, eventTimeStampMs: number): void {
    if (track < 0 || track >= this.held.length) return;
    this.held[track] = true;
    const t = this.clock.songSecondsAtEvent(eventTimeStampMs);
    this.feedback.laneFlash[track] = t;
    const ev = this.judge.step(track, t, false);
    if (ev && ev.tns !== TapNoteScore.None) {
      this.feedback.laneHit[track] = { tns: ev.tns, atSeconds: t };
      if (ev.tns !== TapNoteScore.HitMine) {
        this.offsets.push(ev.offset);
        this.stepsTaken++;
      }
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

    this.energy *= 0.9;
    if (this.judge.judgmentSeq !== this.lastSeq) {
      this.lastSeq = this.judge.judgmentSeq;
      this.feedback.lastJudgment = { tns: this.judge.lastTns, atSeconds: now };
      this.energy = Math.min(1, this.energy + 0.55);
    }

    // Rendering uses a visually-offset clock (judgment stays on the raw `now`).
    const visualNow = now - this.visualOffsetSeconds;
    const beat = this.timing.getBeatFromElapsedTime(visualNow);
    // Practice: the HUD progress hairline tracks the loop, not the song.
    const progress = this.practice
      ? Math.min(
          1,
          Math.max(
            0,
            (now - this.loopStartSeconds) /
              Math.max(0.001, this.loopEndSeconds - this.loopStartSeconds),
          ),
        )
      : now <= 0
        ? 0
        : Math.min(1, now / this.endSeconds);
    if (this.gpuField) {
      this.gpuField.draw(this.judge, visualNow, beat, progress, this.feedback);
    } else if (this.renderer && this.ctx2d) {
      this.renderer.draw(this.ctx2d, this.judge, visualNow, beat, progress, this.feedback);
    }

    if (this.practice) {
      // Loop forever (until the player exits): past the section's post-roll —
      // or the end of the audio, whichever comes first — jump back and rejudge.
      const resetAt = Math.min(this.loopEndSeconds + PRACTICE_TAIL_SECONDS, this.endSeconds);
      if (now >= resetAt) this.restartLoop();
    } else if (now >= this.endSeconds) {
      this.finish();
      return;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private finish(): void {
    this.running = false;
    // dispose() (not just stop()) releases the AudioContext — browsers cap
    // concurrent contexts and every play/retry builds a fresh session.
    void this.clock.dispose();
    this.onEnd?.(this.judge);
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    void this.clock.dispose();
    this.bgVideo?.pause();
    // Release the GPU device (finish() keeps it so the last frame stays up
    // behind the results overlay; stop() means the surface is going away).
    // Detach onLost first: destroy() resolves device.lost, and the fallback
    // must not fire for an intentional teardown.
    if (this.gpuField) {
      this.gpuField.onLost = undefined;
      this.gpuField.destroy();
      this.gpuField = null;
    }
  }
}
