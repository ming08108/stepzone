import { useEffect, useRef, useState } from 'react';
import exampleSsc from '../dev/example.ssc?raw';
import { parseSimfile } from '../parse/loader';
import { GameSession } from '../game/session';
import { keyToColumn } from '../input/keymap';

const CANVAS_W = 720;
const CANVAS_H = 760;

type Phase = 'ready' | 'playing' | 'done';

interface Result {
  percent: number;
  grade: string;
  maxCombo: number;
  failed: boolean;
}

export function Play() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [result, setResult] = useState<Result | null>(null);

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

  // Stop the session if the component unmounts.
  useEffect(() => () => sessionRef.current?.stop(), []);

  const start = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    sessionRef.current?.stop();

    const song = parseSimfile(exampleSsc, 'example.ssc');
    const chart = song.charts[0];
    if (!chart) return;

    const session = new GameSession(song, chart, canvas);
    session.resize(CANVAS_W, CANVAS_H);
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

  return (
    <div className="stage">
      <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} />
      {phase !== 'playing' && (
        <div className="overlay">
          {phase === 'ready' && (
            <>
              <h2>Example — dance-single (Hard)</h2>
              <p className="hint">
                Hit each arrow as it reaches the receptors. Keys: <kbd>←</kbd> <kbd>↓</kbd>{' '}
                <kbd>↑</kbd> <kbd>→</kbd> or <kbd>D</kbd> <kbd>F</kbd> <kbd>J</kbd> <kbd>K</kbd>.
              </p>
              <p className="hint muted">
                A metronome plays on each beat (the example has no audio).
              </p>
              <button onClick={start}>▶ Play</button>
            </>
          )}
          {phase === 'done' && result && (
            <>
              <h2>{result.failed ? 'Failed' : 'Cleared'}</h2>
              <div className="bigscore">{(result.percent * 100).toFixed(2)}%</div>
              <div className="hint">
                grade <strong>{result.grade}</strong> · max combo {result.maxCombo}
              </div>
              <button onClick={start}>↻ Play again</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
