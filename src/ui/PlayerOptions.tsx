/**
 * STEPLINE Player Options — the per-play screen between song select and
 * gameplay. DDR-style: every how-you-play-this-song mod lives here (scroll
 * type/spacing, difficulty, turn, scroll direction, appearance, note skin,
 * music rate, background), each a ◀▶ row with a help line for the highlighted
 * option and a live preview that renders the real chart (real
 * NoteFieldRenderer + Judge on a silent autoplay clock). Rows read/write the
 * one settings store (useSettings) directly — changes apply live, persist,
 * and feed the preview; START just hands the chosen chart back to play.
 * System-level settings (sync/offset, display, controls) live on the Options
 * screen instead.
 */
import { useEffect, useMemo, useState } from 'react';
import { previewEncoded, stopPreview } from '../audio/songPreview';
import { APPEARANCES, BG_MODES, NOTE_SKINS, SCROLL_MODES, TURNS } from '../game/playOptions';
import { songBpmRange } from '../io/songFiles';
import { difficultyToString } from '../song/difficulty';
import { NoteFieldPreview } from './NoteFieldPreview';
import type { PlayRequest } from './playRequest';
import { useSettings } from './SettingsContext';
import { Stage, STEP_AC as AC } from './Stage';
import { useGamepadKeys } from './useGamepadKeys';

function slotOf(name: string): number {
  const i = ['Beginner', 'Easy', 'Medium', 'Hard', 'Challenge'].indexOf(name);
  return i >= 0 ? i : 4; // Edit → Expert
}
const DIFF_COLOR: Record<string, string> = {
  Beginner: '#37d5ff',
  Easy: '#ffcf3d',
  Medium: '#ff5c5c',
  Hard: '#59f07f',
  Challenge: '#c86bff',
  Edit: '#c86bff',
};

/** Step to the next/previous entry of a const union array, wrapping. */
function cycle<T>(list: readonly T[], cur: T, dir: number): T {
  return list[(list.indexOf(cur) + dir + list.length) % list.length];
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
  onStart: (chart?: PlayRequest['chart']) => void;
  onBack: () => void;
}) {
  const { settings, update } = useSettings();
  const [row, setRow] = useState(0);
  useGamepadKeys();

  // Loop the song sample while choosing options (#5); stop on leave/START.
  useEffect(() => {
    if (req.encodedAudio)
      previewEncoded(req.song.title || req.song.musicFile, req.encodedAudio, req.song);
    return () => stopPreview();
  }, [req]);

  // Charts available for this song, one per difficulty slot, ordered by slot (#8).
  const charts = useMemo(() => {
    const singles = req.song.charts.filter((c) => c.stepsType === 'dance-single');
    const use = singles.length ? singles : req.song.charts;
    const bySlot = new Map<number, PlayRequest['chart']>();
    for (const c of use) {
      const s = slotOf(difficultyToString(c.difficulty));
      const ex = bySlot.get(s);
      if (!ex || c.meter > ex.meter) bySlot.set(s, c);
    }
    return [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  }, [req.song]);
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

  const r = songBpmRange(req.song);
  const bpm = r.max > 0 ? Math.round(r.max) : 0;
  const diffName = difficultyToString(chart.difficulty);
  const dcolor = DIFF_COLOR[diffName] ?? '#ececec';

  const isX = settings.scrollMode === 'X';
  const go = () => onStart(chart);

  const rows: Array<{
    label: string;
    value: string;
    help: string;
    valueColor?: string;
    adjust: (dir: number) => void;
  }> = [
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
      label: 'SPACING',
      value: isX
        ? `${settings.scrollValue.toFixed(2)}×`
        : `${settings.scrollMode}${Math.round(settings.scrollValue)}`,
      help: isX
        ? `Multiplier on the song’s BPM — higher = faster and more spread out.${bpm ? ` ≈ ${Math.round(bpm * settings.scrollValue)} BPM on this song.` : ''}`
        : settings.scrollMode === 'C'
          ? 'Constant scroll speed / note spacing, in BPM. Higher = faster and more spread out. Stays fixed through the song’s tempo changes.'
          : 'Scroll speed at the song’s fastest section, in BPM — slower sections scale down proportionally.',
      adjust: (dir) =>
        update({
          scrollValue: isX
            ? Math.max(0.25, Math.min(8, +(settings.scrollValue + dir * 0.25).toFixed(2)))
            : Math.max(50, Math.min(2000, settings.scrollValue + dir * 25)),
        }),
    },
    {
      label: 'DIFFICULTY',
      value: `${diffName} ${chart.meter}`,
      valueColor: dcolor,
      help: `Which step chart to play. This song has ${charts.length} difficult${charts.length === 1 ? 'y' : 'ies'} — harder charts add more and faster steps.`,
      adjust: (dir) => setChartIdx((v) => Math.max(0, Math.min(charts.length - 1, v + dir))),
    },
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
      label: 'APPEARANCE',
      value: settings.appearance.toUpperCase(),
      help: 'HIDDEN fades arrows out before they reach the receptors (read ahead, from memory); SUDDEN reveals them late (pure reaction). VISIBLE is the normal game.',
      adjust: (dir) => update({ appearance: cycle(APPEARANCES, settings.appearance, dir) }),
    },
    {
      label: 'NOTE SKIN',
      value: SKIN_LABEL[settings.noteSkin],
      help: 'Arrow artwork: DDR A3 arcade arrows, or Simply Love’s ITG-style quantization colors. Shown live in the preview.',
      adjust: (dir) => update({ noteSkin: cycle(NOTE_SKINS, settings.noteSkin, dir) }),
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
      label: 'BACKGROUND',
      value: settings.bgMode.toUpperCase(),
      help: 'The song’s background art/video behind the arrows. OFF hides it, DIM darkens it so notes stay readable, FULL shows it brighter.',
      adjust: (dir) => update({ bgMode: cycle(BG_MODES, settings.bgMode, dir) }),
    },
  ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') setRow((v) => (v + rows.length - 1) % rows.length);
      else if (e.key === 'ArrowDown') setRow((v) => (v + 1) % rows.length);
      else if (e.key === 'ArrowLeft') rows[row].adjust(-1);
      else if (e.key === 'ArrowRight') rows[row].adjust(1);
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
            <div className="text-[15px] font-bold">{req.song.title || 'Untitled'}</div>
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
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-[6px] px-8">
          {rows.map((r2, i) => {
            const on = i === row;
            return (
              <div
                key={r2.label}
                onClick={() => setRow(i)}
                className="flex h-[44px] flex-none cursor-pointer items-center gap-4 border border-l-[3px] px-4"
                style={{
                  borderColor: on ? AC : 'rgba(255,255,255,.1)',
                  borderLeftColor: on ? AC : 'transparent',
                  background: on ? AC + '14' : 'transparent',
                }}
              >
                <span className="flex-1 truncate text-[13px] tracking-[0.14em] text-[#ececec]/85">
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
          <div className="mt-1 min-h-[44px] px-1 text-[12px] leading-snug text-[#ececec]/45">
            {rows[row].help}
          </div>
          <button
            onClick={go}
            className="mt-1 h-[52px] w-full flex-none text-[18px] font-bold tracking-[0.3em]"
            style={{ background: AC, color: '#0b0c0e' }}
          >
            START ▸
          </button>
        </div>

        <div className="flex w-[600px] flex-none flex-col border-l border-white/[0.09]">
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
              appearance={settings.appearance}
            />
          </div>
        </div>
      </div>
    </Stage>
  );
}
