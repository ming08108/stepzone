/**
 * STEPLINE Player Options — the per-play screen between song select and
 * gameplay: SCROLL TYPE / SPACING / DIFFICULTY / BACKGROUND, with a live preview
 * that renders the real chart (real NoteFieldRenderer + Judge on a silent
 * autoplay clock), then START. Choices persist to localStorage
 * ["stepline.options"]; on START they apply to the shared settings and the
 * chosen difficulty's chart is handed back to play.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { previewEncoded, stopPreview } from '../audio/songPreview';
import { Judge } from '../gameplay/judge';
import { DEFAULT_WINDOWS } from '../gameplay/windows';
import { songBpmRange } from '../io/songFiles';
import { TapNoteScore } from '../notes/noteTypes';
import { columnAnglesFor } from '../render/columns';
import { type Feedback, NoteFieldRenderer } from '../render/noteField';
import { difficultyToString } from '../song/difficulty';
import type { PlayRequest } from './playRequest';
import { useSettings } from './SettingsContext';
import { Stage, STEP_AC as AC } from './Stage';
import { useGamepadKeys } from './useGamepadKeys';

const BG = ['OFF', 'DIM', 'FULL'] as const;
const BG_MODE = ['off', 'dim', 'full'] as const;

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

interface Opts {
  scrollType: 'C' | 'X';
  cmod: number; // constant target BPM
  xmod: number; // BPM multiplier
  bg: number;
}
function loadOpts(): Opts {
  try {
    const o = JSON.parse(localStorage.getItem('stepline.options') || '');
    if (o && typeof o === 'object') {
      return {
        scrollType: o.scrollType === 'X' ? 'X' : 'C',
        cmod: typeof o.cmod === 'number' ? o.cmod : 500,
        xmod: typeof o.xmod === 'number' ? o.xmod : typeof o.speed === 'number' ? o.speed : 2,
        bg: o.bg | 0,
      };
    }
  } catch {
    /* default below */
  }
  return { scrollType: 'C', cmod: 500, xmod: 2, bg: 1 };
}

/**
 * Live chart preview: drives the real NoteFieldRenderer with this chart's actual
 * notes — a Judge on a silent autoplay clock — so you see the true beat map, note
 * skin, and scroll type/spacing before starting. Loops a window of the chart;
 * scroll changes apply live without rebuilding.
 */
function NotePreview({
  song,
  chart,
  scrollMode,
  scrollValue,
  noteSkin,
  reverse,
}: {
  song: PlayRequest['song'];
  chart: PlayRequest['chart'];
  scrollMode: 'C' | 'X' | 'M';
  scrollValue: number;
  noteSkin: 'arcade' | 'itg';
  reverse: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef({ mode: scrollMode, value: scrollValue });
  scrollRef.current = { mode: scrollMode, value: scrollValue };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const timing = chart.getTimingData(song.timing);
    const nd = chart.getNoteData();
    const maxBpm = timing.bpms.reduce((m, b) => Math.max(m, b.bps * 60), 0) || 200;
    const angles = columnAnglesFor(chart.stepsType, nd.numTracks);
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
      judge = new Judge(nd, timing, DEFAULT_WINDOWS, 1);
      renderer = new NoteFieldRenderer(nd.numTracks);
      renderer.setColumnAngles(angles);
      renderer.setStyle(noteSkin);
      renderer.setReverse(reverse);
      renderer.setBgDim(1); // no song background in the preview
      renderer.setMeta({ title: '', subtitle: '', difficulty: '' });
      resize();
      feedback = {
        lastJudgment: null,
        laneFlash: new Array<number>(nd.numTracks).fill(-999),
        laneHit: new Array<Feedback['laneHit'][number]>(nd.numTracks).fill(null),
      };
      held = new Array<boolean>(nd.numTracks).fill(false);
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
      // Autoplay: hit each note as it reaches the receptor.
      while (cursor < notes.length && notes[cursor].time <= now) {
        const n = notes[cursor];
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
        cursor++;
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
      renderer.setScroll(scrollRef.current.mode, scrollRef.current.value, maxBpm);
      const beat = timing.getBeatFromElapsedTime(now);
      renderer.draw(ctx, judge, now, beat, 0, feedback);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [song, chart, noteSkin, reverse]);

  return <canvas ref={ref} className="h-full w-full" />;
}

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
  const [opts, setOpts] = useState<Opts>(loadOpts);
  const [row, setRow] = useState(0);
  useGamepadKeys();

  useEffect(() => {
    localStorage.setItem('stepline.options', JSON.stringify(opts));
  }, [opts]);

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

  const r = songBpmRange(req.song);
  const bpm = r.max > 0 ? Math.round(r.max) : 0;
  const diffName = difficultyToString(chart.difficulty);
  const dcolor = DIFF_COLOR[diffName] ?? '#ececec';

  const go = () => {
    update({
      scrollMode: opts.scrollType,
      scrollValue: opts.scrollType === 'C' ? opts.cmod : opts.xmod,
      bgMode: BG_MODE[opts.bg],
    });
    onStart(chart);
  };

  const adjust = (dir: number) => {
    if (row === 0) setOpts((o) => ({ ...o, scrollType: o.scrollType === 'C' ? 'X' : 'C' }));
    else if (row === 1)
      setOpts((o) =>
        o.scrollType === 'C'
          ? { ...o, cmod: Math.max(100, Math.min(1000, o.cmod + dir * 25)) }
          : { ...o, xmod: Math.max(0.5, Math.min(8, +(o.xmod + dir * 0.25).toFixed(2))) },
      );
    else if (row === 2) setChartIdx((v) => Math.max(0, Math.min(charts.length - 1, v + dir)));
    else setOpts((o) => ({ ...o, bg: (o.bg + dir + 3) % 3 }));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') setRow((v) => (v + 3) % 4);
      else if (e.key === 'ArrowDown') setRow((v) => (v + 1) % 4);
      else if (e.key === 'ArrowLeft') adjust(-1);
      else if (e.key === 'ArrowRight') adjust(1);
      else if (e.key === 'Enter') go();
      else if (e.key === 'Escape' || e.key === 'Shift') onBack();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const rows: Array<{ label: string; value: string; help: string; valueColor?: string }> = [
    {
      label: 'SCROLL TYPE',
      value: opts.scrollType === 'C' ? 'CONSTANT' : 'MULTIPLIER',
      help: "CONSTANT (CMod) locks one scroll speed no matter how the song's tempo changes — steady and predictable (recommended). MULTIPLIER (XMod) scales with the song's BPM, so arrows speed up and slow down with the music.",
    },
    {
      label: 'SPACING',
      value: opts.scrollType === 'C' ? `C${opts.cmod}` : `${opts.xmod.toFixed(2)}×`,
      help:
        opts.scrollType === 'C'
          ? "Constant scroll speed / note spacing, in BPM. Higher = faster and more spread out. Stays fixed through the song's tempo changes."
          : `Multiplier on the song's BPM — higher = faster and more spread out.${bpm ? ` ≈ ${Math.round(bpm * opts.xmod)} BPM on this song.` : ''}`,
    },
    {
      label: 'DIFFICULTY',
      value: `${diffName} ${chart.meter}`,
      valueColor: dcolor,
      help: `Which step chart to play. This song has ${charts.length} difficult${charts.length === 1 ? 'y' : 'ies'} — harder charts add more and faster steps.`,
    },
    {
      label: 'BACKGROUND',
      value: BG[opts.bg],
      help: "The song's background art/video behind the arrows. OFF hides it, DIM darkens it so notes stay readable, FULL shows it brighter.",
    },
  ];

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
        <div className="flex flex-1 flex-col justify-center gap-2 px-8">
          {rows.map((r2, i) => {
            const on = i === row;
            return (
              <div key={r2.label} className="mb-1">
                <div
                  onClick={() => setRow(i)}
                  className="flex h-[54px] cursor-pointer items-center gap-4 border border-l-[3px] px-4"
                  style={{
                    borderColor: on ? AC : 'rgba(255,255,255,.1)',
                    borderLeftColor: on ? AC : 'transparent',
                    background: on ? AC + '14' : 'transparent',
                  }}
                >
                  <span className="flex-1 text-[15px] tracking-[0.14em] text-[#ececec]/85">
                    {r2.label}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setRow(i);
                      adjust(-1);
                    }}
                    style={{ color: on ? AC : 'rgba(236,236,236,.4)' }}
                  >
                    ◀
                  </button>
                  <span
                    className="min-w-[130px] text-center text-[17px] font-bold"
                    style={r2.valueColor ? { color: r2.valueColor } : undefined}
                  >
                    {r2.value}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setRow(i);
                      adjust(1);
                    }}
                    style={{ color: on ? AC : 'rgba(236,236,236,.4)' }}
                  >
                    ▶
                  </button>
                </div>
                <div className="mb-2 mt-1.5 px-1 text-[12px] leading-snug text-[#ececec]/45">
                  {r2.help}
                </div>
              </div>
            );
          })}
          <button
            onClick={go}
            className="mt-4 h-[58px] w-full text-[18px] font-bold tracking-[0.3em]"
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
            <NotePreview
              song={req.song}
              chart={chart}
              scrollMode={opts.scrollType}
              scrollValue={opts.scrollType === 'C' ? opts.cmod : opts.xmod}
              noteSkin={settings.noteSkin}
              reverse={settings.reverse}
            />
          </div>
        </div>
      </div>
    </Stage>
  );
}
