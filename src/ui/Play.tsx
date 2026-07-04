import { useEffect, useRef, useState } from 'react';
import exampleSsc from '../dev/example.ssc?raw';
import { parseSimfile } from '../parse/loader';
import { GameSession } from '../game/session';
import { keyToColumn } from '../input/keymap';

type Phase = 'ready' | 'playing' | 'done';

interface Result {
  percent: number;
  grade: string;
  maxCombo: number;
  failed: boolean;
}

export function Play({ onInspect }: { onInspect: () => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [result, setResult] = useState<Result | null>(null);

  // Keep the canvas backing store matched to the (full-screen) element.
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

  // Route keyboard to the active session, on the event's own timestamp.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const col = keyToColumn(e.code);
      if (col === undefined) return;
      e.preventDefault();
      sessionRef.current?.press(col, e.timeStamp);
    };
    const up = (e: KeyboardEvent) => {
      const col = keyToColumn(e.code);
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

    const song = parseSimfile(exampleSsc, 'example.ssc');
    const chart = song.charts[0];
    if (!chart) return;

    const session = new GameSession(song, chart, canvas);
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
    await session.start();
  };

  const toggleFullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  return (
    <div className="playwrap" ref={wrapRef}>
      <canvas ref={canvasRef} className="playcanvas" />

      <div className="playctl">
        <button onClick={toggleFullscreen} title="Fullscreen">
          ⛶
        </button>
        <button onClick={onInspect}>Inspect</button>
      </div>

      {phase !== 'playing' && (
        <div className="overlay">
          {phase === 'ready' && (
            <>
              <div className="logo">notefield</div>
              <h2>Example — dance-single (Hard)</h2>
              <p className="hint">
                Hit each arrow as it reaches the receptors.
                <br />
                <kbd>←</kbd> <kbd>↓</kbd> <kbd>↑</kbd> <kbd>→</kbd> &nbsp;or&nbsp; <kbd>D</kbd>{' '}
                <kbd>F</kbd> <kbd>J</kbd> <kbd>K</kbd>
              </p>
              <button className="cta" onClick={start}>
                ▶ Play
              </button>
              <p className="hint muted">
                A metronome plays on each beat (the example has no audio).
              </p>
            </>
          )}
          {phase === 'done' && result && (
            <>
              <h2>{result.failed ? 'FAILED' : 'CLEARED'}</h2>
              <div className="bigscore">{(result.percent * 100).toFixed(2)}%</div>
              <div className="gradebadge">{result.grade}</div>
              <div className="hint">max combo {result.maxCombo}</div>
              <button className="cta" onClick={start}>
                ↻ Play again
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
