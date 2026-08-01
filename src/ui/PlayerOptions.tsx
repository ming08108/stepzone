/**
 * PLAY MODS (design 4a "COMMIT") — the screen between song select and gameplay.
 *
 * What changed from the old Player Options, and why:
 *
 *  · NOTHING HIDDEN. Turn, scroll direction, note skin, background and HUD are
 *    exactly the mods that ruin a run if left on from last session — they used
 *    to sit behind an ADVANCED disclosure. All of them are always visible in a
 *    tile grid, with a coral dot on any that is off default.
 *  · THE NUMBER MEANS SOMETHING. Scroll speed carries a derived readout in
 *    units you can feel — "arrows cross the field in 1.9 s, about 5.7 beats on
 *    screen" — and the three scroll modes are a segmented control, not a
 *    stepper + three help paragraphs.
 *  · THE LADDER CARRIES THROUGH. Difficulty is the same five-slot ladder as
 *    the song-select inspector (same colours), with your grade on each slot —
 *    not a "◀ Challenge 12 ▶" stepper that forgets what song select showed.
 *  · YOU COMMIT INFORMED. The right rail carries your PB, the world best, the
 *    density graph (with the previewed window marked) and the tech counts —
 *    the context song select had and this screen used to drop.
 *  · THE PREVIEW SHOWS THE HARD PART. The biggest element on the screen used
 *    to loop wherever the sample happened to be; "is this speed readable?" is
 *    only answerable at the hardest passage, so the preview targets the NPS
 *    peak by default (TAB switches to the opening).
 *  · THE SONG MAP IS ALWAYS ON. The per-measure density strip used to appear
 *    only after PRACTICE LOOP was already on. It's always visible; clicking a
 *    measure sets the loop.
 *
 * Same selection language as the rest of the app (songSelectUi.focusStyle, the
 * fixed KeyLegend). All the room/versus behaviour (announce, ready, force
 * start, guest rate lock, load handoff) is unchanged.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { previewEncoded, previewPositionSeconds, stopPreview } from '../audio/songPreview';
import {
  BG_MODES,
  DEFAULT_PLAY_OPTIONS,
  HUD_DENSITIES,
  NOTE_SKINS,
  PRACTICE_LEAD_SECONDS,
  PRACTICE_TAIL_SECONDS,
  SCROLL_MODES,
  TURNS,
  type PracticeSection,
} from '../game/playOptions';
import { computeChartStats } from '../analysis/chartStats';
import { chartKey, loadScores } from '../app/scores';
import { songBpmRange } from '../io/songFiles';
import { noteRowToBeat, TapNoteType } from '../notes/noteTypes';
import { SPACING } from '../render/scroll';
import { difficultyToString } from '../song/difficulty';
import type { Steps } from '../song/steps';
import { buildAttractConfig } from '../render/attractConfig';
import type { TimingData } from '../timing/timingData';
import { keyboardRole } from '../input/inputBus';
import { bestChartsPerSlot, DIFF_SLOT_COLORS, difficultySlot } from './difficultyUi';
import { gradeColor } from './hud/PlayHud';
import { KeyLegend } from './KeyLegend';
import { NoteFieldPreview } from './NoteFieldPreview';
import { PartyBar } from './PartyBar';
import type { PlayRequest } from './playRequest';
import { useLeaderboard } from './useLeaderboard';
import { useSettings } from './SettingsContext';
import { useGamepadKeys } from './useGamepadKeys';
import { focusStyle } from './songSelectUi';
import { pickOf } from './versusResolve';
import {
  announceSong,
  clearAnnouncedSong,
  dismissRoomError,
  forceStartRoom,
  hostRoom,
  leaveRoom,
  roomState,
  subscribeRoom,
} from './roomStore';

const AC = '#ff5d47';
const SHORT = ['BEG', 'EASY', 'MED', 'HARD', 'EXPERT'] as const;

/** Step to the next/previous entry of a const union array, wrapping. */
function cycle<T>(list: readonly T[], cur: T, dir: number): T {
  return list[(list.indexOf(cur) + dir + list.length) % list.length];
}

const TYPE_LABEL = { C: 'CONSTANT', X: 'MULTIPLIER', M: 'MAX-BPM' } as const;
const SKIN_LABEL = { arcade: 'DDR A3', itg: 'SIMPLY LOVE' } as const;
const HUD_LABEL = { full: 'FULL', lean: 'LEAN' } as const;

/**
 * Playhead over the song map: a vertical line at the position the looping
 * audio preview is audibly at (seconds → beat → measure), moved directly on a
 * rAF loop — no React re-render at 60 fps.
 */
function StripPlayhead({ timing, measureCount }: { timing: TimingData; measureCount: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = ref.current;
      if (el) {
        const sec = previewPositionSeconds();
        if (sec === null) {
          el.style.opacity = '0';
        } else {
          const measure = timing.getBeatFromElapsedTime(sec) / 4;
          const frac = Math.max(0, Math.min(1, measure / Math.max(1, measureCount)));
          el.style.opacity = '1';
          el.style.left = `${frac * 100}%`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [timing, measureCount]);
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute inset-y-0 w-[2px]"
      style={{
        opacity: 0,
        background: '#fff',
        boxShadow: '0 0 6px rgba(255,255,255,0.9)',
        transition: 'opacity 200ms',
      }}
    />
  );
}

function Label({ children }: { children: string }) {
  return (
    <div className="font-display text-[10px] tracking-[0.24em] text-[#ececec]/35">{children}</div>
  );
}

/** Rows the ▲▼ cursor walks. Mods tiles are rows too — one focus model. */
const ROWS = [
  'diff',
  'speed',
  'scrolltype',
  'rate',
  'turn',
  'scrolldir',
  'noteskin',
  'background',
  'hud',
  'previewspot',
  'practice',
  'loopstart',
  'loopend',
  'multiplayer',
] as const;
type RowId = (typeof ROWS)[number];

function fmtAgo(ms: number): string {
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return `${Math.floor(d / 30)} month${d >= 60 ? 's' : ''} ago`;
}

export function PlayerOptions({
  req,
  onStart,
  onBack,
  onSettings,
}: {
  req: PlayRequest;
  onStart: (chart?: PlayRequest['chart'], practice?: PracticeSection | null) => void;
  onBack: () => void;
  /** Jump to SYSTEM SETTINGS (the segmented header's other side). */
  onSettings?: () => void;
}) {
  const { settings, update } = useSettings();
  const [row, setRow] = useState<RowId>('diff');
  const [previewSpot, setPreviewSpot] = useState<'start' | 'peak'>('peak');
  // Practice loop selection: 1-based inclusive measures, clamped to the chart.
  const [practice, setPractice] = useState({ on: false, start: 1, end: 8 });
  // Gameplay canvas size — the derived speed readout must use the REAL design
  // scale (ds = min(h,w)/720), not the 720 reference, or the seconds are off
  // by exactly ds at every other resolution.
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  useEffect(() => {
    const on = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  useGamepadKeys();

  // Live room (roomStore — global state, survives screen transitions).
  const vs = useSyncExternalStore(subscribeRoom, roomState);
  const versusActive = vs.k !== 'idle';
  const room = vs.k === 'in-room' ? vs.room : null;
  const selfReady = room?.self?.ready ?? false;
  const present = room?.players.filter((p) => !p.left) ?? [];
  const readyCount = present.filter((p) => p.ready).length;
  const hostWaiting =
    !!room?.isHost && selfReady && room.phase === 'lobby' && present.length > readyCount;
  const canForceStart = hostWaiting && readyCount >= 2;
  // Guests play at the room's rate; the host's own rate row IS the room rate.
  const effRate = room && !room.isHost ? room.musicRate : settings.musicRate;

  // The host announces this song (and rate) to the room. Deduped in the store.
  useEffect(() => {
    if (room?.isHost) announceSong(req.song, settings.musicRate, req.entry);
  }, [room, req.song, req.entry, settings.musicRate]);

  /* ── difficulty: the same five-slot ladder as the inspector ───────────── */
  const slots = useMemo(() => bestChartsPerSlot(req.song), [req.song]);
  const [diff, setDiff] = useState(() => {
    const i = slots.indexOf(req.chart);
    return i >= 0 ? i : difficultySlot(difficultyToString(req.chart.difficulty));
  });
  // A room guest gets a NEW req without remounting (App swaps it in place when
  // the host picks the next song) — re-derive the slot or the ladder can
  // highlight a slot the new song doesn't have.
  useEffect(() => {
    const i = slots.indexOf(req.chart);
    setDiff(i >= 0 ? i : difficultySlot(difficultyToString(req.chart.difficulty)));
  }, [req.chart, slots]);
  const chart = slots[diff] ?? req.chart;

  const scores = useMemo(() => loadScores(), []);
  const bestFor = (c: Steps | null) => (c ? (scores[chartKey(req.song, c)] ?? null) : null);
  const best = bestFor(chart);
  // A guest plays at the room's rate — the board must match it, not the local
  // musicRate setting.
  const board = useLeaderboard(req.entry ?? null, diff, effRate);
  const topRow = board !== 'loading' && board !== 'offline' ? (board.rows[0] ?? null) : null;

  // The preview's chart data, memoized so the preview effect only rebuilds
  // when the selection actually changes.
  const preview = useMemo(
    () => ({ noteData: chart.getNoteData(), timing: chart.getTimingData(req.song.timing) }),
    [req.song, chart],
  );

  // Chart stats run the full StepParity solver — debounce behind the cursor
  // (same policy as the song-select inspector) so ◀▶ on the ladder never
  // blocks the main thread mid-browse.
  const [settledPreview, setSettledPreview] = useState(preview);
  useEffect(() => {
    const id = setTimeout(() => setSettledPreview(preview), 130);
    return () => clearTimeout(id);
  }, [preview]);
  const stats = useMemo(() => {
    try {
      return computeChartStats(settledPreview.noteData, settledPreview.timing, chart.stepsType);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledPreview]);

  // The hardest passage — the run of adjacent near-peak measures around the
  // max, clamped to ±8 measures: on a stamina chart every bin is ≥0.8 and an
  // unclamped walk would "preview" the entire song.
  const peakWin = useMemo(() => {
    if (!stats || stats.nps.length === 0) return null;
    let maxI = 0;
    for (let i = 1; i < stats.nps.length; i++) if (stats.nps[i].h > stats.nps[maxI].h) maxI = i;
    let a = maxI;
    let b = maxI;
    while (a > Math.max(0, maxI - 8) && stats.nps[a - 1].h >= 0.8) a--;
    while (b < Math.min(stats.nps.length - 1, maxI + 8) && stats.nps[b + 1].h >= 0.8) b++;
    // At least 8 measures of context so the loop is danceable.
    while (b - a < 7 && (a > 0 || b < stats.nps.length - 1)) {
      if (a > 0) a--;
      if (b - a < 7 && b < stats.nps.length - 1) b++;
    }
    return { a, b, startSeconds: stats.nps[a].t0, endSeconds: stats.nps[b].t1 };
  }, [stats]);

  // The dance background's config — built only when BG is DANCE.
  const danceAttract = useMemo(
    () =>
      settings.bgMode === 'dance'
        ? buildAttractConfig(req.song.title, req.song.timing, chart)
        : null,
    [settings.bgMode, req.song, chart],
  );

  // Per-measure note density for the always-visible song map.
  const measures = useMemo(() => {
    const nd = preview.noteData;
    const count = Math.max(1, Math.ceil(noteRowToBeat(nd.lastRow()) / 4));
    const density = new Array<number>(count).fill(0);
    for (let t = 0; t < nd.numTracks; t++) {
      for (const { row: noteRow, note } of nd.getTrack(t)) {
        if (note.type === TapNoteType.Mine || note.type === TapNoteType.Fake) continue;
        density[Math.min(count - 1, Math.floor(noteRowToBeat(noteRow) / 4))]++;
      }
    }
    return { count, density, peak: Math.max(1, ...density) };
  }, [preview.noteData]);

  const mStart = Math.max(1, Math.min(practice.start, measures.count));
  const mEnd = Math.min(Math.max(practice.end, mStart), measures.count);
  const practiceSection: PracticeSection | null = practice.on
    ? { startBeat: (mStart - 1) * 4, endBeat: mEnd * 4 }
    : null;

  const beatTime = (b: number) => preview.timing.getElapsedTimeFromBeat(b);
  /** The chart slice the preview (field + audio) loops. */
  const previewWindow = practiceSection
    ? {
        startSeconds: beatTime(practiceSection.startBeat),
        endSeconds: beatTime(practiceSection.endBeat),
      }
    : previewSpot === 'peak' && peakWin
      ? { startSeconds: peakWin.startSeconds, endSeconds: peakWin.endSeconds }
      : null;

  // Loop the song sample while choosing options; the window follows the
  // preview spot / practice section so you hear what you see.
  useEffect(() => {
    if (req.encodedAudio) {
      let win;
      if (previewWindow) {
        const start = Math.max(0, previewWindow.startSeconds - PRACTICE_LEAD_SECONDS);
        win = {
          startSeconds: start,
          lengthSeconds: Math.max(0.5, previewWindow.endSeconds + PRACTICE_TAIL_SECONDS - start),
        };
      }
      previewEncoded(
        req.song.displayFullTitle || req.song.musicFile,
        req.encodedAudio,
        req.song,
        250,
        win,
        effRate,
      );
    }
    return () => stopPreview();
  }, [req, previewWindow?.startSeconds, previewWindow?.endSeconds, effRate]);

  const setLoop = (start: number, end: number) =>
    setPractice((p) => ({ ...p, on: true, start, end }));
  /** Click on the song map: drag whichever loop edge is closer (ties toward
   *  the side the click landed on). First click arms an 8-measure loop. */
  const moveNearestEdge = (m: number) => {
    if (!practice.on) {
      setLoop(m, Math.min(measures.count, m + 7));
      return;
    }
    const dStart = Math.abs(m - mStart);
    const dEnd = Math.abs(m - mEnd);
    if (dStart < dEnd || (dStart === dEnd && m < mStart)) setLoop(Math.min(m, mEnd), mEnd);
    else setLoop(mStart, Math.max(m, mStart));
  };

  /* ── the derived speed readout ────────────────────────────────────────── */
  const bpm = Math.round(songBpmRange(req.song).max) || 0;
  // Real gameplay geometry: receptors sit at receptorOffset×ds css px and the
  // scroll rate is SPACING(64) css px/beat UNscaled (gpuNoteField applies the
  // config value directly), so travel must be measured in css px with the true
  // design scale — not on the 720 reference grid.
  const ds = Math.max(0.5, Math.min(viewport.h / 720, viewport.w / 720));
  const travel = viewport.h - (settings.noteSkin === 'arcade' ? 118 : 78) * ds; // css px
  const speed = settings.scrollValue;
  const isX = settings.scrollMode === 'X';
  // C and M are a target BPM (M hits it at the fastest section): px/s =
  // value/60 × SPACING. X is a beat multiplier: px/beat = SPACING × value.
  const secOnScreen = isX
    ? bpm > 0
      ? (travel / (SPACING * speed)) * (60 / bpm)
      : 0
    : (travel * 60) / (SPACING * speed);
  const beatsOnScreen = isX ? travel / (SPACING * speed) : bpm > 0 ? (secOnScreen * bpm) / 60 : 0;
  const speedLabel = isX ? `${speed.toFixed(2)}×` : `${settings.scrollMode}${Math.round(speed)}`;
  const sliderPct = isX ? ((speed - 0.25) / 7.75) * 100 : ((speed - 50) / 1950) * 100;
  const adjustSpeed = (dir: number) =>
    update({
      scrollValue: isX
        ? Math.max(0.25, Math.min(8, +(speed + dir * 0.25).toFixed(2)))
        : Math.max(50, Math.min(2000, speed + dir * 25)),
    });

  /* ── mods tiles (always visible; coral dot = off default) ─────────────── */
  const d = DEFAULT_PLAY_OPTIONS;
  const modTiles: Array<{
    id: RowId;
    label: string;
    value: string;
    off: boolean;
    locked?: boolean;
    adjust: (dir: number) => void;
  }> = [
    {
      id: 'rate',
      label: 'MUSIC RATE',
      value: `${effRate.toFixed(2)}×${room && !room.isHost ? ' · ROOM' : ''}`,
      off: effRate !== 1,
      locked: !!room && !room.isHost,
      adjust: (dir) => {
        if (room && !room.isHost) return;
        update({
          musicRate: Math.max(0.5, Math.min(2, +(settings.musicRate + dir * 0.05).toFixed(2))),
        });
      },
    },
    {
      id: 'turn',
      label: 'TURN',
      value: settings.turn.toUpperCase(),
      off: settings.turn !== d.turn,
      adjust: (dir) => update({ turn: cycle(TURNS, settings.turn, dir) }),
    },
    {
      id: 'scrolldir',
      label: 'SCROLL DIR',
      value: settings.reverse ? 'REVERSE' : 'NORMAL',
      off: settings.reverse !== d.reverse,
      adjust: () => update({ reverse: !settings.reverse }),
    },
    {
      id: 'noteskin',
      label: 'NOTE SKIN',
      value: SKIN_LABEL[settings.noteSkin],
      off: settings.noteSkin !== d.noteSkin,
      adjust: (dir) => update({ noteSkin: cycle(NOTE_SKINS, settings.noteSkin, dir) }),
    },
    {
      id: 'background',
      label: 'BACKGROUND',
      value: settings.bgMode.toUpperCase(),
      off: settings.bgMode !== d.bgMode,
      adjust: (dir) => update({ bgMode: cycle(BG_MODES, settings.bgMode, dir) }),
    },
    {
      id: 'hud',
      label: 'HUD',
      value: HUD_LABEL[settings.hudDensity],
      off: settings.hudDensity !== d.hudDensity,
      adjust: (dir) => update({ hudDensity: cycle(HUD_DENSITIES, settings.hudDensity, dir) }),
    },
  ];

  const resetMods = () => {
    update({
      scrollMode: d.scrollMode,
      scrollValue: d.scrollValue,
      turn: d.turn,
      reverse: d.reverse,
      bgMode: d.bgMode,
      noteSkin: d.noteSkin,
      hudDensity: d.hudDensity,
      ...(room && !room.isHost ? {} : { musicRate: d.musicRate }),
    });
  };

  /* ── actions (versus flow unchanged) ──────────────────────────────────── */
  const go = () => {
    if (versusActive) {
      if (room && !selfReady && room.phase === 'lobby' && room.song) {
        room.ready(pickOf(req.song, chart));
      } else if (canForceStart) {
        forceStartRoom();
      }
      return;
    }
    onStart(chart, practiceSection);
  };

  const back = () => {
    if (room?.isHost) {
      clearAnnouncedSong();
      onBack();
    } else if (versusActive) {
      leaveRoom();
    } else {
      onBack();
    }
  };

  // Browsing the DIFFICULTY row shows live on everyone's roster (until ready).
  useEffect(() => {
    if (room && !selfReady) room.sendPick(pickOf(req.song, chart));
  }, [room, selfReady, req.song, chart]);

  // Everyone ready -> the room asks for the session; hand the chosen chart up.
  const handoffRef = useRef<() => void>(() => {});
  handoffRef.current = () => onStart(chart, null);
  useEffect(() => {
    if (!room) return;
    room.onLoadRequested = () => handoffRef.current();
    return () => {
      room.onLoadRequested = undefined;
    };
  }, [room]);

  /* ── row navigation: ▲▼ option, ◀▶ change, everywhere ────────────────── */
  const visibleRows: RowId[] = ROWS.filter((r) =>
    r === 'loopstart' || r === 'loopend'
      ? practice.on && !versusActive
      : r === 'practice'
        ? !versusActive
        : true,
  );
  // A row can vanish under the cursor (practice toggled off, a room forming) —
  // reseat it, or ◀▶ keeps adjusting an invisible control.
  useEffect(() => {
    if (!visibleRows.includes(row)) setRow('speed');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [practice.on, versusActive]);
  // Practice looping and a synchronized race are incompatible — a loop armed
  // before hosting must not silently drive the preview from behind hidden UI.
  useEffect(() => {
    if (versusActive) setPractice((p) => (p.on ? { ...p, on: false } : p));
  }, [versusActive]);
  const adjustRow = (id: RowId, dir: number) => {
    switch (id) {
      case 'diff': {
        if (selfReady) return; // readied = pick is pinned on the wire
        // Walk to the nearest occupied slot in that direction.
        for (let i = diff + dir; i >= 0 && i <= 4; i += dir) {
          if (slots[i] != null) {
            setDiff(i);
            return;
          }
        }
        return;
      }
      case 'speed':
        adjustSpeed(dir);
        return;
      case 'scrolltype': {
        const m = cycle(SCROLL_MODES, settings.scrollMode, dir);
        const stillBpm = (settings.scrollMode !== 'X') === (m !== 'X');
        update({
          scrollMode: m,
          scrollValue: stillBpm ? settings.scrollValue : m === 'X' ? 2 : 550,
        });
        return;
      }
      case 'previewspot':
        setPreviewSpot((s) => (s === 'peak' ? 'start' : 'peak'));
        return;
      case 'practice':
        setPractice((p) => ({ ...p, on: !p.on }));
        return;
      case 'loopstart':
        if (!practice.on) return; // never re-arm the loop from a hidden row
        setLoop(Math.max(1, Math.min(mEnd, mStart + dir)), mEnd);
        return;
      case 'loopend':
        if (!practice.on) return;
        setLoop(mStart, Math.max(mStart, Math.min(measures.count, mEnd + dir)));
        return;
      case 'multiplayer':
        if (vs.k === 'in-room') leaveRoom();
        else if (vs.k === 'error') dismissRoomError();
        else if (vs.k === 'idle') void hostRoom();
        return;
      default:
        modTiles.find((t) => t.id === id)?.adjust(dir);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const role = keyboardRole(e.code);
      // Tab keeps its native focus traversal; the preview spot is a ◀▶ row.
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        resetMods();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        setRow((cur) => {
          const i = visibleRows.indexOf(cur);
          const at = i < 0 ? 0 : i;
          return visibleRows[(at + dir + visibleRows.length) % visibleRows.length];
        });
      } else if (e.key === 'ArrowLeft') adjustRow(row, -1);
      else if (e.key === 'ArrowRight') adjustRow(row, 1);
      else if (e.key === 'Enter' || role === 'confirm') go();
      else if (e.key === 'Escape' || e.key === 'Shift' || role === 'back') back();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const focus = (id: RowId) => row === id;
  const ring = (id: RowId) =>
    focus(id) ? focusStyle(true) : { borderLeft: '3px solid transparent' };
  const diffName = difficultyToString(chart.difficulty);

  const startLabel =
    vs.k === 'in-room'
      ? canForceStart
        ? 'START NOW ▸'
        : selfReady
          ? 'WAITING FOR PLAYERS…'
          : 'READY ▸'
      : versusActive
        ? 'WAITING…'
        : practice.on
          ? 'START PRACTICE ▸' // the M range already lives on the loop rows
          : 'START ▸';

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-[#0b0c0e] font-grotesk text-[#ececec] [font-variant-numeric:tabular-nums]">
      {/* Header: the SYSTEM SETTINGS / PLAY MODS boundary, named and reachable */}
      <div className="flex h-[64px] flex-none items-center gap-5 border-b border-white/[0.09] bg-[#0e0f12] px-6">
        <span className="font-display text-[20px] font-bold tracking-[0.22em]">STEPZONE</span>
        <div
          className="flex h-[32px]"
          style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.12)' }}
        >
          <button
            onClick={onSettings}
            disabled={!onSettings}
            className="flex cursor-pointer items-center px-4 font-display text-[13px] tracking-[0.1em] text-[#ececec]/55 hover:text-[#ececec] disabled:cursor-default"
          >
            ◂ SYSTEM SETTINGS
          </button>
          <span
            className="flex items-center px-4 font-display text-[13px] font-bold tracking-[0.1em]"
            style={{ background: AC, color: '#0b0c0e' }}
          >
            PLAY MODS
          </span>
        </div>
        <span className="flex-1" />
        <div className="text-right">
          <div className="font-display text-[17px] font-bold">
            {req.song.displayFullTitle || 'Untitled'}
          </div>
          <div className="text-[12px] text-[#ececec]/55">
            {req.song.artist}
            {bpm ? ` · ${bpm} BPM` : ''}
            {stats
              ? ` · ${Math.floor(stats.lengthSeconds / 60)}:${String(Math.floor(stats.lengthSeconds % 60)).padStart(2, '0')}`
              : ''}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ── LEFT: the mods column ─────────────────────────────────────── */}
        <div className="flex w-[520px] flex-none flex-col gap-[13px] overflow-y-auto border-r border-white/[0.09] px-6 py-5">
          {/* Difficulty ladder, grades included */}
          <div style={ring('diff')} className="pl-2 -ml-2">
            <Label>{`DIFFICULTY ◀ ▶${selfReady ? ' · LOCKED' : ''}`}</Label>
            <div className="mt-[7px] flex gap-[5px]">
              {SHORT.map((name, i) => {
                const c = slots[i];
                const on = i === diff;
                const b = bestFor(c);
                return (
                  <button
                    key={name}
                    disabled={!c || selfReady}
                    onClick={() => !selfReady && c && setDiff(i)}
                    className="flex flex-col items-center gap-[3px]"
                    style={{
                      flex: on ? 1.3 : 1,
                      padding: on ? '9px 0 8px' : '7px 0 6px',
                      background: on ? `${DIFF_SLOT_COLORS[i]}29` : 'rgba(255,255,255,.03)',
                      borderTop: `3px solid ${DIFF_SLOT_COLORS[i]}`,
                      boxShadow: on ? `inset 0 0 0 1px ${DIFF_SLOT_COLORS[i]}80` : 'none',
                      opacity: c ? (on ? 1 : 0.55) : 0.22,
                    }}
                  >
                    <span
                      className="font-display leading-none font-bold tabular-nums"
                      style={{ fontSize: on ? 24 : 18 }}
                    >
                      {c ? c.meter : '–'}
                    </span>
                    <span className="text-[9px] tracking-[0.1em] text-[#ececec]/55">{name}</span>
                    <span
                      className="text-[11px] font-bold"
                      style={{ color: b ? gradeColor(b.grade) : 'rgba(236,236,236,.25)' }}
                    >
                      {b ? b.grade : '—'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Scroll speed: the number, in units you can feel */}
          <div className="border border-white/10 px-4 py-[13px]">
            <div style={ring('speed')} className="pl-2 -ml-2">
              <div className="flex items-baseline gap-[10px]">
                <Label>SCROLL SPEED ◀ ▶</Label>
                <span className="flex-1" />
                <span className="font-display text-[28px] leading-none font-bold tabular-nums">
                  {speedLabel}
                </span>
              </div>
              <div className="relative mt-4 h-1 bg-white/[0.12]">
                <div
                  className="absolute top-0 bottom-0 left-0"
                  style={{ width: `${Math.max(0, Math.min(100, sliderPct))}%`, background: AC }}
                />
                <div
                  className="pointer-events-none absolute -top-[6px] h-4 w-4 -ml-2"
                  style={{ left: `${Math.max(0, Math.min(100, sliderPct))}%`, background: AC }}
                />
                {/* The real (invisible) slider: mouse drag/click works. */}
                <input
                  type="range"
                  aria-label="scroll speed"
                  min={isX ? 0.25 : 50}
                  max={isX ? 8 : 2000}
                  step={isX ? 0.25 : 25}
                  value={speed}
                  onChange={(e) => update({ scrollValue: Number(e.target.value) })}
                  className="absolute -top-[8px] -bottom-[8px] left-0 w-full cursor-pointer opacity-0"
                />
              </div>
              <div className="mt-[12px] text-[13px] leading-[1.45] text-[#ececec]/62">
                {secOnScreen > 0 ? (
                  <>
                    Arrows cross the field in{' '}
                    <span className="font-bold text-[#ececec]">{secOnScreen.toFixed(1)} s</span>
                    {beatsOnScreen > 0 && (
                      <>
                        {' '}
                        — about{' '}
                        <span className="font-bold text-[#ececec]">
                          {beatsOnScreen.toFixed(1)} beats
                        </span>{' '}
                        on screen{settings.scrollMode !== 'X' ? ' at the fastest section' : ''}.
                      </>
                    )}
                  </>
                ) : beatsOnScreen > 0 ? (
                  <>
                    About{' '}
                    <span className="font-bold text-[#ececec]">
                      {beatsOnScreen.toFixed(1)} beats
                    </span>{' '}
                    of chart on screen.
                  </>
                ) : (
                  'Pick a speed — the preview shows exactly what you get.'
                )}
              </div>
            </div>
            <div style={ring('scrolltype')} className="mt-[12px] pl-2 -ml-2">
              <div className="flex gap-1">
                {SCROLL_MODES.map((m) => {
                  const on = settings.scrollMode === m;
                  return (
                    <button
                      key={m}
                      onClick={() => {
                        setRow('scrolltype');
                        if (on) return;
                        const stillBpm = (settings.scrollMode !== 'X') === (m !== 'X');
                        update({
                          scrollMode: m,
                          scrollValue: stillBpm ? settings.scrollValue : m === 'X' ? 2 : 550,
                        });
                      }}
                      className="flex h-8 flex-1 items-center justify-center font-display text-[12px] tracking-[0.1em]"
                      style={
                        on
                          ? {
                              background:
                                'linear-gradient(90deg, rgba(255,93,71,.26), rgba(255,93,71,.06))',
                              boxShadow: 'inset 0 0 0 1px rgba(255,93,71,.55)',
                              color: '#fff',
                              fontWeight: 700,
                            }
                          : {
                              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.12)',
                              color: 'rgba(236,236,236,.6)',
                            }
                      }
                    >
                      {TYPE_LABEL[m]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Mods: everything visible, off-default marked */}
          <div className="grid grid-cols-2 gap-2">
            {modTiles.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setRow(t.id);
                  t.adjust(1);
                }}
                className="flex items-center gap-[10px] px-3 py-[9px] text-left"
                style={{
                  // Both states set the same box metrics (3px left bar + inset
                  // ring) so the grid never jitters as the cursor moves.
                  ...(focus(t.id)
                    ? focusStyle(true)
                    : {
                        borderLeft: '3px solid transparent',
                        boxShadow: `inset 0 0 0 1px ${t.off ? 'rgba(255,93,71,.45)' : 'rgba(255,255,255,.10)'}`,
                        background: t.off ? 'rgba(255,93,71,.07)' : 'transparent',
                      }),
                  opacity: t.locked ? 0.6 : 1,
                }}
              >
                <span
                  className="h-[6px] w-[6px] flex-none rounded-full"
                  style={{ background: t.off ? AC : 'rgba(255,255,255,.14)' }}
                />
                <span className="min-w-0 flex-1 truncate text-[11px] tracking-[0.14em] text-[#ececec]/55">
                  {t.label}
                </span>
                <span
                  className="font-display text-[14px] font-bold whitespace-nowrap"
                  style={{ color: t.off ? AC : '#ececec' }}
                >
                  {t.value}
                </span>
              </button>
            ))}
          </div>

          {/* Practice loop + the always-on song map */}
          {!versusActive && (
            <div style={ring('practice')} className="pl-2 -ml-2">
              <div className="flex items-center gap-[10px]">
                <Label>PRACTICE LOOP ◀ ▶</Label>
                <span className="h-px flex-1 bg-white/[0.07]" />
                <button
                  onClick={() => {
                    setRow('practice');
                    setPractice((p) => ({ ...p, on: !p.on }));
                  }}
                  className="flex h-[22px] items-center px-[10px] font-display text-[11px] tracking-[0.12em]"
                  style={
                    practice.on
                      ? { background: AC, color: '#0b0c0e', fontWeight: 700 }
                      : {
                          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.16)',
                          color: 'rgba(236,236,236,.55)',
                        }
                  }
                >
                  {practice.on ? `M${mStart}–M${mEnd}` : 'OFF'}
                </button>
              </div>
              <div className="relative mt-[7px] flex h-[34px] gap-px border border-white/[0.09] bg-black/25 p-[3px]">
                {measures.density.map((c, i) => {
                  const inSel = practice.on && i + 1 >= mStart && i + 1 <= mEnd;
                  const hot = !practice.on && c / measures.peak > 0.85;
                  return (
                    <div
                      key={i}
                      onClick={() => {
                        setRow('practice');
                        moveNearestEdge(i + 1);
                      }}
                      className="flex min-w-0 flex-1 cursor-pointer items-end"
                      title={`Measure ${i + 1}`}
                    >
                      <div
                        className="w-full"
                        style={{
                          height: `${10 + 90 * (c / measures.peak)}%`,
                          background: inSel ? AC : hot ? AC + '88' : 'rgba(236,236,236,0.22)',
                        }}
                      />
                    </div>
                  );
                })}
                <StripPlayhead timing={preview.timing} measureCount={measures.count} />
              </div>
              <div className="mt-[5px] text-[10px] tracking-[0.12em] text-[#ececec]/35">
                CLICK A MEASURE TO SET THE LOOP · {measures.count} MEASURES
                {practice.on && ' · ONLY THE LOOP IS JUDGED'}
              </div>
              {/* The loop edges are ▲▼ rows — they need visible homes, or ◀▶
                  edits the loop blind (the pad's only way to nudge an edge). */}
              {practice.on && (
                <div className="mt-[6px] flex gap-2">
                  {(
                    [
                      ['loopstart', 'LOOP START', mStart, beatTime((mStart - 1) * 4)],
                      ['loopend', 'LOOP END', mEnd, beatTime(mEnd * 4)],
                    ] as const
                  ).map(([id, label, m, sec]) => (
                    <div
                      key={id}
                      style={ring(id)}
                      className="flex flex-1 items-baseline gap-2 px-2 py-[5px]"
                    >
                      <span className="text-[10px] tracking-[0.16em] text-[#ececec]/45">
                        {label} ◀ ▶
                      </span>
                      <span className="flex-1" />
                      <span className="font-display text-[14px] font-bold tabular-nums">M{m}</span>
                      <span className="text-[11px] text-[#ececec]/40 tabular-nums">
                        {Math.floor(sec / 60)}:{String(Math.floor(sec % 60)).padStart(2, '0')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <span className="flex-1" />

          {/* Commit */}
          <div className="flex gap-[10px]">
            <button
              onClick={() => {
                setRow('multiplayer');
                adjustRow('multiplayer', 1);
              }}
              className="flex h-[52px] w-[168px] flex-none items-center justify-center font-display text-[12px] font-bold tracking-[0.12em]"
              style={{
                ...(focus('multiplayer')
                  ? focusStyle(true)
                  : { boxShadow: 'inset 0 0 0 1px rgba(255,93,71,.5)' }),
                color: vs.k === 'in-room' ? '#59f07f' : AC,
              }}
            >
              {vs.k === 'idle'
                ? 'HOST A ROOM ▸'
                : vs.k === 'busy'
                  ? 'CREATING…'
                  : vs.k === 'error'
                    ? 'TRY AGAIN ▸'
                    : 'LEAVE ROOM ✕'}
            </button>
            <button
              onClick={go}
              disabled={
                versusActive && (vs.k !== 'in-room' || !room?.song || (selfReady && !canForceStart))
              }
              className="flex h-[52px] flex-1 items-center justify-center font-display text-[17px] font-bold tracking-[0.18em] disabled:opacity-40"
              style={{ background: AC, color: '#0b0c0e' }}
            >
              {startLabel}
            </button>
          </div>
        </div>

        {/* ── CENTER: the preview, aimed at the part that matters ────────── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[40px] flex-none items-center gap-[10px] border-b border-white/[0.06] px-5">
            <Label>PREVIEW ◀ ▶</Label>
            <span className="flex-1" />
            <div
              className="flex h-[26px]"
              style={
                focus('previewspot')
                  ? { ...focusStyle(true), height: 26 }
                  : { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.12)' }
              }
            >
              {(
                [
                  ['start', 'FROM THE START'],
                  ['peak', 'HARDEST SECTION'],
                ] as const
              ).map(([spot, label]) => {
                const on = !practiceSection && previewSpot === spot;
                return (
                  <button
                    key={spot}
                    onClick={() => {
                      setRow('previewspot');
                      setPreviewSpot(spot);
                    }}
                    className="flex items-center px-3 font-display text-[11px] tracking-[0.1em]"
                    style={
                      on
                        ? { background: AC, color: '#0b0c0e', fontWeight: 700 }
                        : { color: 'rgba(236,236,236,.55)' }
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {practiceSection && (
              <span className="font-display text-[11px] tracking-[0.1em]" style={{ color: AC }}>
                LOOPING M{mStart}–M{mEnd}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1">
            <NoteFieldPreview
              noteData={preview.noteData}
              timing={preview.timing}
              stepsType={chart.stepsType}
              scrollMode={settings.scrollMode}
              scrollValue={settings.scrollValue}
              noteSkin={settings.noteSkin}
              reverse={settings.reverse}
              loopWindow={previewWindow}
              clock={previewPositionSeconds}
              hud
              meta={{
                title: req.song.displayFullTitle || 'Untitled',
                subtitle: req.song.artist,
                difficulty: `${chart.stepsType}  ·  ${diffName.toUpperCase()} ${chart.meter}`,
              }}
              background={
                settings.bgMode === 'off' || settings.bgMode === 'dance'
                  ? null
                  : (req.backgroundFile ?? null)
              }
              bgDim={settings.bgMode === 'full' || settings.bgMode === 'dance' ? 0.25 : 0.6}
              mediaRate={effRate}
              attract={danceAttract}
            />
          </div>
        </div>

        {/* ── RIGHT: what you're attempting ──────────────────────────────── */}
        <div className="flex w-[320px] flex-none flex-col gap-4 overflow-y-auto border-l border-white/[0.09] bg-[#0e0f12] px-[18px] py-5">
          <div>
            <Label>WHAT YOU'RE ATTEMPTING</Label>
            <div className="mt-[10px] grid grid-cols-2 gap-px bg-white/[0.07]">
              <div className="bg-[#0e0f12] px-3 py-[9px]">
                <div className="text-[10px] tracking-[0.18em] text-[#ececec]/35">YOUR BEST</div>
                <div
                  className="font-display text-[21px] font-bold tabular-nums"
                  style={{ color: best ? '#59f07f' : 'rgba(236,236,236,.3)' }}
                >
                  {best ? `${(best.percent * 100).toFixed(2)}%` : '—'}{' '}
                  {best && <span className="text-[14px]">{best.grade}</span>}
                </div>
              </div>
              <div className="bg-[#0e0f12] px-3 py-[9px]">
                <div className="text-[10px] tracking-[0.18em] text-[#ececec]/35">WORLD</div>
                <div className="truncate font-display text-[21px] font-bold text-[#ffcf3d] tabular-nums">
                  {topRow ? `${(topRow.percent * 100).toFixed(2)}%` : '—'}
                </div>
              </div>
            </div>
            {best && (
              <div className="mt-2 text-[12px] text-[#ececec]/45">
                {best.plays} play{best.plays === 1 ? '' : 's'} · last played {fmtAgo(best.updated)}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-baseline gap-[10px]">
              <Label>DENSITY</Label>
              <span className="h-px flex-1 bg-white/[0.07]" />
              {stats && (
                <span className="text-[11px] text-[#ececec]/55">
                  {stats.peakNps.toFixed(1)} peak
                </span>
              )}
            </div>
            {stats && stats.nps.length > 0 ? (
              <>
                <div className="relative mt-2 h-[48px] w-full overflow-hidden bg-[#141c22]">
                  <svg
                    className="absolute inset-0 h-full w-full"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                  >
                    <defs>
                      <linearGradient id="nps-playmods" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="#8200a1" />
                        <stop offset="1" stopColor="#00adc0" />
                      </linearGradient>
                    </defs>
                    <path
                      d={(() => {
                        const bins = stats.nps;
                        const t0 = bins[0].t0;
                        const span = Math.max(0.001, bins[bins.length - 1].t1 - t0);
                        const x = (t: number) => ((t - t0) / span) * 100;
                        let path = `M 0 100`;
                        for (const b of bins) {
                          const y = 100 - b.h * 100;
                          path += ` L ${x(b.t0).toFixed(2)} ${y.toFixed(2)} L ${x(b.t1).toFixed(2)} ${y.toFixed(2)}`;
                        }
                        return path + ` L 100 100 Z`;
                      })()}
                      fill="url(#nps-playmods)"
                    />
                  </svg>
                  {previewWindow &&
                    (() => {
                      // Same axis as the SVG path: bins start at the first
                      // NOTE-bearing measure, not song second 0.
                      const t0 = stats.nps[0].t0;
                      const span = Math.max(0.001, stats.nps[stats.nps.length - 1].t1 - t0);
                      const x = (t: number) => Math.max(0, Math.min(100, ((t - t0) / span) * 100));
                      return (
                        <div
                          className="absolute inset-y-0"
                          style={{
                            left: `${x(previewWindow.startSeconds)}%`,
                            right: `${100 - x(previewWindow.endSeconds)}%`,
                            boxShadow: `inset 0 0 0 2px ${AC}`,
                          }}
                        />
                      );
                    })()}
                </div>
                {previewWindow && (
                  <div className="mt-[6px] text-[11px] tracking-[0.1em]" style={{ color: AC }}>
                    ▣ {practiceSection ? 'PREVIEWING YOUR LOOP' : 'PREVIEWING THE PEAK'}
                  </div>
                )}
              </>
            ) : (
              <div className="mt-2 flex h-[48px] items-center justify-center bg-[#141c22] text-[10px] tracking-[0.22em] text-[#ececec]/30">
                NO CHART DATA
              </div>
            )}
          </div>

          {stats && (
            <div>
              <Label>TECH</Label>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
                {stats.tech &&
                  (
                    [
                      [stats.tech.crossovers, 'Crossovers'],
                      [stats.tech.footswitches, 'Footswitch'],
                      [stats.tech.sideswitches, 'Sideswitch'],
                      [stats.tech.jacks, 'Jacks'],
                      [stats.tech.brackets, 'Brackets'],
                    ] as const
                  ).map(([n, label]) => (
                    <div key={label} className="flex gap-[7px]">
                      <span className="w-[34px] text-right font-bold tabular-nums">{n}</span>
                      <span className="text-[#ececec]/50">{label}</span>
                    </div>
                  ))}
              </div>
              <div className="mt-[10px] text-[12px] leading-[1.5] text-[#ececec]/45">
                {stats.steps} steps · {stats.jumps} jumps · {stats.holds} holds · {stats.mines}{' '}
                mines · {stats.hands} hands
              </div>
            </div>
          )}

          <span className="flex-1" />
        </div>
      </div>

      {/* The same party bar as song select — the roster never moves, and it
          carries the ONE situation line (no duplicate hints in the rail). */}
      <PartyBar
        status={
          room?.phase === 'lobby'
            ? selfReady
              ? canForceStart
                ? 'Waiting for players — or press START to begin now.'
                : 'Waiting for everyone to ready up…'
              : present.length < 2
                ? 'Waiting for players — share the code or link.'
                : room.isHost
                  ? 'READY locks your pick and starts the countdown.'
                  : 'Pick a difficulty, then READY.'
            : undefined
        }
      />

      <KeyLegend
        actions={{
          updown: 'OPTION',
          leftright: 'CHANGE',
          select: room?.isHost
            ? 'BACK (ROOM STAYS)'
            : versusActive
              ? 'LEAVE ROOM'
              : 'BACK TO SONGS',
          start:
            vs.k === 'in-room'
              ? canForceStart
                ? 'BEGIN NOW'
                : selfReady
                  ? 'WAITING…'
                  : 'READY'
              : vs.k === 'busy' || vs.k === 'error'
                ? 'WAITING…'
                : 'PLAY',
          fav: null,
        }}
        extras={[{ key: 'R', act: 'RESET MODS' }]}
      />
    </div>
  );
}
