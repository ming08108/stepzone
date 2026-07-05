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
import { Judge } from '../gameplay/judge';
import { DEFAULT_WINDOWS } from '../gameplay/windows';
import { NoteData } from '../notes/noteData';
import {
  beatToNoteRow,
  NO_KEYSOUND,
  NO_PLAYER,
  TapNoteScore,
  TapNoteSubType,
  TapNoteType,
  type TapNote,
} from '../notes/noteTypes';
import { columnAnglesFor } from '../render/columns';
import { type Feedback, type NoteFieldConfig, NoteFieldRenderer } from '../render/noteField';
import { songMaxBpm } from '../render/scroll';
import { TimingData } from '../timing/timingData';

/**
 * How much music plays before/after a practice-section loop window — the same
 * feel as gameplay's practice pre/post-roll (src/game/session.ts). Player
 * Options pads the audio preview's loop with these so the audio and the
 * synced note field wrap at the same instant.
 */
export const PREVIEW_LEAD_SECONDS = 1.5;
export const PREVIEW_TAIL_SECONDS = 0.5;

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
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Live-applied per frame (no rebuild): scroll.
  const liveRef = useRef({ scrollMode, scrollValue });
  liveRef.current = { scrollMode, scrollValue };
  const clockRef = useRef(clock);
  clockRef.current = clock;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const maxBpm = songMaxBpm(timing.bpms);
    const angles = columnAnglesFor(stepsType, noteData.numTracks);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const LOOP = 9; // seconds of chart shown before looping

    let judge!: Judge;
    let renderer!: NoteFieldRenderer;
    let feedback!: Feedback;
    let held!: boolean[];
    let releases!: Array<{ track: number; at: number }>;
    let cursor = 0;
    let lastSeq = 0;
    let windowStart = 0;
    let windowEnd = 0;

    const resize = () => {
      const w = canvas.clientWidth || 300;
      const h = canvas.clientHeight || 400;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      renderer.resize(w, h, dpr);
    };

    const rebuild = () => {
      judge = new Judge(noteData, timing, DEFAULT_WINDOWS, 1);
      renderer = new NoteFieldRenderer(noteData.numTracks, {
        columnAngles: angles,
        noteSkin,
        reverse,
        bare: true, // notefield only — no HUD chrome in the preview
        bgDim: 1, // no song background in the preview
        scrollMode: liveRef.current.scrollMode,
        scrollValue: liveRef.current.scrollValue,
        songMaxBpm: maxBpm,
      });
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
        windowStart = Math.max(0, loopWindow.startSeconds - PREVIEW_LEAD_SECONDS);
        windowEnd = Math.max(windowStart + 2, loopWindow.endSeconds + PREVIEW_TAIL_SECONDS);
      } else {
        const first = judge.notes[0]?.time ?? 0;
        const last = judge.notes[judge.notes.length - 1]?.time ?? first;
        windowStart = Math.max(0, first - 1.4);
        windowEnd = Math.max(windowStart + 2, Math.min(windowStart + LOOP, last + 1.2));
      }
      // Consume everything before the window as silent perfect autoplay hits,
      // so a mid-song window starts clean instead of missing its backlog.
      while (cursor < judge.notes.length && judge.notes[cursor].time < windowStart) {
        const n = judge.notes[cursor];
        cursor++;
        if (n.note.type === TapNoteType.Mine) continue;
        judge.step(n.track, n.time, false);
        if (n.tailTime > n.time && n.tailTime >= windowStart) {
          held[n.track] = true;
          releases.push({ track: n.track, at: n.tailTime });
        } else {
          judge.step(n.track, n.tailTime, true);
        }
      }
      lastSeq = judge.judgmentSeq;
    };

    rebuild();
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
    // One reusable patch object so live changes apply without allocating in
    // the frame loop.
    const livePatch: Partial<NoteFieldConfig> = {};

    let raf = 0;
    let base = 0;
    let lastNow = -Infinity;
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
      // Autoplay: hit each note as it reaches the receptor (mines are avoided,
      // like StepMania's autoplay, so they scroll by intact).
      while (cursor < notes.length && notes[cursor].time <= now) {
        const n = notes[cursor];
        cursor++;
        if (n.note.type === TapNoteType.Mine) continue;
        const ev = judge.step(n.track, n.time, false);
        feedback.laneFlash[n.track] = n.time;
        if (ev && ev.tns !== TapNoteScore.None) {
          feedback.laneHit[n.track] = { tns: ev.tns, atSeconds: n.time };
        }
        if (n.tailTime > n.time) {
          held[n.track] = true;
          releases.push({ track: n.track, at: n.tailTime });
        } else {
          judge.step(n.track, n.time, true);
        }
      }
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
      livePatch.scrollMode = liveRef.current.scrollMode;
      livePatch.scrollValue = liveRef.current.scrollValue;
      renderer.applyConfig(livePatch);
      const beat = timing.getBeatFromElapsedTime(now);
      renderer.draw(ctx, judge, now, beat, 0, feedback);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // Primitive deps for the window so a fresh object each render is fine.
  }, [
    noteData,
    timing,
    stepsType,
    noteSkin,
    reverse,
    loopWindow?.startSeconds,
    loopWindow?.endSeconds,
  ]);

  return <canvas ref={ref} className="h-full w-full" />;
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
