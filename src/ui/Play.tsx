import { useEffect, useRef, useState } from 'react';
import { GameSession } from '../game/session';
import { ShaderBackground } from '../render/shaderBackground';
import { isVideoFile } from '../io/songFiles';
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

const JUDGMENT_ROWS: Array<[TapNoteScore, string]> = [
  [TapNoteScore.W1, 'Marvelous'],
  [TapNoteScore.W2, 'Perfect'],
  [TapNoteScore.W3, 'Great'],
  [TapNoteScore.W4, 'Good'],
  [TapNoteScore.W5, 'Way Off'],
  [TapNoteScore.Miss, 'Miss'],
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
  const diff = `${req.chart.stepsType} · ${difficultyToString(req.chart.difficulty)} ${req.chart.meter}`;

  return (
    <div ref={wrapRef} className="fixed inset-0 overflow-hidden bg-night">
      <canvas ref={bgCanvasRef} className="absolute inset-0 block h-full w-full" />
      <canvas ref={canvasRef} className="relative z-[1] block h-full w-full" />

      <div className="absolute bottom-4 left-3.5 z-[3] flex gap-2">
        <button onClick={toggleFullscreen} title="Fullscreen" className={CTL_BTN}>
          ⛶
        </button>
        <button onClick={onExit} className={CTL_BTN}>
          ← Menu
        </button>
      </div>

      {phase !== 'playing' && (
        <div className="absolute inset-0 z-[2] flex flex-col items-center justify-center gap-4 bg-night/80 p-6 text-center backdrop-blur-sm">
          {phase === 'ready' && (
            <>
              <div className="text-2xl font-extrabold tracking-tight text-accent">notefield</div>
              <h2 className="m-0 text-3xl tracking-wide">{title}</h2>
              <p className="m-0 text-muted">{diff}</p>
              <p className="m-0 max-w-[30rem] text-ink">
                <kbd className="kbd">←</kbd> <kbd className="kbd">↓</kbd>{' '}
                <kbd className="kbd">↑</kbd> <kbd className="kbd">→</kbd> &nbsp;or&nbsp;{' '}
                <kbd className="kbd">D</kbd> <kbd className="kbd">F</kbd>{' '}
                <kbd className="kbd">J</kbd> <kbd className="kbd">K</kbd>
              </p>
              <button ref={ctaRef} className="cta" onClick={start}>
                ▶ Play
              </button>
            </>
          )}
          {phase === 'done' && result && (
            <>
              <h2 className="m-0 text-2xl tracking-wide">{result.failed ? 'FAILED' : 'CLEARED'}</h2>
              <div className="text-5xl font-extrabold tabular-nums">
                {(result.percent * 100).toFixed(2)}%
              </div>
              <div className="text-[3.5rem] font-black leading-none text-[#ffd94b]">
                {result.grade}
              </div>
              {result.isNewRecord && (
                <div className="text-lg font-bold text-accent">★ NEW RECORD</div>
              )}
              <div className="grid grid-cols-2 gap-x-8 gap-y-0.5 text-sm">
                {JUDGMENT_ROWS.map(([tns, label]) => (
                  <div key={tns} className="flex justify-between gap-6">
                    <span className="text-muted">{label}</span>
                    <span className="tabular-nums">{result.counts[tns] ?? 0}</span>
                  </div>
                ))}
              </div>
              <div className="text-sm text-muted">
                max combo {result.maxCombo}
                {result.best
                  ? ` · best ${(result.best.percent * 100).toFixed(2)}% · ${result.best.plays} plays`
                  : ''}
              </div>
              <OffsetGraph offsets={result.offsets} />
              <div className="mt-2 flex gap-3">
                <button ref={ctaRef} className="cta" onClick={start}>
                  ↻ Play again
                </button>
                <button className={CTL_BTN} onClick={onExit}>
                  ← Menu
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
