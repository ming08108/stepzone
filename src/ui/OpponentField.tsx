/**
 * The rival's live playfield during versus — the arcade 2P cab experience.
 * Runs a second GpuNoteField over the RIVAL'S chart (resolved locally by
 * hash: VersusInfo.opponentChart) on the LOCAL synced clock: both machines
 * started on the same instant, so their song position ≈ ours. Their judged
 * notes stream over the data channel as display events (net/versusMatch
 * opponentNotes) and are applied to a mirror Judge — notes pop, lanes flash,
 * misses scroll past, combo/life ride the snap feed. Judging itself never
 * crosses the wire; this is presentation only.
 *
 * Draw-only (no input); mounts only when the rival's exact chart revision
 * exists locally — otherwise Play falls back to the score bar alone.
 */
import { useEffect, useRef } from 'react';
import type { GameSession } from '../game/session';
import { Judge } from '../gameplay/judge';
import { DEFAULT_WINDOWS } from '../gameplay/windows';
import { noteRowToBeat, TapNoteScore } from '../notes/noteTypes';
import { columnAnglesFor } from '../render/columns';
import type { Feedback, NoteFieldConfig } from '../render/fieldConfig';
import { beatTimes, GpuNoteField } from '../render/gpu/gpuNoteField';
import { songMaxBpm } from '../render/scroll';
import { difficultyToString } from '../song/difficulty';
import type { Song } from '../song/song';
import type { VersusInfo } from './playRequest';
import { useSettings } from './SettingsContext';

export function OpponentField({
  session,
  versus,
  song,
}: {
  session: GameSession;
  versus: VersusInfo;
  song: Song;
}) {
  const { settings } = useSettings();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Freeze display settings at mount — they can't change mid-play, and a
  // settings-object identity change must not rebuild a live GPU field.
  const settingsRef = useRef(settings);

  useEffect(() => {
    const canvas = canvasRef.current;
    const chart = versus.opponentChart;
    if (!canvas || !chart) return;
    const view = settingsRef.current;
    let cancelled = false;
    let raf = 0;
    let gpu: GpuNoteField | null = null;
    let ro: ResizeObserver | null = null;

    // A mirror judge over THEIR chart: never stepped locally, only painted
    // with the judgments they stream.
    const nd = chart.getNoteData();
    const timing = chart.getTimingData(song.timing);
    const judge = new Judge(nd, timing, DEFAULT_WINDOWS, versus.musicRate, null);
    const feedback: Feedback = {
      lastJudgment: null,
      laneFlash: new Array<number>(nd.numTracks).fill(-999),
      laneHit: new Array<Feedback['laneHit'][number]>(nd.numTracks).fill(null),
    };
    let end = 0;
    for (const n of judge.notes) end = Math.max(end, n.tailTime);
    const visualOffset = view.visualOffsetMs / 1000;
    let cursor = 0;

    const config: Partial<NoteFieldConfig> = {
      scrollMode: view.scrollMode,
      scrollValue: view.scrollValue,
      songMaxBpm: songMaxBpm(timing.bpms),
      reverse: view.reverse,
      noteSkin: view.noteSkin,
      bgDim: 1,
      columnAngles: columnAnglesFor(chart.stepsType, nd.numTracks),
      meta: {
        title: versus.opponentName,
        subtitle: 'LIVE RIVAL',
        difficulty: `${chart.stepsType}  ·  ${difficultyToString(chart.difficulty).toUpperCase()} ${chart.meter}`,
      },
    };

    const resize = () =>
      gpu?.resize(
        canvas.clientWidth || 320,
        canvas.clientHeight || 640,
        Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
      );

    const frame = () => {
      if (cancelled) return;
      const now = session.songNow;
      // Apply freshly-arrived judgments (append-only feed; we keep the cursor).
      const feed = versus.match.opponentNotes;
      while (cursor < feed.length) {
        const { i, tns } = feed[cursor++];
        const n = judge.notes[i];
        if (!n) continue; // hostile/mismatched index — display feed, just skip
        n.tns = tns;
        // Mirror the judge's own rule: consumed by input unless it was a Miss.
        n.hidden = tns !== TapNoteScore.Miss;
        if (n.isHold && n.hidden) n.holdInitiated = true; // assume they hold it
        if (tns !== TapNoteScore.AvoidMine && tns !== TapNoteScore.Miss) {
          feedback.laneFlash[n.track] = now;
          feedback.laneHit[n.track] = { tns, atSeconds: now, white: false };
        }
        if (tns !== TapNoteScore.AvoidMine) {
          feedback.lastJudgment = { tns, atSeconds: now, white: false };
        }
      }
      // Combo/life ride the coarser snap feed (the HUD reads the judge).
      const snap = versus.match.opponent.snap;
      if (snap) {
        judge.combo = snap.combo;
        judge.life = snap.life;
      }
      const visualNow = now - visualOffset;
      const beat = timing.getBeatFromElapsedTime(visualNow);
      const progress = now <= 0 ? 0 : Math.min(1, now / Math.max(0.001, end));
      gpu?.draw(judge, visualNow, beat, progress, feedback);
      raf = requestAnimationFrame(frame);
    };

    void (async () => {
      gpu = await GpuNoteField.create(canvas, nd.numTracks, config);
      if (cancelled || !gpu) {
        gpu?.destroy();
        gpu = null;
        return; // no WebGPU headroom — the score bar still covers the race
      }
      gpu.setBeatTimes(
        beatTimes((b) => timing.getElapsedTimeFromBeat(b), noteRowToBeat(nd.lastRow())),
      );
      resize();
      gpu.prewarm();
      ro = new ResizeObserver(resize);
      ro.observe(canvas);
      raf = requestAnimationFrame(frame);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      gpu?.destroy();
    };
  }, [session, versus, song]);

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}
