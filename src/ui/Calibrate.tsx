import { useEffect, useRef, useState } from 'react';
import { WebAudioClock } from '../audio/clock';
import { makeClickTrack, type Click } from '../audio/synth';
import { Stage, STEP_AC as AC } from './Stage';
import { useSettings } from './SettingsContext';

const BPM = 120;
const BEAT = 60 / BPM; // 0.5s
const DURATION = 40;

/**
 * Offset calibration: play a steady metronome, tap any key on each beat, and
 * measure your mean timing error. The engine's AdjustSync analogue (spec doc 6
 * §6.4). Calibrates with a raw clock (audioOffset = 0), then writes the result.
 */
export function Calibrate({ onBack }: { onBack: () => void }) {
  const { settings, update } = useSettings();
  const clockRef = useRef<WebAudioClock | null>(null);
  const offsetsRef = useRef<number[]>([]);
  const rafRef = useRef(0);
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [measured, setMeasured] = useState<number | null>(null);
  const [, force] = useState(0);

  const stop = () => {
    cancelAnimationFrame(rafRef.current);
    clockRef.current?.stop();
    clockRef.current = null;
    setRunning(false);
  };

  useEffect(() => () => stop(), []);

  const start = async () => {
    stop();
    const clock = new WebAudioClock();
    await clock.resume();
    const clicks: Click[] = [];
    for (let b = 0; b * BEAT < DURATION; b++) clicks.push({ time: b * BEAT, accent: b % 4 === 0 });
    clock.setBuffer(makeClickTrack(clock.ctx, clicks, DURATION + 0.5));
    clock.sync.audioOffsetSeconds = 0; // measure raw
    clock.start(0, 0.3);
    clockRef.current = clock;
    offsetsRef.current = [];
    setCount(0);
    setMeasured(null);
    setRunning(true);

    const loop = () => {
      if (!clockRef.current) return;
      clockRef.current.refresh(); // keep the sync anchor fresh
      force((x) => x + 1);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  // Tap handler.
  useEffect(() => {
    const onTap = (e: KeyboardEvent) => {
      const clock = clockRef.current;
      if (!clock || e.repeat) return;
      clock.refresh();
      const t = clock.songSecondsAtEvent(e.timeStamp);
      if (t < 0.25) return; // skip lead-in
      const nearest = Math.round(t / BEAT) * BEAT;
      const err = t - nearest;
      if (Math.abs(err) > BEAT / 2) return;
      offsetsRef.current.push(err);
      setCount(offsetsRef.current.length);
      e.preventDefault();
    };
    window.addEventListener('keydown', onTap);
    return () => window.removeEventListener('keydown', onTap);
  }, []);

  const apply = () => {
    const arr = [...offsetsRef.current].sort((a, b) => a - b);
    if (arr.length < 6) return;
    const k = Math.floor(arr.length * 0.2); // trim 20% tails
    const trimmed = arr.slice(k, arr.length - k);
    const mean = trimmed.reduce((s, x) => s + x, 0) / trimmed.length;
    const ms = Math.round(-mean * 1000);
    setMeasured(ms);
    update({ audioOffsetMs: ms });
    stop();
  };

  // Visual metronome dot.
  const now = clockRef.current ? clockRef.current.sync.songSecondsAtPerf(performance.now()) : -1;
  const phase = now >= 0 ? now / BEAT - Math.floor(now / BEAT) : 0;
  const flash = now >= 0 && phase < 0.15;

  return (
    <Stage
      label="CALIBRATE"
      footer={
        <button
          onClick={() => {
            stop();
            onBack();
          }}
          className="hover:text-[#ececec]"
        >
          SELECT — BACK TO OPTIONS
        </button>
      }
    >
      <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
        <p className="max-w-[460px] text-[14px] tracking-[0.06em] text-[#ececec]/60">
          Press any key exactly on each metronome beat. After ~16 taps, hit Apply.
        </p>

        <div
          className="h-28 w-28 rounded-full border-4"
          style={{
            borderColor: flash ? AC : 'rgba(255,255,255,0.15)',
            background: flash ? 'rgba(255,77,61,0.3)' : 'transparent',
            transform: `scale(${flash ? 1.1 : 1})`,
          }}
        />

        <div className="text-[40px] font-bold tabular-nums">
          {count} <span className="text-[16px] tracking-[0.1em] text-[#ececec]/50">TAPS</span>
        </div>
        {measured !== null && (
          <div className="text-[14px] tracking-[0.1em]" style={{ color: AC }}>
            APPLIED OFFSET {measured > 0 ? '+' : ''}
            {measured} MS
          </div>
        )}

        <div className="flex gap-3">
          {!running ? (
            <button
              onClick={start}
              className="border px-6 py-2 text-[14px] tracking-[0.1em]"
              style={{ borderColor: AC, background: AC + '1a', color: '#ececec' }}
            >
              ▶ START
            </button>
          ) : (
            <button
              onClick={stop}
              className="border border-white/15 px-6 py-2 text-[14px] tracking-[0.1em] text-[#ececec]/60"
            >
              STOP
            </button>
          )}
          <button
            onClick={apply}
            disabled={count < 6}
            className="border px-6 py-2 text-[14px] font-bold tracking-[0.1em] disabled:opacity-40"
            style={{ borderColor: AC, background: AC, color: '#0b0c0e' }}
          >
            APPLY
          </button>
        </div>

        <p className="text-[12px] tracking-[0.12em] text-[#ececec]/45">
          CURRENT OFFSET {settings.audioOffsetMs > 0 ? '+' : ''}
          {settings.audioOffsetMs} MS
        </p>
      </div>
    </Stage>
  );
}
