/**
 * INPUT TEST — infers a controller's true polling rate from the input the game
 * already sees, through the unified input bus (no special probe).
 *
 * Why it works: a device reporting every period P stamps each report at
 * T0 + k·P, so every `Gamepad.timestamp` we ever see is a multiple of P (offset
 * by a constant) — i.e. `timestamp mod P` clusters at one value. That's a
 * property of each timestamp's *value*, so it holds no matter how slowly we
 * collect them: reading at rAF (or on the event-driven API) is enough, no
 * Nyquist limit and no busy loop. We scan candidate periods and pick the one
 * whose residuals cluster tightest (the fundamental P); rate ≈ 1000 / P.
 *
 * Timestamps come from `subscribeControls` — the exact path gameplay uses — so
 * this measures the shipping pipeline. Mash a bound panel / button to feed it
 * (each press and release is one report time); keyboard is event-timestamped
 * and unquantized, visible in the tap log.
 */
import { useEffect, useState } from 'react';
import { RAW_GAMEPAD_EVENTS, subscribeControls, type ControlEvent } from '../input/inputBus';
import { Stage, STEP_AC as AC } from './Stage';
import { useMenuNav } from './useMenuNav';

const RAW_GAMEPAD_SUPPORTED =
  typeof window !== 'undefined' && RAW_GAMEPAD_EVENTS.some((n) => `on${n}` in window);

const PHASE_BINS = 24;
const MAX_TS = 300; // gamepad timestamps kept for the estimate
const MIN_TS = 12; // need at least this many to bother

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Find the report period P by testing which P makes the timestamps land on
 * multiples of it. For each candidate, `timestamp mod P` is mapped to a phase
 * angle; the circular concentration (0..1) of those angles is high only when P
 * divides the true period, and highest at the fundamental (larger P = less
 * relative jitter). So the argmax over P is the period. conf is that
 * concentration — a fit quality.
 */
function inferPeriod(ts: number[]): { periodMs: number; hz: number; conf: number } {
  if (ts.length < MIN_TS) return { periodMs: 0, hz: 0, conf: 0 };
  let best = { periodMs: 0, hz: 0, conf: 0 };
  for (let p = 0.7; p <= 20; p += 0.05) {
    let sx = 0;
    let sy = 0;
    for (const t of ts) {
      const a = ((t % p) / p) * (2 * Math.PI);
      sx += Math.cos(a);
      sy += Math.sin(a);
    }
    const r = Math.hypot(sx, sy) / ts.length;
    if (r > best.conf) best = { periodMs: p, hz: 1000 / p, conf: r };
  }
  return best;
}

interface Snapshot {
  displayHz: number;
  displayMs: number;
  periodMs: number;
  hz: number;
  conf: number;
  samples: number;
  phase: number[];
}

interface Tap {
  seq: number;
  device: ControlEvent['device'];
  role: ControlEvent['role'];
  t: number;
  dt: number | null;
}

const EMPTY: Snapshot = {
  displayHz: 0,
  displayMs: 0,
  periodMs: 0,
  hz: 0,
  conf: 0,
  samples: 0,
  phase: new Array(PHASE_BINS).fill(0),
};

export function InputTest({ onBack }: { onBack: () => void }) {
  useMenuNav(onBack);
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [taps, setTaps] = useState<Tap[]>([]);
  const [rawEvents, setRawEvents] = useState(0);

  // Live event-driven-API count — the honest "is it firing" signal.
  useEffect(() => {
    const bump = () => setRawEvents((n) => n + 1);
    for (const name of RAW_GAMEPAD_EVENTS) window.addEventListener(name, bump);
    return () => {
      for (const name of RAW_GAMEPAD_EVENTS) window.removeEventListener(name, bump);
    };
  }, []);

  useEffect(() => {
    // Gamepad timestamps collected from the SAME bus gameplay uses. Each event
    // (press or release) carries Gamepad.timestamp (a device report time), so
    // these are the multiples-of-P we infer from.
    const ts: number[] = [];
    let seq = 0;
    let prevT = 0;
    const unsub = subscribeControls((e) => {
      if (e.device === 'gamepad') {
        ts.push(e.timeStampMs);
        if (ts.length > MAX_TS) ts.shift();
      }
      if (!e.pressed || e.repeat) return;
      const dt = prevT ? e.timeStampMs - prevT : null;
      prevT = e.timeStampMs;
      setTaps((prev) =>
        [{ seq: seq++, device: e.device, role: e.role, t: e.timeStampMs, dt }, ...prev].slice(
          0,
          12,
        ),
      );
    });

    // Display refresh (= the game's rAF poll cadence when the flag is off).
    const rafIntervals: number[] = [];
    let lastRaf = 0;
    let running = true;
    const raf = (t: number) => {
      if (!running) return;
      if (lastRaf) {
        rafIntervals.push(t - lastRaf);
        if (rafIntervals.length > 240) rafIntervals.shift();
      }
      lastRaf = t;
      rafHandle = requestAnimationFrame(raf);
    };
    let rafHandle = requestAnimationFrame(raf);

    const flush = window.setInterval(() => {
      const { periodMs, hz, conf } = inferPeriod(ts);
      const phase = new Array<number>(PHASE_BINS).fill(0);
      if (periodMs > 0)
        for (const t of ts)
          phase[Math.min(PHASE_BINS - 1, Math.floor(((t % periodMs) / periodMs) * PHASE_BINS))]++;
      const dMs = median(rafIntervals);
      setSnap({
        displayMs: dMs,
        displayHz: dMs > 0 ? 1000 / dMs : 0,
        periodMs,
        hz,
        conf,
        samples: ts.length,
        phase,
      });
    }, 350);

    return () => {
      running = false;
      unsub();
      cancelAnimationFrame(rafHandle);
      window.clearInterval(flush);
    };
  }, []);

  const num = (n: number, d = 1) => (n > 0 ? n.toFixed(d) : '—');
  const ready = snap.samples >= MIN_TS && snap.conf >= 0.6 && snap.periodMs > 0;
  const peak = Math.max(1, ...snap.phase);

  return (
    <Stage
      label="INPUT TEST"
      footer={
        <button onClick={onBack} className="hover:text-[#ececec]">
          SELECT — BACK
        </button>
      }
    >
      <div className="h-full overflow-y-auto px-[28px] py-8">
        <div className="mx-auto max-w-[860px]">
          <p className="mb-6 border border-l-[3px] border-white/10 border-l-[#ff5d47]/60 px-4 py-2.5 text-[12px] leading-relaxed tracking-[0.03em] text-[#ececec]/55">
            Infers your controller&apos;s true polling rate from the input the game already sees.
            Device reports are stamped at multiples of one period, so we find the period the
            timestamps are all multiples of — no fast probe needed, and it reads from the same input
            bus as gameplay. <b>Mash a bound panel / button</b> (each press &amp; release is one
            report time) to feed the estimate. Keyboard is event-timestamped and unquantized — see
            the tap log.
          </p>

          <div className="mb-6 grid grid-cols-3 gap-3">
            {[
              ['DISPLAY REFRESH', num(snap.displayHz, 0), 'Hz', `${num(snap.displayMs)} ms/frame`],
              [
                'GAME INPUT',
                rawEvents > 0 ? 'EVENT' : num(snap.displayHz, 0),
                rawEvents > 0 ? '' : 'Hz',
                rawEvents > 0 ? 'event-driven · no poll' : 'rAF poll · once per frame',
              ],
              [
                'EVENT-DRIVEN API',
                rawEvents > 0 ? 'ACTIVE' : RAW_GAMEPAD_SUPPORTED ? 'ON' : 'OFF',
                '',
                rawEvents > 0
                  ? `${rawEvents} events`
                  : RAW_GAMEPAD_SUPPORTED
                    ? 'enabled — press a pad'
                    : 'flag off — polling',
              ],
            ].map(([label, big, unit, sub]) => (
              <div key={label} className="border border-white/10 px-4 py-3">
                <div className="text-[10px] tracking-[0.14em] text-[#ececec]/40">{label}</div>
                <div className="mt-1 text-[26px] font-bold leading-none [font-variant-numeric:tabular-nums]">
                  {big}
                  {unit && (
                    <span className="ml-1 text-[13px] font-normal text-[#ececec]/50">{unit}</span>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-[#ececec]/40">{sub}</div>
              </div>
            ))}
          </div>

          {rawEvents === 0 && (
            <p className="mb-6 -mt-3 text-[11px] text-[#ececec]/40">
              Event-driven input is behind a flag: enable{' '}
              <code className="text-[#ececec]/70">
                chrome://flags/#gamepad-raw-input-change-event
              </code>{' '}
              (or the <code className="text-[#ececec]/70">edge://</code> equivalent) and relaunch —
              the app attaches the listeners either way, so it lights up automatically.
            </p>
          )}

          <div className="mb-3 flex items-center gap-4">
            <span className="text-[11px] tracking-[0.2em] text-[#ececec]/40">
              INFERRED CONTROLLER POLL RATE
            </span>
            <span className="h-px flex-1 bg-white/[0.09]" />
          </div>
          <div className="mb-6 border border-white/10 px-4 py-4">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <span className="text-[34px] font-bold leading-none [font-variant-numeric:tabular-nums]">
                {ready ? (
                  <>
                    <span style={{ color: AC }}>≈ {Math.round(snap.hz)}</span>
                    <span className="ml-1 text-[15px] font-normal text-[#ececec]/50">Hz</span>
                  </>
                ) : (
                  <span className="text-[17px] font-normal text-[#ececec]/45">
                    mash a bound panel / button…
                  </span>
                )}
              </span>
              {ready && (
                <span className="text-[13px] text-[#ececec]/55 [font-variant-numeric:tabular-nums]">
                  period {num(snap.periodMs, 2)} ms · fit {Math.round(snap.conf * 100)}% ·{' '}
                  {snap.samples} samples
                </span>
              )}
            </div>
            {/* Phase histogram: timestamps mod the inferred period. A tight spike
                means they're all multiples of it (a clean poll rate). */}
            <div className="mt-4 flex h-16 items-end gap-[3px]">
              {snap.phase.map((c, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-sm"
                  style={{
                    height: `${Math.max(2, (c / peak) * 100)}%`,
                    background: c > 0 ? AC : 'rgba(236,236,236,0.12)',
                    opacity: c > 0 ? 0.4 + 0.6 * (c / peak) : 1,
                  }}
                />
              ))}
            </div>
            <div className="mt-1 text-[10px] text-[#ececec]/35">
              timestamp phase (mod inferred period) — a single tall spike means every timestamp is a
              multiple of that period; a flat spread means no fixed rate (or not enough taps yet)
            </div>
          </div>

          <div className="mb-3 mt-6 flex items-center gap-4">
            <span className="text-[11px] tracking-[0.2em] text-[#ececec]/40">
              TAP LOG (LIVE PIPELINE)
            </span>
            <span className="h-px flex-1 bg-white/[0.09]" />
          </div>
          <div className="border border-white/10">
            <div className="flex border-b border-white/[0.06] px-4 py-2 text-[10px] tracking-[0.14em] text-[#ececec]/35">
              <span className="w-[90px]">DEVICE</span>
              <span className="w-[80px]">ROLE</span>
              <span className="flex-1 text-right">STAMPED (ms)</span>
              <span className="w-[120px] text-right">Δ PREV (ms)</span>
            </div>
            {taps.length === 0 ? (
              <div className="px-4 py-4 text-[12px] text-[#ececec]/45">
                Press panels / keys — each shows the time the bus stamped it (from Gamepad.timestamp
                for pads) and the gap to the previous tap.
              </div>
            ) : (
              taps.map((tap) => (
                <div
                  key={tap.seq}
                  className="flex border-b border-white/[0.04] px-4 py-1.5 text-[13px] [font-variant-numeric:tabular-nums]"
                >
                  <span
                    className="w-[90px]"
                    style={{ color: tap.device === 'gamepad' ? AC : '#ececec' }}
                  >
                    {tap.device}
                  </span>
                  <span className="w-[80px] text-[#ececec]/70">{tap.role}</span>
                  <span className="flex-1 text-right text-[#ececec]/85">{tap.t.toFixed(1)}</span>
                  <span className="w-[120px] text-right text-[#ececec]/60">
                    {tap.dt == null ? '—' : `+${tap.dt.toFixed(1)}`}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </Stage>
  );
}
