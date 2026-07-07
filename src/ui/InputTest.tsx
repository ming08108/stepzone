/**
 * INPUT TEST — infers a controller's TRUE polling rate from Gamepad.timestamp.
 *
 * Gamepad.timestamp advances each time the browser gets a fresh device report,
 * so the gaps between distinct timestamps are integer multiples of the device's
 * report period. The smallest gap we ever observe ≈ one period, so the true
 * poll rate ≈ 1000 / (that smallest gap). The median gap doesn't work — it just
 * reflects how often you happened to move, not the hardware rate.
 *
 * Two things matter for a good estimate:
 *  - Sample faster than the device reports (else the smallest gap we can see is
 *    our own sampling interval, not the device's). rAF (≤ refresh) and even a
 *    4ms setTimeout are too slow for 500/1000Hz pads, so this page runs a
 *    MessageChannel micro-loop (~thousands/sec; diagnostic-only, stops on
 *    leave) reading navigator.getGamepads() directly.
 *  - Generate updates: move an analog stick (continuous reports → the period
 *    shows directly) or mash a panel (a couple of back-to-back reports reveal
 *    it). A still controller emits nothing to measure.
 *
 * The ceiling is whatever the browser exposes to JS via getGamepads(); the tap
 * log below shows the same timestamps flowing through the real input bus.
 */
import { useEffect, useState } from 'react';
import { RAW_GAMEPAD_EVENTS, subscribeControls, type ControlEvent } from '../input/inputBus';
import { Stage, STEP_AC as AC } from './Stage';
import { useMenuNav } from './useMenuNav';

// The event-driven Gamepad API is behind chrome://flags/#gamepad-raw-input-change-event
// (a global flag, not an origin trial). The on-event-handler attribute is the
// most reliable static signal; the live event count below is the real proof.
const RAW_GAMEPAD_SUPPORTED =
  typeof window !== 'undefined' && RAW_GAMEPAD_EVENTS.some((n) => `on${n}` in window);

/** Gap buckets (ms upper bounds) for the timestamp-interval histogram. */
const BUCKETS = [0.5, 1, 2, 4, 6, 9, 13, 17, 25, Infinity];
const BUCKET_LABELS = ['<.5', '.5–1', '1–2', '2–4', '4–6', '6–9', '9–13', '13–17', '17–25', '25+'];

const RING = 400; // gaps kept per pad

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Infer the device report period from the observed timestamp gaps: the gaps are
 * multiples of the period, so its floor is the period. Use a low percentile
 * (not the raw min) to shrug off a single coarsened/jittery outlier. 0 until we
 * have enough samples.
 */
function inferPeriodMs(gaps: number[]): number {
  if (gaps.length < 6) return 0;
  const s = [...gaps].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(1, Math.floor(s.length * 0.02)))];
}

interface PadStat {
  index: number;
  id: string;
  hasTimestamp: boolean;
  gaps: number[];
  hist: number[];
}

interface PadView {
  index: number;
  id: string;
  hasTimestamp: boolean;
  samples: number;
  periodMs: number;
  hz: number;
  minMs: number;
  medMs: number;
  maxMs: number;
  hist: number[];
}

interface Snapshot {
  displayHz: number;
  displayMs: number;
  sampleHz: number;
  pads: PadView[];
}

interface Tap {
  seq: number;
  device: ControlEvent['device'];
  role: ControlEvent['role'];
  t: number;
  dt: number | null;
}

const EMPTY: Snapshot = { displayHz: 0, displayMs: 0, sampleHz: 0, pads: [] };

export function InputTest({ onBack }: { onBack: () => void }) {
  useMenuNav(onBack);
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [taps, setTaps] = useState<Tap[]>([]);
  const [rawEvents, setRawEvents] = useState(0);

  // Count real event-driven-Gamepad-API events — the honest "is it on" signal.
  useEffect(() => {
    const bump = () => setRawEvents((n) => n + 1);
    for (const name of RAW_GAMEPAD_EVENTS) window.addEventListener(name, bump);
    return () => {
      for (const name of RAW_GAMEPAD_EVENTS) window.removeEventListener(name, bump);
    };
  }, []);

  useEffect(() => {
    let running = true;
    const padStats = new Map<number, PadStat>();
    const lastTs = new Map<number, number>();
    const rafIntervals: number[] = [];
    let lastRaf = 0;
    let sampleCount = 0;
    let sampleWinStart = performance.now();
    let sampleHz = 0;
    let lastSampleT = 0;

    const push = (arr: number[], v: number) => {
      arr.push(v);
      if (arr.length > RING) arr.shift();
    };

    // Read every pad; record the gap whenever a pad's Gamepad.timestamp advances.
    const sample = () => {
      const t = performance.now();
      if (t - lastSampleT < 0.3) return; // gate getGamepads() to ~3kHz
      lastSampleT = t;
      sampleCount++;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const gp of pads) {
        if (!gp) continue;
        let st = padStats.get(gp.index);
        if (!st) {
          st = {
            index: gp.index,
            id: gp.id || 'Gamepad',
            hasTimestamp: gp.timestamp > 0,
            gaps: [],
            hist: new Array(BUCKETS.length).fill(0),
          };
          padStats.set(gp.index, st);
        }
        st.hasTimestamp = st.hasTimestamp || gp.timestamp > 0;
        const prev = lastTs.get(gp.index);
        if (prev !== undefined && gp.timestamp > prev) {
          const gap = gp.timestamp - prev;
          push(st.gaps, gap);
          st.hist[BUCKETS.findIndex((b) => gap < b)]++;
        }
        lastTs.set(gp.index, gp.timestamp);
      }
    };

    // MessageChannel micro-loop: fires far faster than any timer/rAF, so the
    // smallest gap we resolve is the device's, not our sampler's. Cooperative
    // (each tick is its own task), so rAF/timers/React still run.
    const mc = new MessageChannel();
    mc.port1.onmessage = () => {
      if (!running) return;
      sample();
      mc.port2.postMessage(0);
    };
    mc.port2.postMessage(0);

    // Display refresh, for contrast (the ceiling an rAF-based poll would hit).
    const raf = (t: number) => {
      if (!running) return;
      if (lastRaf) push(rafIntervals, t - lastRaf);
      lastRaf = t;
      rafHandle = requestAnimationFrame(raf);
    };
    let rafHandle = requestAnimationFrame(raf);

    // Flush derived stats to React a few times a second (not per sample).
    const flush = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - sampleWinStart;
      if (elapsed > 250) {
        sampleHz = (sampleCount * 1000) / elapsed;
        sampleCount = 0;
        sampleWinStart = now;
      }
      const dMs = median(rafIntervals);
      setSnap({
        displayMs: dMs,
        displayHz: dMs > 0 ? 1000 / dMs : 0,
        sampleHz,
        pads: [...padStats.values()].map((st) => {
          const periodMs = inferPeriodMs(st.gaps);
          return {
            index: st.index,
            id: st.id,
            hasTimestamp: st.hasTimestamp,
            samples: st.gaps.length,
            periodMs,
            hz: periodMs > 0 ? 1000 / periodMs : 0,
            minMs: st.gaps.length ? Math.min(...st.gaps) : 0,
            medMs: median(st.gaps),
            maxMs: st.gaps.length ? Math.max(...st.gaps) : 0,
            hist: st.hist,
          };
        }),
      });
    }, 200);

    return () => {
      running = false;
      mc.port1.onmessage = null;
      mc.port1.close();
      mc.port2.close();
      cancelAnimationFrame(rafHandle);
      window.clearInterval(flush);
    };
  }, []);

  // Tap log from the real input bus — the shipping pipeline (incl. the
  // Gamepad.timestamp stamping). Presses only; keep the last dozen.
  useEffect(() => {
    let seq = 0;
    let prevT = 0;
    return subscribeControls((e) => {
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
            Infers your controller&apos;s true polling rate from the granularity of
            <code className="mx-1 text-[#ececec]/80">Gamepad.timestamp</code>. Move an analog stick
            (continuous reports) or mash a panel to generate updates — the smallest gap between
            timestamp updates is one device report period. This page samples far faster than the
            game does (the input bus polls once per frame, or is fully event-driven when the flag is
            on) so the estimate reflects the device, not our loop. Keyboard is event-timestamped —
            see the tap log.
          </p>

          {/* Timing sources */}
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
                  ? `${rawEvents} events received`
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

          <p className="-mt-3 mb-2 text-[11px] text-[#ececec]/40">
            This page probes <code className="text-[#ececec]/70">getGamepads()</code> at ~
            {num(snap.sampleHz, 0)} Hz to resolve the device rate below — that&apos;s the
            measurement tool, not how the game reads input (see GAME INPUT above).
          </p>

          {rawEvents === 0 && (
            <p className="mb-6 text-[11px] text-[#ececec]/40">
              Event-driven input is behind a flag: enable{' '}
              <code className="text-[#ececec]/70">
                chrome://flags/#gamepad-raw-input-change-event
              </code>{' '}
              (or the <code className="text-[#ececec]/70">edge://</code> equivalent) and relaunch —
              the app attaches the listeners either way, so it lights up automatically.
            </p>
          )}

          {/* Inferred device poll rate */}
          <div className="mb-3 flex items-center gap-4">
            <span className="text-[11px] tracking-[0.2em] text-[#ececec]/40">
              INFERRED DEVICE POLL RATE
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
              const ready = p.samples >= 6 && p.periodMs > 0;
              return (
                <div key={p.index} className="mb-4 border border-white/10 px-4 py-3">
                  <div className="flex items-baseline gap-3">
                    <span className="text-[#ececec]/35">#{p.index + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[#ececec]/85">
                      {p.id}
                    </span>
                    {!p.hasTimestamp && (
                      <span className="text-[10px] tracking-[0.1em] text-[#ffcf3d]/70">
                        NO TIMESTAMP — CAN&apos;T INFER
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
                    <span className="text-[32px] font-bold leading-none [font-variant-numeric:tabular-nums]">
                      {ready ? (
                        <>
                          <span style={{ color: AC }}>≈ {Math.round(p.hz)}</span>
                          <span className="ml-1 text-[14px] font-normal text-[#ececec]/50">Hz</span>
                        </>
                      ) : (
                        <span className="text-[16px] font-normal text-[#ececec]/45">
                          move a stick / mash a panel…
                        </span>
                      )}
                    </span>
                    {ready && (
                      <span className="text-[13px] [font-variant-numeric:tabular-nums] text-[#ececec]/55">
                        period {num(p.periodMs, 2)} ms · gaps {num(p.minMs, 1)}–{num(p.maxMs, 1)} ms
                        (med {num(p.medMs, 1)}) · {p.samples} samples
                      </span>
                    )}
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
                    gap between timestamp updates, ms — the leftmost populated bucket is one report
                    period; higher buckets are its multiples
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
