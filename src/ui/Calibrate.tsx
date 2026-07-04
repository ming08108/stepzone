import { useEffect, useRef, useState } from 'react';
import { WebAudioClock } from '../audio/clock';
import { makeClickTrack, type Click } from '../audio/synth';
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
    <div className="mx-auto max-w-[560px] px-6 pb-16 pt-8 text-center">
      <header className="mb-6 flex items-center justify-between">
        <div className="text-xl font-bold">
          notefield <span className="pill">calibrate</span>
        </div>
        <button
          onClick={() => {
            stop();
            onBack();
          }}
          className="rounded-lg border border-line px-4 py-2 text-muted hover:border-accent hover:text-ink"
        >
          ← Options
        </button>
      </header>

      <section className="card">
        <p className="text-muted">
          Press <kbd className="kbd">Space</kbd> (or any key) exactly on each metronome beat. After
          ~16 taps, hit Apply.
        </p>

        <div className="my-8 flex items-center justify-center">
          <div
            className="h-28 w-28 rounded-full border-4 transition-none"
            style={{
              borderColor: flash ? 'var(--color-accent)' : 'rgba(255,255,255,0.15)',
              background: flash ? 'rgba(110,168,254,0.35)' : 'transparent',
              transform: `scale(${flash ? 1.1 : 1})`,
            }}
          />
        </div>

        <div className="text-3xl font-extrabold tabular-nums">{count} taps</div>
        {measured !== null && (
          <div className="mt-2 text-accent">
            Applied audio offset: {measured > 0 ? '+' : ''}
            {measured} ms
          </div>
        )}

        <div className="mt-6 flex justify-center gap-3">
          {!running ? (
            <button className="cta" onClick={start}>
              ▶ Start
            </button>
          ) : (
            <button
              className="rounded-xl border border-line px-6 py-2 text-muted hover:text-ink"
              onClick={stop}
            >
              Stop
            </button>
          )}
          <button
            className="rounded-xl bg-accent px-6 py-2 font-bold text-night hover:brightness-110 disabled:opacity-40"
            onClick={apply}
            disabled={count < 6}
          >
            Apply
          </button>
        </div>

        <p className="mt-4 text-sm text-muted">
          Current audio offset: {settings.audioOffsetMs > 0 ? '+' : ''}
          {settings.audioOffsetMs} ms
        </p>
      </section>
    </div>
  );
}
