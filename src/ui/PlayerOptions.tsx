/**
 * STEPLINE Player Options — the per-play screen between song select and
 * gameplay. DDR-style: every how-you-play-this-song mod lives here, each a ◀▶
 * row with a help line for the highlighted option and a live preview that
 * renders the real chart (the real WebGPU note field + Judge on a silent
 * autoplay clock). The everyday rows (difficulty, scroll type, spacing, music rate) sit
 * on top; turn, scroll direction, note skin, and background fold under an
 * ADVANCED row; the practice loop is its own accent-tinted block at the
 * bottom, with a clickable per-measure song map. Rows
 * read/write the one settings store (useSettings) directly — changes apply
 * live, persist, and feed the preview; START hands the chosen chart (plus the
 * per-play practice section, if any) back to play. System-level settings
 * (sync/offset, display, controls) live on the Options screen instead.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { previewEncoded, previewPositionSeconds, stopPreview } from '../audio/songPreview';
import {
  BG_MODES,
  DEFAULT_PLAY_OPTIONS,
  NOTE_SKINS,
  PRACTICE_LEAD_SECONDS,
  PRACTICE_TAIL_SECONDS,
  SCROLL_MODES,
  TURNS,
  type PracticeSection,
} from '../game/playOptions';
import { songBpmRange } from '../io/songFiles';
import { noteRowToBeat, TapNoteType } from '../notes/noteTypes';
import { difficultyToString } from '../song/difficulty';
import type { TimingData } from '../timing/timingData';
import { bestChartsPerSlot, difficultyColor } from './difficultyUi';
import { NoteFieldPreview } from './NoteFieldPreview';
import type { PlayRequest } from './playRequest';
import { useSettings } from './SettingsContext';
import { Stage, STEP_AC as AC } from './Stage';
import { useGamepadKeys } from './useGamepadKeys';

/** Step to the next/previous entry of a const union array, wrapping. */
function cycle<T>(list: readonly T[], cur: T, dir: number): T {
  return list[(list.indexOf(cur) + dir + list.length) % list.length];
}

/**
 * Playhead over the practice song map: a vertical line at the position the
 * looping audio preview is audibly at, converted through the chart's timing
 * (seconds → beat → measure). Polls previewPositionSeconds() on a rAF loop
 * and moves itself directly — no React re-render at 60 fps. Hidden while
 * nothing is playing (debounce gap, decode failure, no audio).
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
          const measure = timing.getBeatFromElapsedTime(sec) / 4; // 0-based
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

const TYPE_LABEL = { C: 'CONSTANT', X: 'MULTIPLIER', M: 'MAX-BPM' } as const;
const TYPE_HELP = {
  C: 'CONSTANT (CMod) locks one scroll speed no matter how the song’s tempo changes — steady and predictable (recommended).',
  X: 'MULTIPLIER (XMod) scales with the song’s BPM, so arrows speed up and slow down with the music.',
  M: 'MAX-BPM (MMod) reads the speed off the song’s fastest section — XMod feel, CMod-style cap on how fast it ever gets.',
} as const;
const SKIN_LABEL = { arcade: 'DDR A3', itg: 'SIMPLY LOVE' } as const;

export function PlayerOptions({
  req,
  onStart,
  onBack,
}: {
  req: PlayRequest;
  onStart: (chart?: PlayRequest['chart'], practice?: PracticeSection | null) => void;
  onBack: () => void;
}) {
  const { settings, update } = useSettings();
  const [row, setRow] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  // Practice loop selection: 1-based inclusive measures, clamped to the chart.
  const [practice, setPractice] = useState({ on: false, start: 1, end: 8 });
  useGamepadKeys();

  // Charts available for this song, one per difficulty slot, ordered by slot (#8).
  const charts = useMemo(
    () => bestChartsPerSlot(req.song).filter((c): c is PlayRequest['chart'] => c !== null),
    [req.song],
  );
  const [chartIdx, setChartIdx] = useState(() => {
    const i = charts.indexOf(req.chart);
    return i >= 0 ? i : Math.max(0, charts.length >> 1);
  });
  const chart = charts[Math.min(chartIdx, charts.length - 1)] ?? req.chart;

  // The preview's chart data, memoized so the preview effect only rebuilds
  // when the selection actually changes.
  const preview = useMemo(
    () => ({ noteData: chart.getNoteData(), timing: chart.getTimingData(req.song.timing) }),
    [req.song, chart],
  );

  // Per-measure note density for the practice-section song map (mines/fakes
  // skipped — you can't step those).
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

  // Selection clamped to this chart (state survives difficulty switches).
  const mStart = Math.max(1, Math.min(practice.start, measures.count));
  const mEnd = Math.min(Math.max(practice.end, mStart), measures.count);
  const practiceSection: PracticeSection | null = practice.on
    ? { startBeat: (mStart - 1) * 4, endBeat: mEnd * 4 }
    : null;

  const beatTime = (b: number) => preview.timing.getElapsedTimeFromBeat(b);
  const fmtTime = (s: number) => {
    const t = Math.max(0, Math.round(s));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  /** Practice section in chart-seconds (null when practice is off). */
  const sectionSeconds = practiceSection
    ? {
        startSeconds: beatTime(practiceSection.startBeat),
        endSeconds: beatTime(practiceSection.endBeat),
      }
    : null;

  // Loop the song sample while choosing options (#5); stop on leave/START.
  // With a practice section selected, loop that section's audio instead so
  // you hear exactly what you'll be drilling — padded with the same lead/tail
  // as the synced note-field preview (and gameplay's practice pre/post-roll),
  // so audio and field wrap at the same instant.
  useEffect(() => {
    if (req.encodedAudio) {
      let win;
      if (sectionSeconds) {
        const start = Math.max(0, sectionSeconds.startSeconds - PRACTICE_LEAD_SECONDS);
        win = {
          startSeconds: start,
          lengthSeconds: Math.max(0.5, sectionSeconds.endSeconds + PRACTICE_TAIL_SECONDS - start),
        };
      }
      previewEncoded(
        req.song.displayFullTitle || req.song.musicFile,
        req.encodedAudio,
        req.song,
        250,
        win,
        settings.musicRate,
      );
    }
    return () => stopPreview();
  }, [req, sectionSeconds?.startSeconds, sectionSeconds?.endSeconds, settings.musicRate]);
  /** Set the loop endpoints (measures, already clamped by the caller). */
  const setLoop = (start: number, end: number) => setPractice((p) => ({ ...p, start, end }));
  /** Click on the song map: drag whichever loop edge is closer to that measure
   *  (ties break toward the side of the section the click landed on, so a
   *  single-measure loop can still be stretched either way). */
  const moveNearestEdge = (m: number) => {
    const dStart = Math.abs(m - mStart);
    const dEnd = Math.abs(m - mEnd);
    if (dStart < dEnd || (dStart === dEnd && m < mStart)) setLoop(Math.min(m, mEnd), mEnd);
    else setLoop(mStart, Math.max(m, mStart));
  };

  const r = songBpmRange(req.song);
  const bpm = r.max > 0 ? Math.round(r.max) : 0;
  const diffName = difficultyToString(chart.difficulty);
  const dcolor = difficultyColor(diffName);

  const isX = settings.scrollMode === 'X';
  const go = () => onStart(chart, practiceSection);

  type OptionRow = {
    label: string;
    value: string;
    help: string;
    valueColor?: string;
    /** 'section' renders as a collapsible group header instead of a ◀▶ row. */
    kind?: 'section';
    /** Indented child row belonging to the section header above it. */
    sub?: boolean;
    /** Accent-tinted row — the practice block, so it reads as a feature, not a mod. */
    tone?: 'accent';
    /** Extra breathing room above (starts a new visual group). */
    spaceAbove?: boolean;
    adjust: (dir: number) => void;
  };

  const advancedRows: OptionRow[] = [
    {
      label: 'TURN',
      value: settings.turn.toUpperCase(),
      help: 'Remaps which arrow goes to which panel: MIRROR flips the chart, LEFT/RIGHT rotate it, SHUFFLE deals a random (per-chart) remap. Same steps, new pattern.',
      adjust: (dir) => update({ turn: cycle(TURNS, settings.turn, dir) }),
    },
    {
      label: 'SCROLL DIR',
      value: settings.reverse ? 'REVERSE' : 'NORMAL',
      help: 'NORMAL scrolls arrows up to receptors at the top, DDR-style. REVERSE puts the receptors at the bottom and scrolls down (ITG players’ favorite).',
      adjust: () => update({ reverse: !settings.reverse }),
    },
    {
      label: 'NOTE SKIN',
      value: SKIN_LABEL[settings.noteSkin],
      help: 'Arrow artwork: DDR A3 arcade arrows, or Simply Love’s ITG-style quantization colors. Shown live in the preview.',
      adjust: (dir) => update({ noteSkin: cycle(NOTE_SKINS, settings.noteSkin, dir) }),
    },
    {
      label: 'BACKGROUND',
      value: settings.bgMode.toUpperCase(),
      help: 'The song’s background art/video behind the arrows. OFF hides it, DIM darkens it so notes stay readable, FULL shows it brighter.',
      adjust: (dir) => update({ bgMode: cycle(BG_MODES, settings.bgMode, dir) }),
    },
  ];

  // The practice block: top-level (not folded), accent-tinted so it reads as
  // its own feature rather than another mod row.
  const practiceRows: OptionRow[] = [
    {
      label: 'PRACTICE LOOP',
      tone: 'accent',
      spaceAbove: true,
      value: practice.on ? `M${mStart}–M${mEnd}` : 'OFF',
      valueColor: practice.on ? AC : undefined,
      help: 'Loop one section of the song over and over: turn it ON, pick the measures below, then START. Only the looped section is judged — pair with MUSIC RATE to drill it slowly.',
      adjust: () => setPractice((p) => ({ ...p, on: !p.on })),
    },
    ...(practice.on
      ? ([
          {
            label: 'LOOP START',
            tone: 'accent',
            sub: true,
            value: `M${mStart} · ${fmtTime(beatTime((mStart - 1) * 4))}`,
            help: 'First measure of the practice section — every pass begins here after a short lead-in. You can also click the song map below to move the nearest edge.',
            adjust: (dir) => setLoop(Math.max(1, Math.min(mEnd, mStart + dir)), mEnd),
          },
          {
            label: 'LOOP END',
            tone: 'accent',
            sub: true,
            value: `M${mEnd} · ${fmtTime(beatTime(mEnd * 4))}`,
            help: 'Last measure of the practice section (inclusive) — once it plays out, the loop jumps back to LOOP START for another pass.',
            adjust: (dir) =>
              setLoop(mStart, Math.max(mStart, Math.min(measures.count, mEnd + dir))),
          },
        ] satisfies OptionRow[])
      : []),
  ];

  const rows: OptionRow[] = [
    {
      label: 'DIFFICULTY',
      value: `${diffName} ${chart.meter}`,
      valueColor: dcolor,
      help: `Which step chart to play. This song has ${charts.length} difficult${charts.length === 1 ? 'y' : 'ies'} — harder charts add more and faster steps.`,
      adjust: (dir) => setChartIdx((v) => Math.max(0, Math.min(charts.length - 1, v + dir))),
    },
    {
      label: 'SCROLL TYPE',
      value: TYPE_LABEL[settings.scrollMode],
      help: TYPE_HELP[settings.scrollMode],
      adjust: (dir) => {
        const m = cycle(SCROLL_MODES, settings.scrollMode, dir);
        // C and M share BPM-target values; entering/leaving X needs a rebase.
        const stillBpm = (settings.scrollMode !== 'X') === (m !== 'X');
        update({
          scrollMode: m,
          scrollValue: stillBpm ? settings.scrollValue : m === 'X' ? 2 : 550,
        });
      },
    },
    {
      // Indented child of SCROLL TYPE: this is that mode's number.
      label: '↳ SPACING',
      sub: true,
      value: isX
        ? `${settings.scrollValue.toFixed(2)}×`
        : `${settings.scrollMode}${Math.round(settings.scrollValue)}`,
      help: isX
        ? `The number for MULTIPLIER above: arrows scroll at this multiple of the song’s BPM — higher = faster and more spread out.${bpm ? ` ≈ ${Math.round(bpm * settings.scrollValue)} BPM on this song.` : ''}`
        : settings.scrollMode === 'C'
          ? 'The number for CONSTANT above: one locked scroll speed / note spacing, in BPM, through every tempo change. Higher = faster and more spread out.'
          : 'The number for MAX-BPM above: scroll speed at the song’s fastest section, in BPM — slower sections scale down proportionally.',
      adjust: (dir) =>
        update({
          scrollValue: isX
            ? Math.max(0.25, Math.min(8, +(settings.scrollValue + dir * 0.25).toFixed(2)))
            : Math.max(50, Math.min(2000, settings.scrollValue + dir * 25)),
        }),
    },
    {
      label: 'MUSIC RATE',
      value: `${settings.musicRate.toFixed(2)}×`,
      help: 'Playback speed of the song itself — slow it down to practice, speed it up for a challenge. Unlike SPACING, this changes the actual audio (judging scales with it).',
      adjust: (dir) =>
        update({
          musicRate: Math.max(0.5, Math.min(2, +(settings.musicRate + dir * 0.05).toFixed(2))),
        }),
    },
    {
      label: 'ADVANCED',
      kind: 'section',
      // While collapsed, the header shows what's tucked away that isn't at its
      // default — so a hidden mod can't silently surprise you mid-song.
      value: [
        settings.turn !== 'none' ? settings.turn.toUpperCase() : null,
        settings.reverse ? 'REVERSE' : null,
        settings.noteSkin !== DEFAULT_PLAY_OPTIONS.noteSkin ? SKIN_LABEL[settings.noteSkin] : null,
        settings.bgMode !== DEFAULT_PLAY_OPTIONS.bgMode
          ? `BG ${settings.bgMode.toUpperCase()}`
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
      help: advanced
        ? 'Collapse the advanced options back down — everything you set stays applied.'
        : 'More options: turn mods, scroll direction, note skin, and background. Anything set off-default is summarized here.',
      adjust: () => setAdvanced((v) => !v),
    },
    ...(advanced ? advancedRows.map((ar) => ({ ...ar, sub: true })) : []),
    ...practiceRows,
  ];

  // The row list grows/shrinks (ADVANCED, practice), so clamp the cursor.
  const curRow = rows[Math.min(row, rows.length - 1)];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp')
        setRow((v) => (Math.min(v, rows.length - 1) + rows.length - 1) % rows.length);
      else if (e.key === 'ArrowDown')
        setRow((v) => (Math.min(v, rows.length - 1) + 1) % rows.length);
      else if (e.key === 'ArrowLeft') curRow.adjust(-1);
      else if (e.key === 'ArrowRight') curRow.adjust(1);
      else if (e.key === 'Enter') go();
      else if (e.key === 'Escape' || e.key === 'Shift') onBack();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <Stage
      label="PLAYER OPTIONS"
      headerRight={
        <div className="flex items-center gap-3 text-right">
          <div>
            <div className="text-[15px] font-bold">{req.song.displayFullTitle || 'Untitled'}</div>
            <div className="text-[12px] text-[#ececec]/55">
              {req.song.artist}
              {bpm ? ` · BPM ${bpm}` : ''}
            </div>
          </div>
          <div
            className="border px-2 py-1 text-[12px] font-bold uppercase"
            style={{ borderColor: dcolor, color: dcolor }}
          >
            {diffName} {chart.meter}
          </div>
        </div>
      }
      footer={
        <>
          <span>▲▼ OPTION</span>
          <span>◀▶ CHANGE</span>
          <span style={{ color: AC, animation: 'blinkStart 1.4s infinite' }}>START — PLAY</span>
          <button onClick={onBack} className="hover:text-[#ececec]">
            SELECT — BACK TO SONGS
          </button>
        </>
      }
    >
      <div className="mx-auto flex h-full w-full max-w-[1360px]">
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-[6px] px-8 py-4">
          <div className="flex min-h-0 flex-col gap-[6px] overflow-y-auto">
            {rows.map((r2, i) => {
              const on = i === row;
              if (r2.kind === 'section') {
                // Group header: chevron + label + hairline; the whole row is
                // the toggle, with the off-default summary while collapsed.
                const c = advanced || on ? AC : 'rgba(236,236,236,.5)';
                return (
                  <div
                    key={r2.label}
                    ref={on ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                    onClick={() => {
                      setRow(i);
                      r2.adjust(1);
                    }}
                    className="mt-1 flex h-[38px] flex-none cursor-pointer items-center gap-3 border border-l-[3px] px-4"
                    style={{
                      borderColor: on ? AC : 'transparent',
                      borderLeftColor: on ? AC : 'transparent',
                      background: on ? AC + '14' : 'transparent',
                    }}
                  >
                    <span
                      className="inline-block text-[10px] transition-transform duration-150"
                      style={{ color: c, transform: advanced ? 'rotate(90deg)' : 'none' }}
                    >
                      ▶
                    </span>
                    <span className="text-[12px] tracking-[0.22em]" style={{ color: c }}>
                      {r2.label}
                    </span>
                    <span className="h-px min-w-4 flex-1 bg-white/[0.08]" />
                    {!advanced && r2.value && (
                      <span className="max-w-[50%] truncate text-[11px] tracking-[0.1em] text-[#ececec]/40">
                        {r2.value}
                      </span>
                    )}
                    {!advanced && (
                      <span className="text-[11px] tracking-[0.14em] text-[#ececec]/30">
                        {r2.value ? '· ' : ''}SHOW
                      </span>
                    )}
                  </div>
                );
              }
              const accent = r2.tone === 'accent';
              return (
                <div
                  key={r2.label}
                  ref={on ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                  onClick={() => setRow(i)}
                  className={`flex h-[44px] flex-none cursor-pointer items-center gap-4 border border-l-[3px] px-4${r2.sub ? ' ml-4' : ''}${r2.spaceAbove ? ' mt-2' : ''}`}
                  style={{
                    borderColor: on ? AC : accent ? AC + '46' : 'rgba(255,255,255,.1)',
                    borderLeftColor: on ? AC : accent ? AC + '90' : 'transparent',
                    background: on ? AC + '14' : accent ? AC + '0d' : 'transparent',
                  }}
                >
                  <span
                    className="flex-1 truncate text-[13px] tracking-[0.14em] text-[#ececec]/85"
                    style={accent ? { color: AC } : undefined}
                  >
                    {r2.label}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setRow(i);
                      r2.adjust(-1);
                    }}
                    style={{ color: on ? AC : 'rgba(236,236,236,.4)' }}
                  >
                    ◀
                  </button>
                  <span
                    className="min-w-[130px] text-center text-[15px] font-bold"
                    style={r2.valueColor ? { color: r2.valueColor } : undefined}
                  >
                    {r2.value}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setRow(i);
                      r2.adjust(1);
                    }}
                    style={{ color: on ? AC : 'rgba(236,236,236,.4)' }}
                  >
                    ▶
                  </button>
                </div>
              );
            })}
          </div>

          {practice.on && (
            <div className="mt-1 flex-none px-1">
              <div className="mb-1 flex justify-between text-[10px] tracking-[0.18em] text-[#ececec]/40">
                <span>PRACTICE SECTION — CLICK TO MOVE THE NEAREST EDGE</span>
                <span>
                  M{mStart}–M{mEnd} · {fmtTime(beatTime((mStart - 1) * 4))}–
                  {fmtTime(beatTime(mEnd * 4))}
                </span>
              </div>
              <div className="relative flex h-[30px] gap-[1px] border border-white/[0.09] bg-black/25 p-[3px]">
                {measures.density.map((c, i) => {
                  const inSel = i + 1 >= mStart && i + 1 <= mEnd;
                  return (
                    <div
                      key={i}
                      onClick={() => moveNearestEdge(i + 1)}
                      className="flex min-w-0 flex-1 cursor-pointer items-end"
                      title={`Measure ${i + 1}`}
                    >
                      <div
                        className="w-full"
                        style={{
                          height: `${10 + 90 * (c / measures.peak)}%`,
                          background: inSel ? AC : 'rgba(236,236,236,0.22)',
                        }}
                      />
                    </div>
                  );
                })}
                <StripPlayhead timing={preview.timing} measureCount={measures.count} />
              </div>
            </div>
          )}

          <div className="mt-1 min-h-[44px] flex-none px-1 text-[12px] leading-snug text-[#ececec]/45">
            {curRow.help}
          </div>
          <button
            onClick={go}
            className="mt-1 h-[52px] w-full flex-none text-[18px] font-bold tracking-[0.3em]"
            style={{ background: AC, color: '#0b0c0e' }}
          >
            {practice.on ? 'START PRACTICE ▸' : 'START ▸'}
          </button>
        </div>

        <div className="flex w-[600px] flex-none flex-col border-l border-white/[0.09] max-[1024px]:w-[44%]">
          <div className="flex h-[40px] flex-none items-center px-6 text-[11px] tracking-[0.22em] text-[#ececec]/45">
            PREVIEW
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
              loopWindow={sectionSeconds}
              clock={previewPositionSeconds}
              hud
              meta={{
                title: req.song.displayFullTitle || 'Untitled',
                subtitle: req.song.artist,
                difficulty: `${chart.stepsType}  ·  ${diffName.toUpperCase()} ${chart.meter}`,
              }}
              background={settings.bgMode === 'off' ? null : (req.backgroundFile ?? null)}
              bgDim={settings.bgMode === 'full' ? 0.25 : 0.6}
              mediaRate={settings.musicRate}
            />
          </div>
        </div>
      </div>
    </Stage>
  );
}
