/**
 * INPUT TEST — a diagnostic that measures input timing quantization on this
 * device, so you can see how coarse your controller's timing really is (and
 * that the ~250Hz poll + Gamepad.timestamp path actually helps).
 *
 * It measures four things live:
 *  - display refresh (rAF interval) — the ceiling an rAF-based poll would hit;
 *  - our sample-loop rate — confirms we poll finer than the refresh;
 *  - each pad's update interval (from Gamepad.timestamp changes) — the device's
 *    real quantization, with a histogram;
 *  - a tap log fed by the actual input bus — every press with its device, the
 *    time it was stamped at, and the gap to the previous tap.
 *
 * The measurement loop reads navigator.getGamepads() directly (a diagnostic
 * should observe the platform, not our abstraction); the tap log subscribes to
 * the real bus so it reflects the shipping pipeline.
 */
import { useEffect, useState } from 'react';
import { subscribeControls, type ControlEvent } from '../input/inputBus';
import { Stage, STEP_AC as AC } from './Stage';
import { useMenuNav } from './useMenuNav';

const RAW_GAMEPAD_SUPPORTED =
  typeof window !== 'undefined' && 'GamepadRawInputChangeEvent' in window;

/** Interval buckets (ms upper bounds) for the update-rate histogram. */
const BUCKETS = [1, 2, 4, 6, 9, 13, 17, 25, 40, Infinity];
const BUCKET_LABELS = ['<1', '1–2', '2–4', '4–6', '6–9', '9–13', '13–17', '17–25', '25–40', '40+'];

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const RING = 240; // samples kept per stat

interface PadStat {
  index: number;
  id: string;
  hasTimestamp: boolean;
  intervals: number[]; // between distinct Gamepad.timestamp values
  hist: number[]; // counts per BUCKET
}

interface Snapshot {
  displayHz: number;
  displayMs: number;
  pollHz: number;
  pads: Array<{
    index: number;
    id: string;
    hasTimestamp: boolean;
    samples: number;
    medMs: number;
    minMs: number;
    maxMs: number;
    hz: number;
    hist: number[];
  }>;
}

interface Tap {
  seq: number;
  device: ControlEvent['device'];
  role: ControlEvent['role'];
  t: number;
  dt: number | null;
}

const EMPTY: Snapshot = { displayHz: 0, displayMs: 0, pollHz: 0, pads: [] };

export function InputTest({ onBack }: { onBack: () => void }) {
  useMenuNav(onBack);
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [taps, setTaps] = useState<Tap[]>([]);

  useEffect(() => {
    let cancelled = false;
    const padStats = new Map<number, PadStat>();
    const lastTs = new Map<number, number>();
    const rafIntervals: number[] = [];
    let lastRaf = 0;
    let pollCount = 0;
    let pollWindowStart = performance.now();
    let pollHz = 0;

    const push = (arr: number[], v: number) => {
      arr.push(v);
      if (arr.length > RING) arr.shift();
    };

    // High-rate sampler: read every pad, record the gap between distinct
    // Gamepad.timestamp values (the device's actual update quantization).
    const sample = () => {
      if (cancelled) return;
      pollCount++;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const gp of pads) {
        if (!gp) continue;
        let st = padStats.get(gp.index);
        if (!st) {
          st = {
            index: gp.index,
            id: gp.id || 'Gamepad',
            hasTimestamp: gp.timestamp > 0,
            intervals: [],
            hist: new Array(BUCKETS.length).fill(0),
          };
          padStats.set(gp.index, st);
        }
        st.hasTimestamp = st.hasTimestamp || gp.timestamp > 0;
        const prev = lastTs.get(gp.index);
        if (prev !== undefined && gp.timestamp > prev) {
          const dt = gp.timestamp - prev;
          push(st.intervals, dt);
          st.hist[BUCKETS.findIndex((b) => dt < b)]++;
        }
        lastTs.set(gp.index, gp.timestamp);
      }
      timer = window.setTimeout(sample, 1); // as fast as the clamp allows
    };
    let timer = window.setTimeout(sample, 1);

    // Display refresh, for contrast (the rAF-poll ceiling).
    const raf = (t: number) => {
      if (cancelled) return;
      if (lastRaf) push(rafIntervals, t - lastRaf);
      lastRaf = t;
      rafHandle = requestAnimationFrame(raf);
    };
    let rafHandle = requestAnimationFrame(raf);

    // Flush accumulated stats to React a few times a second (not per sample).
    const flush = window.setInterval(() => {
      if (cancelled) return;
      const now = performance.now();
      const elapsed = now - pollWindowStart;
      if (elapsed > 250) {
        pollHz = (pollCount * 1000) / elapsed;
        pollCount = 0;
        pollWindowStart = now;
      }
      const dMs = median(rafIntervals);
      setSnap({
        displayMs: dMs,
        displayHz: dMs > 0 ? 1000 / dMs : 0,
        pollHz,
        pads: [...padStats.values()].map((st) => {
          const med = median(st.intervals);
          return {
            index: st.index,
            id: st.id,
            hasTimestamp: st.hasTimestamp,
            samples: st.intervals.length,
            medMs: med,
            minMs: st.intervals.length ? Math.min(...st.intervals) : 0,
            maxMs: st.intervals.length ? Math.max(...st.intervals) : 0,
            hz: med > 0 ? 1000 / med : 0,
            hist: st.hist,
          };
        }),
      });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      cancelAnimationFrame(rafHandle);
      window.clearInterval(flush);
    };
  }, []);

  // Tap log from the real input bus — reflects the shipping pipeline (including
  // the Gamepad.timestamp stamping). Only presses; keep the last dozen.
  useEffect(() => {
    let seq = 0;
    let prevT = 0;
    return subscribeControls((e) => {
      if (!e.pressed || e.repeat) return;
      const dt = prevT ? e.timeStampMs - prevT : null;
      prevT = e.timeStampMs;
      const tap: Tap = { seq: seq++, device: e.device, role: e.role, t: e.timeStampMs, dt };
      setTaps((prev) => [tap, ...prev].slice(0, 12));
    });
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
            Measures input timing granularity on this device. Move an analog stick or mash a panel
            to generate updates — the update interval is your controller&apos;s real quantization.
            Keyboard is event-timestamped (effectively unquantized); a dance pad is limited by its
            USB report rate.
          </p>

          {/* Timing sources */}
          <div className="mb-6 grid grid-cols-3 gap-3">
            {[
              ['DISPLAY REFRESH', num(snap.displayHz, 0), 'Hz', `${num(snap.displayMs)} ms/frame`],
              ['INPUT POLL', num(snap.pollHz, 0), 'Hz', 'our sampler'],
              [
                'EVENT-DRIVEN API',
                RAW_GAMEPAD_SUPPORTED ? 'YES' : 'NO',
                '',
                RAW_GAMEPAD_SUPPORTED ? 'rawgamepadinputchange' : 'poll fallback',
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

          {/* Per-pad report rate + histogram */}
          <div className="mb-3 flex items-center gap-4">
            <span className="text-[11px] tracking-[0.2em] text-[#ececec]/40">
              CONTROLLER UPDATE RATE
            </span>
            <span className="h-px flex-1 bg-white/[0.09]" />
          </div>
          {snap.pads.length === 0 ? (
            <div className="mb-6 border border-white/10 px-4 py-3 text-[12px] text-[#ececec]/55">
              No gamepad seen yet — plug one in and press a button (the browser hides pads until
              first input). Keyboard-encoder dance pads report as keyboard keys; test those in the
              tap log below.
            </div>
          ) : (
            snap.pads.map((p) => {
              const peak = Math.max(1, ...p.hist);
              return (
                <div key={p.index} className="mb-4 border border-white/10 px-4 py-3">
                  <div className="flex items-baseline gap-3">
                    <span className="text-[#ececec]/35">#{p.index + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[#ececec]/85">
                      {p.id}
                    </span>
                    {!p.hasTimestamp && (
                      <span className="text-[10px] tracking-[0.1em] text-[#ffcf3d]/70">
                        NO TIMESTAMP — POLL-TIME FALLBACK
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[13px] [font-variant-numeric:tabular-nums]">
                    <span>
                      <span className="text-[#ececec]/40">rate </span>
                      <b style={{ color: AC }}>{num(p.hz, 0)}</b>
                      <span className="text-[#ececec]/40"> Hz</span>
                    </span>
                    <span>
                      <span className="text-[#ececec]/40">interval </span>
                      {num(p.medMs)} ms
                      <span className="text-[#ececec]/40">
                        {' '}
                        ({num(p.minMs)}–{num(p.maxMs)})
                      </span>
                    </span>
                    <span className="text-[#ececec]/40">{p.samples} samples</span>
                  </div>
                  <div className="mt-3 flex h-16 items-end gap-1">
                    {p.hist.map((c, i) => (
                      <div key={i} className="flex flex-1 flex-col items-center gap-1">
                        <div
                          className="w-full rounded-sm"
                          style={{
                            height: `${Math.max(2, (c / peak) * 100)}%`,
                            background: c > 0 ? AC : 'rgba(236,236,236,0.12)',
                            opacity: c > 0 ? 0.4 + 0.6 * (c / peak) : 1,
                          }}
                        />
                        <span className="text-[9px] text-[#ececec]/35">{BUCKET_LABELS[i]}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 text-[10px] text-[#ececec]/35">
                    update interval, ms (analog stick = true report rate; digital pad = gaps between
                    presses)
                  </div>
                </div>
              );
            })
          )}

          {/* Tap log */}
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
                for pads) and the gap to the previous tap. Rapid pad taps cluster at multiples of
                the report interval; keyboard gaps are continuous.
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
