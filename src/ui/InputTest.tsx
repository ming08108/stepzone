/**
 * INPUT TEST — infers each input device's true polling rate from its event
 * timestamps, per controller (and the keyboard).
 *
 * Why it works: a device polled every period P timestamps each report at
 * T0 + k·P, so every timestamp is a multiple of P (offset by a constant) —
 * `timestamp mod P` clusters at one value. That's a property of each timestamp's
 * *value*, so it holds no matter how slowly we sample: reading at the game's own
 * rAF cadence is enough, no Nyquist limit and no busy probe. We scan candidate
 * periods and pick the one whose residuals cluster tightest (the fundamental P);
 * rate ≈ 1000 / P.
 *
 * Everything comes from the ONE input bus, so this measures exactly what
 * gameplay judges on: per-pad gamepad samples via subscribeGamepadSamples (the
 * raw per-pad reads the bus's own poll produces — index, id, Gamepad.timestamp),
 * and keyboard timestamps via subscribeControls (KeyboardEvent.timeStamp — a USB
 * keyboard is polled too, so those quantize to its report rate, though OS/event
 * jitter can blur it). The tap log is the same bus, showing the pipeline.
 */
import { useEffect, useState } from 'react';
import {
  RAW_GAMEPAD_EVENTS,
  rawGamepadSupported,
  subscribeControls,
  subscribeGamepadSamples,
  type ControlEvent,
} from '../input/inputBus';
import { Stage, STEP_AC as AC } from './Stage';
import { useMenuNav } from './useMenuNav';

const RAW_GAMEPAD_SUPPORTED = rawGamepadSupported();

const PHASE_BINS = 24;
const MAX_TS = 300; // timestamps kept per device
const MIN_TS = 12; // need at least this many to estimate

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Find the report period P by testing which P makes the timestamps land on
 * multiples of it: `timestamp mod P` mapped to a phase angle has high circular
 * concentration (0..1) only when P divides the true period, and highest at the
 * fundamental (larger P = less relative jitter). Argmax over P is the period;
 * conf is that concentration (fit quality).
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

function phaseHistogram(ts: number[], periodMs: number): number[] {
  const bins = new Array<number>(PHASE_BINS).fill(0);
  if (periodMs > 0)
    for (const t of ts)
      bins[Math.min(PHASE_BINS - 1, Math.floor(((t % periodMs) / periodMs) * PHASE_BINS))]++;
  return bins;
}

interface DeviceView {
  key: string;
  label: string;
  hint: string; // e.g. "gamepad #1" / "keyboard"
  hasTimestamp: boolean;
  samples: number;
  periodMs: number;
  hz: number;
  conf: number;
  phase: number[];
}

function measure(
  key: string,
  label: string,
  hint: string,
  ts: number[],
  hasTs: boolean,
): DeviceView {
  const { periodMs, hz, conf } = inferPeriod(ts);
  return {
    key,
    label,
    hint,
    hasTimestamp: hasTs,
    samples: ts.length,
    periodMs,
    hz,
    conf,
    phase: phaseHistogram(ts, periodMs),
  };
}

interface Snapshot {
  displayHz: number;
  displayMs: number;
  devices: DeviceView[];
}

interface Tap {
  seq: number;
  device: ControlEvent['device'];
  role: ControlEvent['role'];
  t: number;
  dt: number | null;
}

const EMPTY: Snapshot = { displayHz: 0, displayMs: 0, devices: [] };

/** Phase chart: each timestamp folded into one period of the detected rate. */
function PhaseChart({ phase }: { phase: number[] }) {
  const peak = Math.max(1, ...phase);
  return (
    <div className="mt-3">
      <div className="mb-1 text-[9px] tracking-[0.12em] text-[#ececec]/35">
        TIMESTAMP ALIGNMENT (folded into one detected period)
      </div>
      <div className="flex h-14 items-end gap-[3px]">
        {phase.map((c, i) => (
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
      <div className="mt-1 flex justify-between text-[9px] text-[#ececec]/30">
        <span>0</span>
        <span>½ period</span>
        <span>1 period</span>
      </div>
      <div className="mt-1 text-[10px] leading-relaxed text-[#ececec]/55">
        Where each report&apos;s timestamp lands inside one period of the detected rate. One tall
        bar = every report is on the same clock grid (a real, fixed poll rate). A flat spread = no
        single rate, or not enough samples yet.
      </div>
    </div>
  );
}

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
    let running = true;
    const kbTs: number[] = []; // keyboard timestamps, from the unified bus
    const pads = new Map<number, { id: string; hasTs: boolean; ts: number[] }>();
    const lastTs = new Map<number, number>();
    const rafIntervals: number[] = [];
    let lastRaf = 0;
    let seq = 0;
    let prevTap = 0;

    const push = (arr: number[], v: number) => {
      arr.push(v);
      if (arr.length > MAX_TS) arr.shift();
    };

    // Unified bus: keyboard timestamps for its estimate + the tap log.
    const unsub = subscribeControls((e) => {
      if (e.repeat) return;
      if (e.device === 'keyboard') push(kbTs, e.timeStampMs);
      if (!e.pressed) return;
      const dt = prevTap ? e.timeStampMs - prevTap : null;
      prevTap = e.timeStampMs;
      setTaps((prev) =>
        [{ seq: seq++, device: e.device, role: e.role, t: e.timeStampMs, dt }, ...prev].slice(
          0,
          12,
        ),
      );
    });

    // Per-pad samples FROM THE SAME BUS POLL gameplay consumes (no second poll).
    const unsubSamples = subscribeGamepadSamples((snapshot) => {
      for (const p of snapshot) {
        let st = pads.get(p.index);
        if (!st) {
          st = { id: p.id, hasTs: p.timestamp > 0, ts: [] };
          pads.set(p.index, st);
        }
        st.hasTs = st.hasTs || p.timestamp > 0;
        const prev = lastTs.get(p.index);
        if (prev === undefined || p.timestamp > prev) {
          push(st.ts, p.timestamp);
          lastTs.set(p.index, p.timestamp);
        }
      }
    });

    // rAF only measures the display refresh (for the tiles) — no input here.
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
      const devices: DeviceView[] = [];
      if (kbTs.length > 0) devices.push(measure('kb', 'Keyboard', 'keyboard', kbTs.slice(), true));
      for (const [index, st] of pads)
        devices.push(
          measure(`gp${index}`, st.id, `gamepad #${index + 1}`, st.ts.slice(), st.hasTs),
        );
      const dMs = median(rafIntervals);
      setSnap({ displayMs: dMs, displayHz: dMs > 0 ? 1000 / dMs : 0, devices });
    }, 350);

    return () => {
      running = false;
      unsub();
      unsubSamples();
      cancelAnimationFrame(rafHandle);
      window.clearInterval(flush);
    };
  }, []);

  const num = (n: number, d = 1) => (n > 0 ? n.toFixed(d) : '—');

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
            Infers each device&apos;s true polling rate from its event timestamps: a polled device
            stamps reports at multiples of one period, so we find the period the timestamps are all
            multiples of — no fast probe, read from the same input bus gameplay judges on.{' '}
            <b>Mash a panel / key or move a stick</b> on each device to feed it. A USB keyboard is
            polled too, so it&apos;s measured alongside the controllers (its timestamps are
            noisier).
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
                <div className="mt-1 text-[11px] text-[#ececec]/55">{sub}</div>
              </div>
            ))}
          </div>

          {rawEvents === 0 && (
            <p className="mb-6 -mt-3 text-[11px] text-[#ececec]/55">
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
              INFERRED POLL RATE · PER DEVICE
            </span>
            <span className="h-px flex-1 bg-white/[0.09]" />
          </div>
          {snap.devices.length === 0 ? (
            <div className="mb-6 border border-white/10 px-4 py-3 text-[12px] text-[#ececec]/55">
              Nothing measured yet — press a key or a controller button. The browser hides gamepads
              until first input.
            </div>
          ) : (
            snap.devices.map((d) => {
              const ready = d.samples >= MIN_TS && d.conf >= 0.6 && d.periodMs > 0;
              return (
                <div key={d.key} className="mb-4 border border-white/10 px-4 py-3">
                  <div className="flex items-baseline gap-3">
                    <span className="text-[10px] uppercase tracking-[0.14em] text-[#ececec]/35">
                      {d.hint}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[#ececec]/85">
                      {d.label}
                    </span>
                    {!d.hasTimestamp && (
                      <span className="text-[10px] tracking-[0.1em] text-[#ffcf3d]/70">
                        NO TIMESTAMP — CAN&apos;T INFER
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
                    <span className="text-[30px] font-bold leading-none [font-variant-numeric:tabular-nums]">
                      {ready ? (
                        <>
                          <span style={{ color: AC }}>≈ {Math.round(d.hz)}</span>
                          <span className="ml-1 text-[14px] font-normal text-[#ececec]/50">Hz</span>
                        </>
                      ) : (
                        <span className="text-[16px] font-normal text-[#ececec]/45">
                          mash / move to measure…
                        </span>
                      )}
                    </span>
                    {ready && (
                      <span className="text-[13px] text-[#ececec]/55 [font-variant-numeric:tabular-nums]">
                        period {num(d.periodMs, 2)} ms · fit {Math.round(d.conf * 100)}% ·{' '}
                        {d.samples} samples
                      </span>
                    )}
                  </div>
                  <PhaseChart phase={d.phase} />
                </div>
              );
            })
          )}

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
              <div className="px-4 py-4 text-[12px] text-[#ececec]/55">
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
