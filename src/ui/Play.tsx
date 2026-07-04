import { useEffect, useRef, useState } from 'react';
import { GameSession } from '../game/session';
import { ShaderBackground } from '../render/shaderBackground';
import { isVideoFile, songBpmRange } from '../io/songFiles';
import { keyToColumn } from '../input/keymap';
import { readGamepad } from '../input/gamepad';
import { difficultyToString } from '../song/difficulty';
import { TapNoteScore } from '../notes/noteTypes';
import { chartKey, recordPlay, type ChartScore } from '../app/scores';
import type { PlayRequest } from './playRequest';
import { useSettings } from './SettingsContext';

type Phase = 'ready' | 'playing' | 'done';

interface Result {
  percent: number;
  grade: string;
  maxCombo: number;
  failed: boolean;
  counts: Record<number, number>;
  best: ChartScore | null;
  isNewRecord: boolean;
  offsets: number[];
}

/** Early/late timing distribution of the just-played taps. */
function OffsetGraph({ offsets }: { offsets: number[] }) {
  if (offsets.length === 0) return null;
  const ms = offsets.map((o) => o * 1000);
  const N = 25;
  const range = 180; // ±180 ms
  const buckets = new Array<number>(N).fill(0);
  for (const m of ms) {
    const idx = Math.round(
      ((Math.max(-range, Math.min(range, m)) + range) / (2 * range)) * (N - 1),
    );
    buckets[idx]++;
  }
  const max = Math.max(1, ...buckets);
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  return (
    <div className="w-[24rem] max-w-full">
      <div className="flex h-16 items-end justify-center gap-[2px]">
        {buckets.map((c, i) => (
          <div
            key={i}
            className={`flex-1 rounded-sm ${i === (N - 1) / 2 ? 'bg-white/40' : 'bg-accent'}`}
            style={{ height: `${Math.max(2, (c / max) * 100)}%`, opacity: 0.35 + 0.65 * (c / max) }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted">
        <span>early</span>
        <span className={mean < -5 ? 'text-[#4b8be6]' : mean > 5 ? 'text-[#ffd94b]' : 'text-ink'}>
          avg {mean >= 0 ? '+' : ''}
          {mean.toFixed(1)} ms {mean < -5 ? '(early)' : mean > 5 ? '(late)' : '(on time)'}
        </span>
        <span>late</span>
      </div>
    </div>
  );
}

const AC = '#ff4d3d';
const DIFF_COLOR: Record<string, string> = {
  Beginner: '#37d5ff',
  Easy: '#ffcf3d',
  Medium: '#ff5c5c',
  Hard: '#59f07f',
  Challenge: '#c86bff',
  Edit: '#c86bff',
};

const JUDGMENT_ROWS: Array<[TapNoteScore, string, string]> = [
  [TapNoteScore.W1, 'FANTASTIC', '#38f0ff'],
  [TapNoteScore.W2, 'EXCELLENT', '#ffd23d'],
  [TapNoteScore.W3, 'GREAT', '#59f07f'],
  [TapNoteScore.W4, 'DECENT', '#c86bff'],
  [TapNoteScore.W5, 'WAY OFF', '#ff9d3d'],
  [TapNoteScore.Miss, 'MISS', '#ff4d3d'],
];

const CTL_BTN =
  'rounded-lg border border-white/15 bg-white/[0.08] px-2.5 py-1.5 text-sm font-semibold text-white/75 hover:bg-white/15 hover:text-white';

export function Play({ req, onExit }: { req: PlayRequest; onExit: () => void }) {
  const { settings } = useSettings();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const bgUrlRef = useRef<string | null>(null);
  const bgMediaRef = useRef<HTMLVideoElement | HTMLImageElement | null>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<ShaderBackground | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [result, setResult] = useState<Result | null>(null);

  const cleanupBg = () => {
    const m = bgMediaRef.current;
    if (m instanceof HTMLVideoElement) {
      m.pause();
      m.removeAttribute('src');
      m.load();
    }
    bgMediaRef.current = null;
    if (bgUrlRef.current) {
      URL.revokeObjectURL(bgUrlRef.current);
      bgUrlRef.current = null;
    }
    fxRef.current?.destroy();
    fxRef.current = null;
  };

  // Keep the latest keybindings available to the (mount-once) key handlers.
  const bindsRef = useRef(settings.keybindings);
  bindsRef.current = settings.keybindings;

  useEffect(() => {
    const onResize = () => {
      const c = canvasRef.current;
      if (c) sessionRef.current?.resize(c.clientWidth, c.clientHeight);
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onResize);
    };
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const col = keyToColumn(e.code, bindsRef.current);
      if (col === undefined) return;
      e.preventDefault();
      sessionRef.current?.press(col, e.timeStamp);
    };
    const up = (e: KeyboardEvent) => {
      const col = keyToColumn(e.code, bindsRef.current);
      if (col === undefined) return;
      sessionRef.current?.release(col, e.timeStamp);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useEffect(
    () => () => {
      sessionRef.current?.stop();
      cleanupBg();
    },
    [],
  );

  // Ready/done overlays: focus the primary button (Enter works) and accept
  // gamepad confirm (activate) / back (exit).
  useEffect(() => {
    if (phase === 'playing') return;
    ctaRef.current?.focus();
    let raf = 0;
    let prevC = false;
    let prevB = false;
    const poll = () => {
      const g = readGamepad();
      if (g.connected) {
        if (g.confirm && !prevC) ctaRef.current?.click();
        if (g.back && !prevB) onExit();
      }
      prevC = g.connected && g.confirm;
      prevB = g.connected && g.back;
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [phase, onExit]);

  const start = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    sessionRef.current?.stop();
    cleanupBg();

    const session = new GameSession(req.song, req.chart, canvas, {
      scrollMode: settings.scrollMode,
      scrollValue: settings.scrollValue,
      musicRate: settings.musicRate,
      audioOffsetMs: settings.audioOffsetMs,
      visualOffsetMs: settings.visualOffsetMs,
      turn: settings.turn,
      reverse: settings.reverse,
      appearance: settings.appearance,
    });
    session.resize(canvas.clientWidth, canvas.clientHeight);
    session.onEnd = (judge) => {
      const counts = { ...judge.tapCounts };
      const { best, isNewRecord } = recordPlay(chartKey(req.song, req.chart), {
        percent: judge.percentDancePoints,
        grade: judge.grade,
        maxCombo: judge.maxCombo,
        counts,
      });
      setResult({
        percent: judge.percentDancePoints,
        grade: judge.grade,
        maxCombo: judge.maxCombo,
        failed: judge.failed,
        counts,
        best,
        isNewRecord,
        offsets: [...session.offsets],
      });
      setPhase('done');
    };
    sessionRef.current = session;

    // WebGPU aurora layer (behind the transparent field). Non-blocking: the game
    // starts immediately and the shader attaches whenever the device is ready
    // (or never, on unsupported/headless GPUs) — it must not stall gameplay.
    if (settings.webgpu && bgCanvasRef.current && !req.backgroundFile) {
      void ShaderBackground.create(bgCanvasRef.current).then((sb) => {
        if (sb && sessionRef.current === session) {
          fxRef.current = sb;
          session.enableFx(sb);
        } else {
          sb?.destroy();
        }
      });
    }

    // Background image / video.
    if (req.backgroundFile) {
      const url = URL.createObjectURL(req.backgroundFile);
      bgUrlRef.current = url;
      if (isVideoFile(req.backgroundFile.name)) {
        const v = document.createElement('video');
        v.src = url;
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        bgMediaRef.current = v;
        session.setBackground(v);
      } else {
        const img = new Image();
        img.src = url;
        bgMediaRef.current = img;
        session.setBackground(img);
      }
    }

    if (import.meta.env.DEV) {
      (window as unknown as { __nfSession?: GameSession }).__nfSession = session;
    }
    setResult(null);
    setPhase('playing');
    await session.start(req.encodedAudio);
  };

  const toggleFullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const title = req.song.title || 'Untitled';
  const diffName = difficultyToString(req.chart.difficulty);
  const dcolor = DIFF_COLOR[diffName] ?? '#ececec';
  const r = songBpmRange(req.song);
  const bpmDisp =
    r.max > 0
      ? Math.round(r.min) === Math.round(r.max)
        ? String(Math.round(r.max))
        : `${Math.round(r.min)}–${Math.round(r.max)}`
      : '';

  return (
    <div
      ref={wrapRef}
      className="fixed inset-0 overflow-hidden bg-[#050506] font-grotesk [font-variant-numeric:tabular-nums]"
    >
      <canvas ref={bgCanvasRef} className="absolute inset-0 block h-full w-full" />
      <canvas ref={canvasRef} className="relative z-[1] block h-full w-full" />

      <div className="absolute bottom-4 left-4 z-[3] flex gap-2">
        <button onClick={toggleFullscreen} title="Fullscreen" className={CTL_BTN}>
          ⛶
        </button>
        <button onClick={onExit} className={CTL_BTN}>
          ← SONGS
        </button>
      </div>

      {phase !== 'playing' && (
        <div
          className="absolute inset-0 z-[2] flex flex-col items-center justify-center gap-3 p-6 text-center text-[#ececec] backdrop-blur-[2px]"
          style={{ background: 'rgba(5,6,8,.82)' }}
        >
          {phase === 'ready' && (
            <>
              <div className="text-[19px] font-bold tracking-[0.22em]">STEPLINE</div>
              <div className="mt-2 text-[40px] font-bold leading-tight">{title}</div>
              <div className="text-[18px] text-[#ececec]/60">
                {req.song.artist || '—'}
                {bpmDisp && ` · BPM ${bpmDisp}`}
              </div>
              <div
                className="mt-1 border px-4 py-1.5 text-[16px] font-bold uppercase tracking-wide"
                style={{ borderColor: dcolor, color: dcolor }}
              >
                {diffName} {req.chart.meter}
              </div>
              <button
                ref={ctaRef}
                onClick={start}
                className="mt-4 text-[16px] tracking-[0.22em] outline-none"
                style={{ color: AC, animation: 'blinkStart 1.4s infinite' }}
              >
                PRESS START (ENTER)
              </button>
              <div className="text-[12px] tracking-[0.14em] text-[#ececec]/45">
                ← ↓ ↑ → &nbsp;OR&nbsp; D F J K
              </div>
            </>
          )}
          {phase === 'done' && result && (
            <>
              <div className="text-[15px] tracking-[0.3em] text-[#ececec]/70">RESULTS</div>
              <div className="text-[64px] font-bold leading-none">
                {(result.percent * 100).toFixed(2)}%
              </div>
              <div
                className="text-[22px] font-bold tracking-[0.1em]"
                style={{ color: result.failed ? AC : '#59f07f' }}
              >
                {result.failed ? 'FAILED' : 'CLEARED'} · {result.grade}
              </div>
              {result.isNewRecord && (
                <div className="text-[14px] font-bold tracking-[0.15em]" style={{ color: AC }}>
                  ★ NEW RECORD
                </div>
              )}
              <div className="mt-2 w-[280px]">
                {JUDGMENT_ROWS.map(([tns, label, color]) => (
                  <div
                    key={tns}
                    className="flex justify-between border-b border-white/[0.06] py-0.5 text-[15px] tracking-[0.1em]"
                  >
                    <span style={{ color }}>{label}</span>
                    <span className="font-bold tabular-nums">{result.counts[tns] ?? 0}</span>
                  </div>
                ))}
                <div className="flex justify-between border-t border-white/20 py-0.5 text-[15px] tracking-[0.1em]">
                  <span className="text-[#ececec]/60">MAX COMBO</span>
                  <span className="font-bold tabular-nums">{result.maxCombo}</span>
                </div>
              </div>
              <OffsetGraph offsets={result.offsets} />
              {result.best && (
                <div className="text-[13px] tracking-[0.1em] text-[#ececec]/50">
                  BEST {(result.best.percent * 100).toFixed(2)}% · {result.best.plays} PLAYS
                </div>
              )}
              <button
                ref={ctaRef}
                onClick={start}
                className="mt-2 text-[15px] tracking-[0.22em] outline-none"
                style={{ color: AC, animation: 'blinkStart 1.4s infinite' }}
              >
                PRESS START TO RETRY
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
