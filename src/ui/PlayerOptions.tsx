/**
 * STEPLINE Player Options — the per-play screen between song select and
 * gameplay: SPEED MOD / ARROW SPACING / BACKGROUND with a live scrolling note
 * preview, then START. Options persist to localStorage["stepline.options"].
 * Applies the chosen speed to the shared settings (X-mod) on START.
 */
import { useEffect, useRef, useState } from 'react';
import { songBpmRange } from '../io/songFiles';
import { difficultyToString } from '../song/difficulty';
import type { PlayRequest } from './playRequest';
import { useSettings } from './SettingsContext';
import { Stage, STEP_AC as AC } from './Stage';
import { useGamepadKeys } from './useGamepadKeys';

const SPACING = [
  { key: 'TIGHT', mult: 0.75 },
  { key: 'NORMAL', mult: 1 },
  { key: 'WIDE', mult: 1.3 },
];
const BG = ['OFF', 'DIM', 'FULL'];
const DIFF_COLOR: Record<string, string> = {
  Beginner: '#37d5ff',
  Easy: '#ffcf3d',
  Medium: '#ff5c5c',
  Hard: '#59f07f',
  Challenge: '#c86bff',
  Edit: '#c86bff',
};

interface Opts {
  speed: number;
  spacing: number;
  bg: number;
}
function loadOpts(): Opts {
  try {
    const o = JSON.parse(localStorage.getItem('stepline.options') || '');
    if (o && typeof o.speed === 'number')
      return { speed: o.speed, spacing: o.spacing | 0, bg: o.bg | 0 };
  } catch {
    /* default below */
  }
  return { speed: 2.25, spacing: 1, bg: 1 };
}

/** Small looping preview: notes scrolling up to receptors at the chosen speed. */
function Preview({ mult }: { mult: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    };
    resize();
    const ANG = [-Math.PI / 2, Math.PI, 0, Math.PI / 2];
    const COL = ['#ff4455', '#3d7bff'];
    // A simple repeating pattern of (lane, beat) notes.
    const pattern = [
      [0, 0],
      [2, 1],
      [1, 2],
      [3, 2.5],
      [0, 3],
      [2, 3.5],
      [1, 4],
      [3, 5],
    ] as const;
    let raf = 0;
    let start = 0;
    const arrow = (x: number, y: number, s: number, ang: number, fill: string | null) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(0, -0.9 * s);
      ctx.lineTo(0.9 * s, 0);
      ctx.lineTo(0.45 * s, 0);
      ctx.lineTo(0.45 * s, 0.9 * s);
      ctx.lineTo(0, 0.45 * s);
      ctx.lineTo(-0.45 * s, 0.9 * s);
      ctx.lineTo(-0.45 * s, 0);
      ctx.lineTo(-0.9 * s, 0);
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = '#0a0b0d';
        ctx.stroke();
        ctx.scale(0.72, 0.72);
        ctx.beginPath();
        ctx.moveTo(0, -0.9 * s);
        ctx.lineTo(0.9 * s, 0);
        ctx.lineTo(0.45 * s, 0);
        ctx.lineTo(0.45 * s, 0.9 * s);
        ctx.lineTo(0, 0.45 * s);
        ctx.lineTo(-0.45 * s, 0.9 * s);
        ctx.lineTo(-0.45 * s, 0);
        ctx.lineTo(-0.9 * s, 0);
        ctx.closePath();
        ctx.lineWidth = 3 / 0.72;
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.stroke();
      } else {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(236,236,236,0.4)';
        ctx.stroke();
      }
      ctx.restore();
    };
    const frame = (t: number) => {
      if (!start) start = t;
      const beat = ((t - start) / 1000) * 2; // 120bpm-ish
      const w = canvas.width;
      const h = canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const fieldW = 4 * 72 * dpr;
      const left = (w - fieldW) / 2 + 36 * dpr;
      const recY = 60 * dpr;
      const s = 26 * dpr;
      const pxPerBeat = 90 * dpr * mult;
      const laneX = (l: number) => left + l * 72 * dpr;
      for (let l = 0; l < 4; l++) arrow(laneX(l), recY, s, ANG[l], null);
      for (const [lane, b] of pattern) {
        const nb = b + Math.ceil((beat - b) / 6) * 6; // loop every 6 beats
        const y = recY + (nb - beat) * pxPerBeat;
        if (y > recY - s && y < h + s) arrow(laneX(lane), y, s, ANG[lane], COL[Math.round(b) % 2]);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [mult]);
  return <canvas ref={ref} className="h-full w-full" />;
}

export function PlayerOptions({
  req,
  onStart,
  onBack,
}: {
  req: PlayRequest;
  onStart: () => void;
  onBack: () => void;
}) {
  const { update } = useSettings();
  const [opts, setOpts] = useState<Opts>(loadOpts);
  const [row, setRow] = useState(0);
  useGamepadKeys();

  useEffect(() => {
    localStorage.setItem('stepline.options', JSON.stringify(opts));
  }, [opts]);

  const mult = opts.speed * SPACING[opts.spacing].mult;
  const r = songBpmRange(req.song);
  const bpm = r.max > 0 ? Math.round(r.max) : 0;
  const diffName = difficultyToString(req.chart.difficulty);
  const dcolor = DIFF_COLOR[diffName] ?? '#ececec';

  const go = () => {
    update({ scrollMode: 'X', scrollValue: mult });
    onStart();
  };

  const adjust = (dir: number) => {
    setOpts((o) => {
      if (row === 0)
        return { ...o, speed: Math.max(0.5, Math.min(3.5, +(o.speed + dir * 0.25).toFixed(2))) };
      if (row === 1) return { ...o, spacing: (o.spacing + dir + 3) % 3 };
      return { ...o, bg: (o.bg + dir + 3) % 3 };
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') setRow((v) => (v + 2) % 3);
      else if (e.key === 'ArrowDown') setRow((v) => (v + 1) % 3);
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

  const rows = [
    { label: 'SPEED MOD', value: `${opts.speed.toFixed(2)}×` },
    { label: 'ARROW SPACING', value: SPACING[opts.spacing].key },
    { label: 'BACKGROUND', value: BG[opts.bg] },
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
            {diffName} {req.chart.meter}
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
      <div className="flex h-full">
        <div className="flex flex-1 flex-col justify-center gap-2 px-8">
          {rows.map((r2, i) => {
            const on = i === row;
            return (
              <div
                key={r2.label}
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
                <span className="min-w-[130px] text-center text-[17px] font-bold">{r2.value}</span>
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
            );
          })}
          <div className="mt-1 text-[12px] tracking-[0.1em] text-[#ececec]/40">
            EFFECTIVE SCROLL ≈ {bpm ? Math.round(bpm * mult) : '—'} BPM
          </div>
          <button
            onClick={go}
            className="mt-4 h-[58px] w-full text-[18px] font-bold tracking-[0.3em]"
            style={{ background: AC, color: '#0b0c0e' }}
          >
            START ▸
          </button>
        </div>

        <div className="flex w-[420px] flex-none flex-col border-l border-white/[0.09]">
          <div className="flex h-[40px] flex-none items-center px-6 text-[11px] tracking-[0.22em] text-[#ececec]/45">
            PREVIEW
          </div>
          <div className="min-h-0 flex-1">
            <Preview mult={mult} />
          </div>
        </div>
      </div>
    </Stage>
  );
}
