/**
 * Live note-field preview: drives the real NoteFieldRenderer with real note
 * data — a Judge on autoplay — so the user sees the true note skin, scroll
 * type/spacing, and direction before playing. When a `clock` is provided
 * (Player Options passes the audio preview's position), the field follows the
 * audible music exactly — what you see is what you hear; otherwise it
 * free-runs on a rAF clock over a looping window. Scroll changes apply live
 * without rebuilding. Shared by Player Options (the selected chart) and the
 * Settings screen (the bundled demo pattern from demoChart()).
 */
import { useEffect, useRef } from 'react';
import type { NoteSkin, ScrollMode } from '../game/playOptions';
import { Judge, type ActiveNote } from '../gameplay/judge';
import { DEFAULT_WINDOWS } from '../gameplay/windows';
import { NoteData } from '../notes/noteData';
import {
  beatToNoteRow,
  noteRowToBeat,
  NO_KEYSOUND,
  NO_PLAYER,
  TapNoteScore,
  TapNoteSubType,
  TapNoteType,
  type TapNote,
} from '../notes/noteTypes';
import { isVideoFile } from '../io/songFiles';
import { columnAnglesFor } from '../render/columns';
import { beatTimes, GpuNoteField } from '../render/gpu/gpuNoteField';
import { type Feedback, type NoteFieldConfig, NoteFieldRenderer } from '../render/noteField';
import { songMaxBpm } from '../render/scroll';
import type { RenderMeta } from '../render/theme';
import { TimingData } from '../timing/timingData';
import { PRACTICE_LEAD_SECONDS, PRACTICE_TAIL_SECONDS } from '../game/playOptions';

export function NoteFieldPreview({
  noteData,
  timing,
  stepsType,
  scrollMode,
  scrollValue,
  noteSkin,
  reverse,
  loopWindow = null,
  clock = null,
  hud = false,
  meta = null,
  background = null,
  bgDim = 0.6,
  mediaRate = 1,
}: {
  noteData: NoteData;
  timing: TimingData;
  stepsType: string;
  scrollMode: ScrollMode;
  scrollValue: number;
  noteSkin: NoteSkin;
  reverse: boolean;
  /** Loop exactly this chart slice (seconds) instead of the default opening
   *  window — Player Options' practice section, so you preview what you'll
   *  actually be drilling. */
  loopWindow?: { startSeconds: number; endSeconds: number } | null;
  /** External master clock: the current audible song position in seconds, or
   *  null when nothing is playing. When it yields a position the field follows
   *  it exactly (audio/visual sync); on null it free-runs. */
  clock?: (() => number | null) | null;
  /** Draw the full HUD chrome (song panel, gauge, score, judgments) — the
   *  Player Options preview looks just like the real thing. */
  hud?: boolean;
  /** Song title/artist/difficulty for the HUD panels (with `hud`). */
  meta?: RenderMeta | null;
  /** Background image/video File behind the field (with `hud`), like play. */
  background?: File | null;
  /** Dark-overlay alpha on the background media (matches session's bgMode). */
  bgDim?: number;
  /** Playback rate for a background video, matching the audio preview. */
  mediaRate?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Live-applied per frame (no rebuild): scroll.
  const liveRef = useRef({ scrollMode, scrollValue });
  liveRef.current = { scrollMode, scrollValue };
  const clockRef = useRef(clock);
  clockRef.current = clock;

  // The arcade skin previews on the WebGPU field, ITG on the canvas renderer.
  // The <canvas> is keyed by backend below: an element can only ever hold one
  // context type, so switching skins must swap in a fresh element.
  const backend: 'gpu' | '2d' = noteSkin === 'arcade' ? 'gpu' : '2d';

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let cancelled = false;
    let raf = 0;
    let ro: ResizeObserver | null = null;
    let gpuField: GpuNoteField | null = null;
    let renderer2d: NoteFieldRenderer | null = null;
    let ctx2d: CanvasRenderingContext2D | null = null;

    const maxBpm = songMaxBpm(timing.bpms);
    const angles = columnAnglesFor(stepsType, noteData.numTracks);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const LOOP = 9; // seconds of chart shown before looping

    // Background media (with hud): the same image/video the real session draws.
    let bgMedia: HTMLVideoElement | HTMLImageElement | null = null;
    let bgUrl: string | null = null;
    if (hud && background) {
      bgUrl = URL.createObjectURL(background);
      if (isVideoFile(background.name)) {
        const v = document.createElement('video');
        v.src = bgUrl;
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.playbackRate = mediaRate;
        bgMedia = v;
      } else {
        const img = new Image();
        img.src = bgUrl;
        bgMedia = img;
      }
    }

    let judge!: Judge;
    let feedback!: Feedback;
    let held!: boolean[];
    let releases!: Array<{ track: number; at: number }>;
    let cursor = 0;
    let lastSeq = 0;
    let windowStart = 0;
    let windowEnd = 0;

    // Also resets both backends' forward-only cull cursors — required after
    // every judge rebuild (each loop wrap starts the chart over).
    const resize = () => {
      const w = canvas.clientWidth || 300;
      const h = canvas.clientHeight || 400;
      if (gpuField) {
        gpuField.resize(w, h, dpr); // sets the backing store itself
      } else {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        renderer2d?.resize(w, h, dpr);
      }
    };

    // Autoplay-hit one note: perfect press at its exact time, holds held to
    // their tails (mines are avoided, like StepMania's autoplay, so they
    // scroll by intact). The pre-window catch-up skips the visual feedback.
    const hitNote = (n: ActiveNote, withFeedback: boolean) => {
      if (n.note.type === TapNoteType.Mine) return;
      const ev = judge.step(n.track, n.time, false);
      if (withFeedback) {
        feedback.laneFlash[n.track] = n.time;
        if (ev && ev.tns !== TapNoteScore.None) {
          feedback.laneHit[n.track] = { tns: ev.tns, atSeconds: n.time };
        }
      }
      if (n.tailTime > n.time) {
        held[n.track] = true;
        releases.push({ track: n.track, at: n.tailTime });
      } else {
        judge.step(n.track, n.tailTime, true);
      }
    };

    const rebuild = () => {
      judge = new Judge(noteData, timing, DEFAULT_WINDOWS, 1);
      resize();
      feedback = {
        lastJudgment: null,
        laneFlash: new Array<number>(noteData.numTracks).fill(-999),
        laneHit: new Array<Feedback['laneHit'][number]>(noteData.numTracks).fill(null),
      };
      held = new Array<boolean>(noteData.numTracks).fill(false);
      releases = [];
      cursor = 0;
      if (loopWindow) {
        // Practice section: loop that slice with the shared lead/tail —
        // identical to the audio preview's loop, so the two wrap together.
        windowStart = Math.max(0, loopWindow.startSeconds - PRACTICE_LEAD_SECONDS);
        windowEnd = Math.max(windowStart + 2, loopWindow.endSeconds + PRACTICE_TAIL_SECONDS);
      } else {
        const first = judge.notes[0]?.time ?? 0;
        const last = judge.notes[judge.notes.length - 1]?.time ?? first;
        windowStart = Math.max(0, first - 1.4);
        windowEnd = Math.max(windowStart + 2, Math.min(windowStart + LOOP, last + 1.2));
      }
      // Consume everything before the window as silent perfect autoplay hits,
      // so a mid-song window starts clean instead of missing its backlog.
      while (cursor < judge.notes.length && judge.notes[cursor].time < windowStart) {
        hitNote(judge.notes[cursor++], false);
      }
      lastSeq = judge.judgmentSeq;
    };

    // One reusable patch object so live changes apply without allocating in
    // the frame loop.
    const livePatch: Partial<NoteFieldConfig> = {};

    let base = 0;
    let lastNow = -Infinity;
    let songEnd = 0;
    const frame = (t: number) => {
      if (!base) base = t;
      // Master clock: the audible audio preview when one is playing, else the
      // free-running rAF clock. While synced, keep the fallback clock rebased
      // so an audio stop (debounce gap, decode failure) continues seamlessly.
      const audio = clockRef.current?.() ?? null;
      let now: number;
      if (audio !== null) {
        now = audio;
        base = t - (now - windowStart) * 1000;
      } else {
        now = windowStart + (t - base) / 1000;
        if (now >= windowEnd) {
          base = t;
          now = windowStart;
        }
      }
      // Any backward jump — the audio loop wrapping, the fallback wrapping, or
      // a clock hand-off — starts a fresh pass: re-arm the judged notes.
      if (now < lastNow - 0.25) rebuild();
      lastNow = now;
      if (import.meta.env.DEV) {
        (window as unknown as { __nfPreview?: { now: number; audio: number | null } }).__nfPreview =
          { now, audio };
      }
      const notes = judge.notes;
      // Autoplay: hit each note as it reaches the receptor.
      while (cursor < notes.length && notes[cursor].time <= now) hitNote(notes[cursor++], true);
      releases = releases.filter((r) => {
        if (r.at <= now) {
          judge.step(r.track, r.at, true);
          held[r.track] = false;
          return false;
        }
        return true;
      });
      judge.update(now, held);
      if (judge.judgmentSeq !== lastSeq) {
        lastSeq = judge.judgmentSeq;
        feedback.lastJudgment = { tns: judge.lastTns, atSeconds: now };
      }
      // Keep a background video loosely synced to the (audio-driven) clock,
      // exactly like the real session does.
      if (bgMedia instanceof HTMLVideoElement && now >= 0) {
        const v = bgMedia;
        if (v.paused) {
          v.currentTime = Math.max(0, now);
          void v.play().catch(() => {});
        } else if (Math.abs(v.currentTime - now) > 0.35) {
          v.currentTime = Math.max(0, now);
        }
      }
      livePatch.scrollMode = liveRef.current.scrollMode;
      livePatch.scrollValue = liveRef.current.scrollValue;
      (gpuField ?? renderer2d)?.applyConfig(livePatch);
      const beat = timing.getBeatFromElapsedTime(now);
      // HUD progress hairline: the loop for a practice section, else the song.
      const progress = !hud
        ? 0
        : loopWindow
          ? Math.min(
              1,
              Math.max(
                0,
                (now - loopWindow.startSeconds) /
                  Math.max(0.001, loopWindow.endSeconds - loopWindow.startSeconds),
              ),
            )
          : songEnd > 0
            ? Math.min(1, Math.max(0, now / songEnd))
            : 0;
      if (gpuField) gpuField.draw(judge, now, beat, progress, feedback);
      else if (renderer2d && ctx2d) renderer2d.draw(ctx2d, judge, now, beat, progress, feedback);
      raf = requestAnimationFrame(frame);
    };

    // Backend boot: GPU for the arcade skin (async device init), canvas 2D
    // otherwise — and as the arcade fallback when WebGPU is unavailable
    // (which renders the Simply Love look, same as gameplay's fallback).
    const fieldConfig: Partial<NoteFieldConfig> = {
      columnAngles: angles,
      noteSkin,
      reverse,
      bare: !hud, // hud: the real chrome; else notefield only
      bgDim: hud ? bgDim : 1,
      scrollMode: liveRef.current.scrollMode,
      scrollValue: liveRef.current.scrollValue,
      songMaxBpm: maxBpm,
      ...(hud && meta ? { meta } : {}),
    };
    void (async () => {
      if (backend === 'gpu') {
        gpuField = await GpuNoteField.create(canvas, noteData.numTracks, fieldConfig);
        if (cancelled) {
          gpuField?.destroy();
          gpuField = null;
          return;
        }
      }
      if (!gpuField) {
        ctx2d = canvas.getContext('2d');
        if (!ctx2d) return; // context type already claimed — nothing to draw
        renderer2d = new NoteFieldRenderer(noteData.numTracks, fieldConfig);
      }
      gpuField?.setBeatTimes(
        beatTimes((bt) => timing.getElapsedTimeFromBeat(bt), noteRowToBeat(noteData.lastRow())),
      );
      (gpuField ?? renderer2d)?.setBackground(bgMedia);
      rebuild();
      songEnd = judge.notes[judge.notes.length - 1]?.time ?? 0;
      ro = new ResizeObserver(() => resize());
      ro.observe(canvas);
      raf = requestAnimationFrame(frame);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      gpuField?.destroy();
      if (bgMedia instanceof HTMLVideoElement) {
        bgMedia.pause();
        bgMedia.removeAttribute('src');
        bgMedia.load();
      }
      if (bgUrl) URL.revokeObjectURL(bgUrl);
    };
    // Primitive deps for the window/meta so fresh objects each render are fine.
  }, [
    noteData,
    timing,
    stepsType,
    noteSkin,
    reverse,
    loopWindow?.startSeconds,
    loopWindow?.endSeconds,
    hud,
    bgDim,
    background,
    mediaRate,
    meta?.title,
    meta?.subtitle,
    meta?.difficulty,
  ]);

  return <canvas key={backend} ref={ref} className="h-full w-full" />;
}

// --- Demo chart for song-less previews (the Settings screen) ----------------

const DEMO_BPM = 120;

function demoTap(type: TapNoteType, subType = TapNoteSubType.Invalid, durationRows = 0): TapNote {
  return { type, subType, durationRows, keysoundIndex: NO_KEYSOUND, player: NO_PLAYER };
}

/**
 * A short looping dance-single pattern at 120 BPM showing everything a skin
 * styles: 4th/8th/12th/16th quantizations, freeze arrows, a mine, and a jump.
 * Built once and cached — NoteData/TimingData identity stays stable so the
 * preview effect doesn't rebuild on re-render.
 */
let demo: { noteData: NoteData; timing: TimingData; stepsType: string } | null = null;

export function demoChart(): { noteData: NoteData; timing: TimingData; stepsType: string } {
  if (demo) return demo;
  const nd = new NoteData(4);
  const tapAt = (beat: number, track: number) =>
    nd.setTapNote(track, beatToNoteRow(beat), demoTap(TapNoteType.Tap));
  // Quarters (red), then an eighth stair (blue off-beats). Beats start at 2 so
  // the first arrows scroll in rather than spawning on the receptors.
  for (const [b, t] of [
    [2, 0],
    [3, 1],
    [4, 2],
    [5, 3],
    [6, 0],
    [6.5, 1],
    [7, 2],
    [7.5, 3],
    [8, 2],
    [8.5, 1],
    [9, 0],
    [9.5, 2],
  ] as const) {
    tapAt(b, t);
  }
  // Freeze arrow (2 beats) under a little run.
  nd.setTapNote(
    0,
    beatToNoteRow(10),
    demoTap(TapNoteType.HoldHead, TapNoteSubType.Hold, beatToNoteRow(2)),
  );
  for (const [b, t] of [
    [11, 2],
    [11.5, 3],
    [12, 1],
    [12.5, 2],
    [13, 3],
  ] as const) {
    tapAt(b, t);
  }
  // A 16th run (yellow), a mine, then a jump.
  for (let i = 0; i < 8; i++) tapAt(14 + i * 0.25, i % 4);
  nd.setTapNote(1, beatToNoteRow(16.5), demoTap(TapNoteType.Mine));
  tapAt(17, 0);
  tapAt(17, 3);
  // 12th triplets (purple/green) and a quarter outro.
  for (const [b, t] of [
    [18, 0],
    [18 + 1 / 3, 1],
    [18 + 2 / 3, 2],
    [19, 3],
    [19 + 1 / 3, 2],
    [19 + 2 / 3, 1],
    [20, 0],
    [21, 3],
    [22, 1],
    [23, 2],
  ] as const) {
    tapAt(b, t);
  }
  const timing = new TimingData();
  timing.bpms.push({ row: 0, bps: DEMO_BPM / 60 });
  timing.tidy();
  demo = { noteData: nd, timing, stepsType: 'dance-single' };
  return demo;
}
