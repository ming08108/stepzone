import { useEffect, useRef, useState } from 'react';
import { GameSession } from '../game/session';
import { keyToColumn } from '../input/keymap';
import { difficultyToString } from '../song/difficulty';
import type { PlayRequest } from './playRequest';
import { useSettings } from './SettingsContext';

type Phase = 'ready' | 'playing' | 'done';

interface Result {
  percent: number;
  grade: string;
  maxCombo: number;
  failed: boolean;
}

const CTL_BTN =
  'rounded-lg border border-white/15 bg-white/[0.08] px-2.5 py-1.5 text-sm font-semibold text-white/75 hover:bg-white/15 hover:text-white';

export function Play({ req, onExit }: { req: PlayRequest; onExit: () => void }) {
  const { settings } = useSettings();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [result, setResult] = useState<Result | null>(null);

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

  useEffect(() => () => sessionRef.current?.stop(), []);

  const start = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    sessionRef.current?.stop();

    const session = new GameSession(req.song, req.chart, canvas, {
      scrollMode: settings.scrollMode,
      scrollValue: settings.scrollValue,
      musicRate: settings.musicRate,
      audioOffsetMs: settings.audioOffsetMs,
      visualOffsetMs: settings.visualOffsetMs,
    });
    session.resize(canvas.clientWidth, canvas.clientHeight);
    session.onEnd = (judge) => {
      setResult({
        percent: judge.percentDancePoints,
        grade: judge.grade,
        maxCombo: judge.maxCombo,
        failed: judge.failed,
      });
      setPhase('done');
    };
    sessionRef.current = session;
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
      <canvas ref={canvasRef} className="block h-full w-full" />

      <div className="absolute bottom-4 left-3.5 z-[3] flex gap-2">
        <button onClick={toggleFullscreen} title="Fullscreen" className={CTL_BTN}>
          ⛶
        </button>
        <button onClick={onExit} className={CTL_BTN}>
          ← Menu
        </button>
      </div>

      {phase !== 'playing' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-night/80 p-6 text-center backdrop-blur-sm">
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
              <button className="cta" onClick={start}>
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
              <div className="text-muted">max combo {result.maxCombo}</div>
              <div className="mt-2 flex gap-3">
                <button className="cta" onClick={start}>
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
