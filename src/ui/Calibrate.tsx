/**
 * Offset calibration (design 6b) — play a steady metronome, tap a panel on
 * every beat, and measure your mean timing error on the same input path
 * gameplay uses.
 *
 * The old screen measured a signed error per tap and showed you a count and
 * nothing else. It now shows the taps: every tap plotted on the same ±ms axis
 * the gameplay HUD uses (newest brightest), the running mean, and the spread —
 * so APPLY is a decision you can make, not a leap. The verdict names the value
 * it will write, and a second strip shows the same taps re-centred: the
 * argument for pressing it. The metronome is an expanding ring (a run-up you
 * can anticipate) with the tap count inside, and previous calibrations persist
 * so you can tell whether today's number is your usual one or the Bluetooth
 * headphones talking.
 */
import { useEffect, useRef, useState } from 'react';
import { WebAudioClock } from '../audio/clock';
import { makeClickTrack, type Click } from '../audio/synth';
import { isRecord, loadJson, saveJson } from '../app/storage';
import { KeyLegend } from './KeyLegend';
import { useControls } from './useControls';
import { useSettings } from './SettingsContext';

const AC = '#ff5d47';
const BPM = 120;
const BEAT = 60 / BPM; // 0.5s
const DURATION = 40;
/** Minimum taps the trimmed mean needs; the confident target. */
const MIN_TAPS = 6;
const GOOD_TAPS = 32;

/* ── previous calibrations, persisted ────────────────────────────────────── */

const LOG_KEY = 'notefield.calibrations.v1';
interface CalRun {
  at: number;
  ms: number;
}
function loadCalLog(): CalRun[] {
  const p = loadJson<unknown>(LOG_KEY);
  if (!Array.isArray(p)) return [];
  return p
    .filter(
      (e): e is CalRun =>
        isRecord(e) &&
        typeof e.at === 'number' &&
        typeof e.ms === 'number' &&
        Number.isFinite(e.ms),
    )
    .slice(-5);
}
function pushCalLog(ms: number): CalRun[] {
  const log = [...loadCalLog(), { at: Date.now(), ms }].slice(-5);
  saveJson(LOG_KEY, log);
  return log;
}
function fmtWhen(at: number): string {
  const d = Math.floor((Date.now() - at) / 86_400_000);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** 20% trimmed mean in ms (the value APPLY negates), or null under MIN_TAPS. */
function trimmedMeanMs(offsets: readonly number[]): number | null {
  if (offsets.length < MIN_TAPS) return null;
  const arr = [...offsets].sort((a, b) => a - b);
  const k = Math.floor(arr.length * 0.2);
  const trimmed = arr.slice(k, arr.length - k);
  return (trimmed.reduce((s, x) => s + x, 0) / trimmed.length) * 1000;
}

function TapScatter({
  ms,
  meanMs,
  height,
}: {
  /** Signed tap errors in ms, oldest first. */
  ms: readonly number[];
  meanMs: number | null;
  height: number;
}) {
  const pos = (v: number) => 50 + (Math.max(-60, Math.min(60, v)) / 60) * 50;
  const AXIS = 26;
  const usable = Math.max(1, height - AXIS - 9 - 14 - 4);
  return (
    <div
      className="relative bg-[#0a0c12]"
      style={{ height, boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.07)' }}
    >
      {/* the "tight" zone: ±8 ms */}
      <div
        className="absolute"
        style={{
          left: '43.3%',
          right: '43.3%',
          top: 0,
          bottom: AXIS,
          background: 'rgba(89,240,127,.07)',
        }}
      />
      <div
        className="absolute w-[2px] -ml-px bg-white/45"
        style={{ left: '50%', top: 0, bottom: AXIS }}
      />
      {ms.map((v, i) => (
        <div
          key={i}
          className="absolute h-[9px] w-[9px] -ml-1 rounded-full"
          style={{
            left: `${pos(v)}%`,
            top: 14 + ((i * 37) % usable),
            background: Math.abs(v) <= 12 ? '#59f07f' : Math.abs(v) <= 30 ? '#ffcf3d' : '#ff9d3d',
            opacity: 0.3 + 0.7 * ((i + 1) / Math.max(1, ms.length)),
          }}
        />
      ))}
      {meanMs != null && (
        <div
          className="absolute w-[3px] -ml-px"
          style={{
            left: `${pos(meanMs)}%`,
            top: 0,
            bottom: AXIS,
            background: '#ffcf3d',
            boxShadow: '0 0 12px rgba(255,207,61,.9)',
          }}
        />
      )}
      <div
        className="absolute inset-x-0 bottom-0 flex items-center justify-between px-3 text-[11px] tracking-[0.12em] text-[#ececec]/40"
        style={{ height: AXIS }}
      >
        <span>EARLY −60 ms</span>
        <span>0</span>
        <span>+60 ms LATE</span>
      </div>
    </div>
  );
}

export function Calibrate({ onBack }: { onBack: () => void }) {
  const { settings, update } = useSettings();
  const clockRef = useRef<WebAudioClock | null>(null);
  const offsetsRef = useRef<number[]>([]);
  const rafRef = useRef(0);
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [applied, setApplied] = useState<number | null>(null);
  const [calLog, setCalLog] = useState<CalRun[]>(loadCalLog);
  const [, force] = useState(0);

  // Every teardown path (unmount, re-START, STOP, Apply, Back) funnels through
  // here. dispose() stops playback AND closes the AudioContext — browsers cap
  // concurrent contexts, so each run's clock must be released, not just stopped.
  const stop = () => {
    cancelAnimationFrame(rafRef.current);
    void clockRef.current?.dispose();
    clockRef.current = null;
    setRunning(false);
  };

  useEffect(() => () => stop(), []);

  const start = async () => {
    stop();
    const clock = new WebAudioClock();
    // Claim the ref (and show STOP) BEFORE the await, so a second START or a
    // STOP/back during resume() can find and dispose this exact context.
    clockRef.current = clock;
    setRunning(true);
    await clock.resume();
    if (clockRef.current !== clock) {
      void clock.dispose(); // superseded or torn down while resuming
      return;
    }
    const clicks: Click[] = [];
    for (let b = 0; b * BEAT < DURATION; b++) clicks.push({ time: b * BEAT, accent: b % 4 === 0 });
    clock.setBuffer(makeClickTrack(clock.ctx, clicks, DURATION + 0.5));
    clock.sync.audioOffsetSeconds = 0; // measure raw
    clock.start(0, 0.3);
    offsetsRef.current = [];
    setCount(0);
    setApplied(null);

    const loop = () => {
      if (clockRef.current !== clock) return; // a newer run (or stop) supersedes us
      clock.refresh(); // keep the sync anchor fresh
      force((x) => x + 1);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  const meanMs = trimmedMeanMs(offsetsRef.current);
  const rawMs = offsetsRef.current.map((s) => s * 1000);
  const allMean = rawMs.length ? rawMs.reduce((a, b) => a + b, 0) / rawMs.length : null;
  const sd =
    allMean != null && rawMs.length > 1
      ? Math.sqrt(rawMs.reduce((a, b) => a + (b - allMean) * (b - allMean), 0) / rawMs.length)
      : null;
  const applyMs = meanMs != null ? Math.round(-meanMs) : null;

  const apply = () => {
    if (applyMs == null) return;
    update({ audioOffsetMs: applyMs });
    setApplied(applyMs);
    setCalLog(pushCalLog(applyMs));
    stop();
  };

  // Taps come through the unified input bus, so you calibrate with whatever
  // you play with — same timestamp path as gameplay.
  useControls((e) => {
    if (!e.pressed || e.repeat) return;
    if (e.device === 'keyboard') e.nativeEvent?.preventDefault();
    if (e.role === 'back') {
      // Running → STOP this run but stay (a pad-reachable STOP); idle → leave.
      if (clockRef.current) stop();
      else onBack();
      return;
    }
    if (e.role === 'confirm') {
      if (!clockRef.current) void start();
      else if (offsetsRef.current.length >= MIN_TAPS) apply();
      return;
    }
    const clock = clockRef.current;
    if (!clock) return;
    clock.refresh();
    const t = clock.songSecondsAtEvent(e.timeStampMs);
    if (t < 0.25) return; // skip lead-in
    const nearest = Math.round(t / BEAT) * BEAT;
    const err = t - nearest;
    if (Math.abs(err) > BEAT / 2) return;
    offsetsRef.current.push(err);
    setCount(offsetsRef.current.length);
  });

  // Metronome pulse, clock-derived (the CSS ring is the anticipation cue).
  const now = clockRef.current ? clockRef.current.sync.songSecondsAtPerf(performance.now()) : -1;
  const phase = now >= 0 ? now / BEAT - Math.floor(now / BEAT) : 0;
  const flash = now >= 0 && phase < 0.15;

  const tight = sd != null && sd <= 12;

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-[#0b0c0e] font-grotesk text-[#ececec] [font-variant-numeric:tabular-nums]">
      <div className="flex h-[64px] flex-none items-center gap-5 border-b border-white/[0.09] bg-[#0e0f12] px-6">
        <span className="font-display text-[20px] font-bold tracking-[0.22em]">STEPZONE</span>
        <span className="font-display text-[13px] tracking-[0.18em]" style={{ color: AC }}>
          CALIBRATE
        </span>
        <span className="flex-1" />
        <span className="text-[13px] text-[#ececec]/50">
          Offset is a property of your output device — recalibrate when it changes
        </span>
      </div>

      <div className="flex min-h-0 flex-1 gap-10 overflow-y-auto px-[5%] py-9">
        {/* ── the metronome side ─────────────────────────────────────────── */}
        <div className="flex w-[440px] flex-none flex-col items-center gap-6">
          <div className="text-center">
            <div className="font-display text-[24px] font-bold tracking-[0.06em]">
              Tap on every beat
            </div>
            <div className="mt-[6px] max-w-[400px] text-[14px] leading-[1.5] text-[#ececec]/55">
              Any panel — arrow keys, D F J K, or your pad. Use whatever you actually play with.
            </div>
          </div>

          <div className="relative flex h-[210px] w-[210px] items-center justify-center">
            {running && (
              <span
                className="absolute inset-0 rounded-full border-[3px]"
                style={{ borderColor: AC, animation: `beatRing ${BEAT * 1000}ms linear infinite` }}
              />
            )}
            <div className="absolute inset-[26px] rounded-full border-4 border-white/[0.14]" />
            <div
              className="absolute inset-[26px] rounded-full"
              style={{
                background: flash ? 'rgba(255,93,71,.3)' : 'transparent',
                boxShadow: flash ? '0 0 40px rgba(255,93,71,.4)' : undefined,
              }}
            />
            <div className="relative text-center">
              <div className="font-display text-[48px] leading-none font-bold">{count}</div>
              <div className="mt-1 text-[11px] tracking-[0.18em] text-[#ececec]/50">
                OF {GOOD_TAPS} TAPS
              </div>
            </div>
          </div>

          <div className="w-full">
            <div className="relative h-[6px] bg-white/10">
              <div
                className="absolute top-0 bottom-0 left-0"
                style={{
                  width: `${Math.min(100, (count / GOOD_TAPS) * 100)}%`,
                  background: '#59f07f',
                }}
              />
              <div
                className="absolute -top-[5px] -bottom-[5px] w-[2px] bg-white/40"
                style={{ left: `${(MIN_TAPS / GOOD_TAPS) * 100}%` }}
              />
            </div>
            <div className="mt-2 flex justify-between text-[11px] tracking-[0.12em] text-[#ececec]/40">
              <span>{MIN_TAPS} = USABLE</span>
              <span style={{ color: count >= GOOD_TAPS ? '#59f07f' : undefined }}>
                {GOOD_TAPS} = CONFIDENT
              </span>
            </div>
          </div>

          <div className="flex w-full gap-[10px]">
            {!running ? (
              <button
                onClick={() => void start()}
                className="flex h-12 flex-[2] items-center justify-center font-display text-[15px] font-bold tracking-[0.14em]"
                style={{ background: AC, color: '#0b0c0e' }}
              >
                ▶ START TAPPING
              </button>
            ) : (
              <button
                onClick={stop}
                className="flex h-12 flex-1 items-center justify-center font-display text-[13px] tracking-[0.12em] text-[#ececec]/75"
                style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.18)' }}
              >
                STOP
              </button>
            )}
            <button
              onClick={apply}
              disabled={applyMs == null}
              className="flex h-12 flex-[2] items-center justify-center font-display text-[15px] font-bold tracking-[0.14em] disabled:opacity-40"
              style={{ background: AC, color: '#0b0c0e' }}
            >
              {applyMs != null ? `APPLY ${applyMs > 0 ? '+' : ''}${applyMs} MS ▸` : 'APPLY'}
            </button>
          </div>
          {applied !== null && (
            <div className="text-[13px] tracking-[0.1em]" style={{ color: '#59f07f' }}>
              APPLIED {applied > 0 ? '+' : ''}
              {applied} MS
            </div>
          )}

          <div className="w-full border-t border-white/[0.08] pt-4">
            <div className="font-display text-[10px] tracking-[0.24em] text-[#ececec]/35">
              PREVIOUS CALIBRATIONS
            </div>
            {calLog.length === 0 ? (
              <div className="mt-2 text-[12px] text-[#ececec]/40">None yet on this device.</div>
            ) : (
              [...calLog].reverse().map((r, i) => (
                <div
                  key={r.at}
                  className="grid h-[34px] grid-cols-[92px_1fr_76px] items-baseline gap-3 border-b border-white/[0.05] text-[13px]"
                >
                  <span className="text-[#ececec]/40">{fmtWhen(r.at)}</span>
                  <span className="text-[#ececec]/70">audio offset</span>
                  <span
                    className="text-right font-display text-[16px] font-bold tabular-nums"
                    style={{ color: i === 0 ? AC : 'rgba(236,236,236,.7)' }}
                  >
                    {r.ms > 0 ? '+' : ''}
                    {r.ms} ms
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── the data side ──────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <div>
            <div className="flex items-baseline gap-3">
              <span className="font-display text-[10px] tracking-[0.24em] text-[#ececec]/35">
                YOUR TAPS
              </span>
              <span className="h-px flex-1 bg-white/[0.07]" />
              <span className="text-[12px] text-[#ececec]/45">newest brightest</span>
            </div>
            <div className="mt-3">
              <TapScatter ms={rawMs} meanMs={allMean} height={190} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-px bg-white/[0.07]">
            <div className="bg-[#0b0c0e] px-4 py-[13px]">
              <div className="text-[10px] tracking-[0.18em] text-[#ececec]/35">YOUR AVERAGE</div>
              <div
                className="mt-1 font-display text-[27px] font-bold tabular-nums"
                style={{ color: allMean != null && Math.abs(allMean) > 5 ? '#ffcf3d' : '#ececec' }}
              >
                {allMean == null ? '—' : `${allMean >= 0 ? '+' : ''}${Math.round(allMean)} ms`}
              </div>
              <div className="text-[12px] text-[#ececec]/40">
                {allMean == null
                  ? 'tap along to measure'
                  : allMean > 5
                    ? 'late'
                    : allMean < -5
                      ? 'early'
                      : 'on time'}
              </div>
            </div>
            <div className="bg-[#0b0c0e] px-4 py-[13px]">
              <div className="text-[10px] tracking-[0.18em] text-[#ececec]/35">SPREAD</div>
              <div
                className="mt-1 font-display text-[27px] font-bold tabular-nums"
                style={{ color: sd == null ? '#ececec' : tight ? '#59f07f' : '#ffcf3d' }}
              >
                {sd == null ? '—' : `±${Math.round(sd)} ms`}
              </div>
              <div className="text-[12px] text-[#ececec]/40">
                {sd == null ? '' : tight ? 'tight — reliable' : 'loose — tap more'}
              </div>
            </div>
            <div className="bg-[#0b0c0e] px-4 py-[13px]">
              <div className="text-[10px] tracking-[0.18em] text-[#ececec]/35">CURRENT OFFSET</div>
              <div className="mt-1 font-display text-[27px] font-bold tabular-nums">
                {settings.audioOffsetMs > 0 ? '+' : ''}
                {settings.audioOffsetMs} ms
              </div>
              <div className="text-[12px] text-[#ececec]/40">what gameplay uses now</div>
            </div>
          </div>

          {applyMs != null && meanMs != null && (
            <div
              className="px-[18px] py-4"
              style={{
                border: '1px solid rgba(89,240,127,.4)',
                background: 'rgba(89,240,127,.07)',
              }}
            >
              <div className="font-display text-[14px] font-bold tracking-[0.1em] text-[#59f07f]">
                YOU TAP {Math.abs(Math.round(meanMs))} MS {meanMs >= 0 ? 'LATE' : 'EARLY'}
                {tight ? ', CONSISTENTLY' : ''}
              </div>
              <div className="mt-[5px] text-[14px] leading-[1.5] text-[#ececec]/70">
                Applying <span className="font-bold text-[#ececec]">{applyMs} ms</span> moves your
                audio offset from <span className="text-[#ececec]">{settings.audioOffsetMs}</span>{' '}
                to <span className="text-[#ececec]">{applyMs}</span>.{' '}
                {sd != null &&
                  (tight
                    ? `Your spread is tight (±${Math.round(sd)} ms), so this is a reliable read — audio-output latency is the usual cause.`
                    : `Your spread is loose (±${Math.round(sd)} ms) — a few more taps will firm the number up.`)}
              </div>
            </div>
          )}

          {applyMs != null && (
            <div>
              <div className="flex items-baseline gap-3">
                <span className="font-display text-[10px] tracking-[0.24em] text-[#ececec]/35">
                  AFTER APPLYING
                </span>
                <span className="h-px flex-1 bg-white/[0.07]" />
                <span className="text-[12px] text-[#59f07f]">the same taps, re-centred</span>
              </div>
              <div className="mt-3">
                <TapScatter
                  ms={rawMs.map((v) => v + applyMs)}
                  meanMs={allMean != null ? allMean + applyMs : null}
                  height={84}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <KeyLegend
        actions={{
          updown: 'TAP THE BEAT',
          leftright: 'TAP THE BEAT',
          select: running ? 'STOP' : 'BACK TO SETTINGS',
          start: running ? (count >= MIN_TAPS ? 'APPLY' : 'TAPPING…') : 'START',
          fav: null,
        }}
      />
    </div>
  );
}
