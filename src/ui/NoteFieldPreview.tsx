/**
 * Live note-field preview: drives the real NoteFieldRenderer with real note
 * data — a Judge on a silent autoplay clock — so the user sees the true note
 * skin, scroll type/spacing, direction, and appearance mod before playing.
 * Loops a window of the chart; scroll/appearance changes apply live without
 * rebuilding. Shared by Player Options (the selected chart) and the Settings
 * screen (the bundled demo pattern from demoChart()).
 */
import { useEffect, useRef } from 'react';
import type { Appearance, NoteSkin, ScrollMode } from '../game/playOptions';
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

export function NoteFieldPreview({
  noteData,
  timing,
  stepsType,
  scrollMode,
  scrollValue,
  noteSkin,
  reverse,
  appearance = 'visible',
}: {
  noteData: NoteData;
  timing: TimingData;
  stepsType: string;
  scrollMode: ScrollMode;
  scrollValue: number;
  noteSkin: NoteSkin;
  reverse: boolean;
  appearance?: Appearance;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Live-applied per frame (no rebuild): scroll + appearance.
  const liveRef = useRef({ scrollMode, scrollValue, appearance });
  liveRef.current = { scrollMode, scrollValue, appearance };

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
        appearance: liveRef.current.appearance,
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
      lastSeq = judge.judgmentSeq;
      const first = judge.notes[0]?.time ?? 0;
      const last = judge.notes[judge.notes.length - 1]?.time ?? first;
      windowStart = Math.max(0, first - 1.4);
      windowEnd = Math.max(windowStart + 2, Math.min(windowStart + LOOP, last + 1.2));
    };

    rebuild();
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
    // One reusable patch object so live changes apply without allocating in
    // the frame loop.
    const livePatch: Partial<NoteFieldConfig> = {};

    let raf = 0;
    let base = 0;
    const frame = (t: number) => {
      if (!base) base = t;
      let now = windowStart + (t - base) / 1000;
      if (now >= windowEnd) {
        rebuild();
        base = t;
        now = windowStart;
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
      livePatch.appearance = liveRef.current.appearance;
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
  }, [noteData, timing, stepsType, noteSkin, reverse]);

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
