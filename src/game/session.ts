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
import { MAX_GHOST_FRAMES, type GhostFrame, type ReplayEvent } from '../net/protocol';
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
import type { Feedback, NoteFieldConfig } from '../render/fieldConfig';
import { songMaxBpm } from '../render/scroll';
import { difficultyToString } from '../song/difficulty';
import type { Song } from '../song/song';
import type { Steps } from '../song/steps';
import type { TimingData } from '../timing/timingData';

const LEAD_IN_SECONDS = 2;
const TAIL_SECONDS = 2;
/** Hard cap on the recorded input log — no real play comes close, but a stuck
 *  key or hostile input can't grow it without bound. */
const MAX_INPUT_LOG = 100_000;

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
  // The field renders on WebGPU (both skins). GPU init is async, so nothing
  // touches the canvas until start(); if the device is unavailable or lost,
  // there is no canvas fallback — the app requires WebGPU to play.
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
  /** Scoreboard timeline of this play (2 Hz), for the online ghost. Not
   *  recorded in practice mode (looping timelines are meaningless). */
  readonly ghostFrames: GhostFrame[] = [];
  private lastGhostAt = Number.NEGATIVE_INFINITY;

  /** Every judged-relevant input this play (song-seconds, 4dp), in time order —
   *  the replay of the run (todo: REPLAYS). Not recorded in practice mode
   *  (looping passes have no single coherent timeline) nor in a replay session
   *  (it is being driven FROM a log, not producing one). */
  readonly inputLog: ReplayEvent[] = [];
  /** When set, this is a REPLAY session: live press()/release() are ignored and
   *  the loop feeds these events on the judge's own time axis instead. */
  private replayEvents: ReplayEvent[] | null = null;
  private replayCursor = 0;

  /** Rival field layouts (live versus): extra views on the SAME canvas — one
   *  render, one shared background. Up to 3 rivals (4 players). Set before/after
   *  start(); empty for solo play. */
  private rivalConfigs: {
    numTracks: number;
    columnAngles: number[];
    meta: NoteFieldConfig['meta'];
  }[] = [];
  /** The rivals' mirror judges + feedback (parallel to rivalConfigs), maintained
   *  by the UI from each rival's streamed judgment feed; the loop just hands the
   *  array to the field each frame. */
  rivalSources: { judge: Judge; feedback: Feedback }[] = [];

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
  private logicalW = 800;
  private logicalH = 720;

  onEnd?: (judge: Judge) => void;
  /** Fired when WebGPU is unavailable at start or the device is lost mid-song —
   *  there is no canvas fallback, so the UI surfaces a "WebGPU required" error. */
  onError?: () => void;
  /** Practice mode: fired each time the loop restarts, with the new pass number. */
  onLoop?: (count: number) => void;

  constructor(
    song: Song,
    chart: Steps,
    private canvas: HTMLCanvasElement,
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

  /** True when this session is replaying a recorded log rather than taking live
   *  input — the UI ignores its own press/release and suppresses scoring. */
  get isReplay(): boolean {
    return this.replayEvents !== null;
  }

  /**
   * Turn this into a replay session: the loop drives the judge from `events`
   * (time-sorted; the same (track, t, up) triples press()/release() feed live)
   * and live input is ignored. Set before start()/begin().
   */
  setReplay(events: ReplayEvent[]): void {
    this.replayEvents = events;
    this.replayCursor = 0;
  }

  /** True when at least one rival view is being drawn (dev/testing hook). */
  get hasRival(): boolean {
    return this.rivalSources.length > 0 && this.rivalConfigs.length > 0;
  }

  /** Number of rival views on the canvas (dev/testing hook). */
  get rivalCount(): number {
    return this.rivalConfigs.length;
  }

  /** Set the rivals' side-by-side field views (live versus); [] for solo. */
  setRivalFields(cfgs: typeof this.rivalConfigs): void {
    this.rivalConfigs = cfgs;
    this.gpuField?.setRivals(cfgs);
  }

  /** Set (or clear) the background video/image drawn behind the field. */
  setBackground(media: HTMLVideoElement | HTMLImageElement | ImageBitmap | null): void {
    this.bgMedia = media;
    this.gpuField?.setBackground(media);
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
    this.gpuField?.resize(width, height, this.dpr); // sets the backing store
  }

  /**
   * Start playback. Pass the song's encoded audio bytes to play the real track;
   * omit it (or pass null) to play a synthesized metronome instead.
   */
  async start(encodedAudio: ArrayBuffer | null = null): Promise<void> {
    if (await this.prepare(encodedAudio)) this.begin();
  }

  /** Set by prepare(): a fresh GPU field still needs its warm-up frames. */
  private pendingPrewarm = false;

  /**
   * Everything slow and asynchronous before a session can begin: GPU field
   * init, audio decode, AudioContext resume. Separated from begin() so netplay
   * can prepare, report "loaded", and hold until the server says go — solo
   * play calls start(), which is prepare()+begin() back to back.
   * Returns false when the session was stopped mid-prepare or GPU init failed.
   */
  async prepare(encodedAudio: ArrayBuffer | null = null): Promise<boolean> {
    let freshField = false;
    // Create the WebGPU field once per session (both skins render on it). If
    // the device is unavailable there is no canvas fallback — surface an error.
    if (!this.gpuField) {
      const gpu = await GpuNoteField.create(this.canvas, this.held.length, this.rendererConfig);
      // stop() may have run during the await (StrictMode's doubled mount
      // starts and immediately replaces a session) — don't touch the
      // disposed clock, and don't leak the fresh device.
      if (this.stopped) {
        gpu?.destroy();
        return false;
      }
      if (!gpu) {
        this.onError?.();
        return false;
      }
      this.gpuField = gpu;
      gpu.onLost = () => {
        this.gpuField = null;
        this.onError?.();
      };
      gpu.resize(this.logicalW, this.logicalH, this.dpr);
      gpu.setBeatTimes(this.beatLineTimes);
      if (this.rivalConfigs.length) gpu.setRivals(this.rivalConfigs);
      if (this.bgMedia) gpu.setBackground(this.bgMedia);
      freshField = true;
    }
    if (this.stopped) return false;
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
    this.pendingPrewarm = freshField;
    return !this.stopped;
  }

  /** Schedule playback and run the frame loop; call only after prepare(). */
  begin(): void {
    if (this.stopped || this.running) return;
    // Practice starts just before the section; song time < the section start
    // during the pre-roll (like the negative time of a normal lead-in).
    this.clock.start(this.startOffsetSeconds(), LEAD_IN_SECONDS);
    this.running = true;
    // Bake the atlas + compile pipelines now — AFTER the audio-decode await
    // in prepare(), not before it. prewarm() paints two synthetic warm-up
    // frames; when it ran ahead of the (multi-second) decode those phantom
    // arrows sat on the swapchain the whole time. Running it here and
    // immediately painting the real starting field in the SAME task overwrites
    // the warm-up frames in the current swapchain texture before it is ever
    // presented — no phantom flash.
    const gpu = this.gpuField;
    if (this.pendingPrewarm && gpu) {
      this.pendingPrewarm = false;
      gpu.prewarm();
      const visualNow = this.clock.songSecondsNow() - this.visualOffsetSeconds;
      const beat = this.timing.getBeatFromElapsedTime(visualNow);
      gpu.draw(this.judge, visualNow, beat, 0, this.feedback);
    }
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
    this.clock.start(this.startOffsetSeconds(), 0.25);
    this.onLoop?.(this.loopCount);
  }

  /**
   * The shared input path: judge one press/release on a column at song-time `t`
   * and drive the same feedback (lane flash on a press, lane hit + timing
   * offset on a scored tap). Both live input (press/release) and replay
   * playback funnel through here so they are frame-for-frame identical.
   */
  private feed(track: number, t: number, up: boolean): void {
    if (track < 0 || track >= this.held.length) return;
    this.held[track] = !up;
    if (up) {
      this.judge.step(track, t, true);
      return;
    }
    this.feedback.laneFlash[track] = t;
    const ev = this.judge.step(track, t, false);
    if (ev && ev.tns !== TapNoteScore.None) {
      this.feedback.laneHit[track] = { tns: ev.tns, atSeconds: t, white: ev.white };
      if (ev.tns !== TapNoteScore.HitMine) {
        this.offsets.push(ev.offset);
        this.stepsTaken++;
      }
    }
  }

  /** Record one input into the replay log (skipped in practice/replay sessions). */
  private recordInput(track: number, t: number, up: boolean): void {
    if (this.practice || this.isReplay || this.inputLog.length >= MAX_INPUT_LOG) return;
    this.inputLog.push({ t: Math.round(t * 1e4) / 1e4, track, up });
  }

  press(track: number, eventTimeStampMs: number): void {
    if (this.isReplay || track < 0 || track >= this.held.length) return;
    const t = this.clock.songSecondsAtEvent(eventTimeStampMs);
    this.recordInput(track, t, false);
    this.feed(track, t, false);
  }

  release(track: number, eventTimeStampMs: number): void {
    if (this.isReplay || track < 0 || track >= this.held.length) return;
    const t = this.clock.songSecondsAtEvent(eventTimeStampMs);
    this.recordInput(track, t, true);
    this.feed(track, t, true);
  }

  private loop = (): void => {
    if (!this.running) return;
    const now = this.clock.songSecondsNow();

    // Background-video sync. A song's background movie is matched to the music,
    // so the video's own time should equal the music position (`now`). ITGmania
    // never seeks a playing movie — it free-runs it at the music rate (its
    // MovieTexture refuses non-zero seeks) — so we do the same and correct drift
    // by nudging playbackRate (a PLL), not by seeking. That also fixes a constant
    // lag: seeking to `now` and calling play() leaves the video ~0.1-0.2s behind
    // (decode/play latency), which the old 0.35s tolerance never corrected.
    if (this.bgVideo && now >= 0) {
      const v = this.bgVideo;
      const rate = this.musicRate;
      if (v.paused) {
        v.currentTime = Math.max(0, now);
        v.playbackRate = rate;
        void v.play().catch(() => {});
      } else {
        const drift = v.currentTime - now; // +ve: video is ahead of the music
        if (Math.abs(drift) > 1.5) {
          // Gross desync (tab was backgrounded, a long stall) — hard resync.
          v.currentTime = Math.max(0, now);
          v.playbackRate = rate;
        } else if (Math.abs(drift) > 0.04) {
          // Ease back: slow the video when it's ahead, speed it up when behind.
          const nudge = Math.max(-0.15, Math.min(0.15, drift * 1.5));
          v.playbackRate = Math.max(0.25, rate - nudge);
        } else {
          v.playbackRate = rate;
        }
      }
    }

    // Replay playback: feed every recorded input due by `now` through the same
    // path live presses take, before the judge ages misses this frame.
    if (this.replayEvents) {
      const evs = this.replayEvents;
      while (this.replayCursor < evs.length && evs[this.replayCursor].t <= now) {
        const e = evs[this.replayCursor++];
        this.feed(e.track, e.t, e.up);
      }
    }

    this.judge.update(now, this.held);

    // Ghost sample (after judging, so the frame reflects everything at `now`).
    if (
      !this.practice &&
      now >= 0 &&
      now >= this.lastGhostAt + 0.5 &&
      this.ghostFrames.length < MAX_GHOST_FRAMES
    ) {
      this.lastGhostAt = now;
      this.ghostFrames.push({
        atSong: Math.round(now * 100) / 100,
        percent: Math.max(0, Math.min(1, Math.round(this.judge.percentDancePoints * 1e4) / 1e4)),
        combo: this.judge.combo,
        life: Math.max(0, Math.min(1, Math.round(this.judge.life * 1e3) / 1e3)),
      });
    }

    if (this.judge.judgmentSeq !== this.lastSeq) {
      this.lastSeq = this.judge.judgmentSeq;
      this.feedback.lastJudgment = {
        tns: this.judge.lastTns,
        atSeconds: now,
        white: this.judge.lastWhite,
      };
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
    this.gpuField?.draw(
      this.judge,
      visualNow,
      beat,
      progress,
      this.feedback,
      this.rivalSources.length ? this.rivalSources : undefined,
    );

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
    // Detach onLost first: destroy() resolves device.lost, and the error
    // handler must not fire for an intentional teardown.
    if (this.gpuField) {
      this.gpuField.onLost = undefined;
      this.gpuField.destroy();
      this.gpuField = null;
    }
  }
}
