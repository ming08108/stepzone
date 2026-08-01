/**
 * The in-play HUD — everything on the gameplay screen that is NOT the note
 * field. Rendered as DOM over the canvas, at HUD_HZ, so the render loop is
 * untouched and text costs no atlas space.
 *
 * The field renderer is deliberately unchanged: same fieldLeft, same lanes,
 * same receptors, same arrows and freezes, same judgment/combo anchors. Only
 * the chrome around it moves. What this replaces:
 *
 *   · The bottom-left score panel (ddrA3Skin.pushScorePanel), 800px from where
 *     you are looking, showing a 7-digit money score — while the number that
 *     sets your grade, your PB and your rank (the percent) was not on screen at
 *     all until the results.
 *   · The bottom-centre song panel (pushSongPanel) whose 2.5×ds progress
 *     hairline was the only way to know how much song was left.
 *   · The ⛶ / ← SONGS buttons in Play.tsx, which are drawn AT 16px from the
 *     bottom-left — i.e. on top of that score panel — and are a mouse-only
 *     exit, while the pad's hold-to-quit was never signposted.
 *
 * And what it adds, from data the engine already produces:
 *   · A rolling ±90 ms timing bar (session.offsets), so drifting late is
 *     something you fix mid-song instead of reading about afterwards.
 *   · The chart's NPS density as a vertical timeline with a playhead, so you
 *     can see the stream coming (computeChartStats — the same call song select
 *     already makes).
 *   · A live judgment tally.
 *
 * Density is a Player Options setting: 'full' shows the timeline and the tally,
 * 'lean' keeps only life, timing, score and time left.
 */
import { useEffect, useMemo, useState } from 'react';
import { computeChartStats, type ChartStats } from '../../analysis/chartStats';
import { A3_JUDGMENT } from '../../render/gpu/ddrA3Art';
import type { HudDensity, NoteSkin } from '../../game/playOptions';
import { TapNoteScore } from '../../notes/noteTypes';
import type { Song } from '../../song/song';
import type { Steps } from '../../song/steps';
import { difficultyToString } from '../../song/difficulty';
import { difficultyColor } from '../difficultyUi';
import { fieldMetrics } from './fieldMetrics';
import type { HudTelemetry } from './useHudTelemetry';

const AC = '#ff5d47';

/** Letter-grade tier colours. Hoisted out of Play.tsx so the in-play readout
 *  and the results header can never disagree — Play.tsx imports this. */
export const GRADE_COLORS: Record<string, string> = {
  AAA: '#ffd23d',
  AA: '#38f0ff',
  A: '#59f07f',
  B: '#5db4ff',
  C: '#ff9d3d',
  D: '#ff5d47',
  F: '#e01818', // judge.grade returns 'F' for a failed run
};
export const gradeColor = (g: string): string => GRADE_COLORS[g] ?? '#ececec';

/** Timing-bar half-range. Wider than any judgment window, so a tick never
 *  clamps silently against the edge. */
const TIMING_RANGE_MS = 90;

/** Tick colour by |error|, matching the judgment tiers it corresponds to.
 *  Exported so Calibrate's tap scatter uses the same tiers as the timing bar. */
export function tickColor(ms: number): string {
  const a = Math.abs(ms);
  if (a <= 11) return '#38f0ff';
  if (a <= 23) return '#ffd23d';
  if (a <= 45) return '#59f07f';
  return '#c86bff';
}

const TALLY_ORDER = [
  TapNoteScore.W1,
  TapNoteScore.W2,
  TapNoteScore.W3,
  TapNoteScore.W4,
  TapNoteScore.W5,
  TapNoteScore.Miss,
] as const;

/** ITG (Simply Love) wording, so the tally matches the judgment text on screen.
 *  Mirrors ITG_JUDGMENT in render/gpu/simplyLoveArt.ts. */
const ITG_LABELS: Record<number, { label: string; color: string }> = {
  [TapNoteScore.W1]: { label: 'Fantastic', color: '#21cce8' },
  [TapNoteScore.W2]: { label: 'Excellent', color: '#e29c18' },
  [TapNoteScore.W3]: { label: 'Great', color: '#66c955' },
  [TapNoteScore.W4]: { label: 'Decent', color: '#b45cff' },
  [TapNoteScore.W5]: { label: 'Way Off', color: '#c9855e' },
  [TapNoteScore.Miss]: { label: 'Miss', color: '#ff3030' },
};

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Seconds until the next sustained dense passage, or null if none is near. */
function nextStream(stats: ChartStats, now: number): number | null {
  for (const b of stats.nps) {
    if (b.t0 <= now + 2) continue;
    if (b.t0 > now + 40) return null;
    if (b.h >= 0.8) return b.t0 - now;
  }
  return null;
}

function useChartStats(song: Song, chart: Steps): ChartStats | null {
  return useMemo(() => {
    try {
      return computeChartStats(
        chart.getNoteData(),
        chart.getTimingData(song.timing),
        chart.stepsType,
      );
    } catch {
      return null;
    }
  }, [song, chart]);
}

function useViewport(): { w: number; h: number } {
  const [v, setV] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setV({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return v;
}

function Label({ children, k }: { children: string; k: number }) {
  return (
    <div className="font-display tracking-[0.22em] text-[#ececec]/35" style={{ fontSize: 11 * k }}>
      {children}
    </div>
  );
}

/* ── the timing bar — the highest-value addition, and it needs no new data ──
   Exported: the results screen renders the SAME bar at the same scale, so the
   in-play readout and the post-song summary can never disagree. */

export function TimingBar({
  recentMs,
  meanMs,
  k,
  showCaption = true,
}: {
  recentMs: number[];
  meanMs: number | null;
  k: number;
  /** Results shows its own avg line beside the section label — suppress the
   *  bar's baked-in caption there so the sentence isn't printed twice. */
  showCaption?: boolean;
}) {
  const pos = (ms: number) =>
    50 + (Math.max(-TIMING_RANGE_MS, Math.min(TIMING_RANGE_MS, ms)) / TIMING_RANGE_MS) * 50;
  const drift =
    meanMs == null ? null : meanMs < -5 ? 'you are early' : meanMs > 5 ? 'you are late' : 'on time';
  const driftColor = meanMs == null ? '#ececec' : Math.abs(meanMs) <= 5 ? '#59f07f' : '#ffcf3d';
  return (
    <div
      className="relative bg-[#0a0c12]/70"
      style={{ height: 74 * k, boxShadow: `inset 0 0 0 1px rgba(255,255,255,.07)` }}
    >
      <div
        className="absolute bg-white/45"
        style={{
          left: '50%',
          top: 8 * k,
          bottom: 22 * k,
          width: 2 * k,
          transform: `translateX(${-k}px)`,
        }}
      />
      {[25, 75].map((p) => (
        <div
          key={p}
          className="absolute bg-white/10"
          style={{ left: `${p}%`, top: 8 * k, bottom: 22 * k, width: 1 }}
        />
      ))}
      {recentMs.map((ms, i) => (
        <div
          key={i}
          className="absolute"
          style={{
            left: `${pos(ms)}%`,
            top: 12 * k,
            width: 2 * k,
            height: 36 * k,
            background: tickColor(ms),
            // Older taps fade out, so the bar reads as "the last few seconds".
            opacity: 0.3 + 0.7 * ((i + 1) / recentMs.length),
          }}
        />
      ))}
      {meanMs != null && (
        <div
          className="absolute"
          style={{
            left: `${pos(meanMs)}%`,
            top: 6 * k,
            width: 3 * k,
            height: 44 * k,
            background: '#ffcf3d',
            boxShadow: `0 0 ${10 * k}px rgba(255,207,61,.9)`,
          }}
        />
      )}
      <div
        className="absolute tracking-[0.14em] text-[#ececec]/40"
        style={{ left: 10 * k, bottom: 4 * k, fontSize: 11 * k }}
      >
        EARLY −{TIMING_RANGE_MS}
      </div>
      {showCaption && (
        <div
          className="absolute w-full text-center tracking-[0.1em]"
          style={{ bottom: 4 * k, fontSize: 12 * k, color: driftColor }}
        >
          {meanMs == null ? '—' : `avg ${meanMs >= 0 ? '+' : ''}${meanMs.toFixed(1)} ms — ${drift}`}
        </div>
      )}
      <div
        className="absolute tracking-[0.14em] text-[#ececec]/40"
        style={{ right: 10 * k, bottom: 4 * k, fontSize: 11 * k }}
      >
        +{TIMING_RANGE_MS} LATE
      </div>
    </div>
  );
}

/* ── the chart, vertical, with a playhead ─────────────────────────────────── */

function ChartTimeline({
  stats,
  elapsed,
  left,
  top,
  bottom,
  k,
}: {
  stats: ChartStats;
  elapsed: number;
  left: number;
  top: number;
  bottom: number;
  k: number;
}) {
  const w = 52 * k;
  const len = Math.max(0.001, stats.lengthSeconds);
  const progress = Math.max(0, Math.min(1, elapsed / len));
  const stream = nextStream(stats, elapsed);
  return (
    <div className="absolute" style={{ left, top, bottom, width: w }}>
      <div className="absolute" style={{ top: -22 * k }}>
        <Label k={k}>CHART</Label>
      </div>
      <div
        className="absolute inset-x-0 bg-[#0a0c12]/70"
        style={{ top: 0, bottom: 0, boxShadow: `inset 0 0 0 1px rgba(255,255,255,.07)` }}
      >
        {stats.nps.map((b, i) => (
          <div
            key={i}
            className="absolute left-0"
            style={{
              top: `${(b.t0 / len) * 100}%`,
              height: `${Math.max(0.4, ((b.t1 - b.t0) / len) * 100)}%`,
              width: 6 * k + b.h * 46 * k,
              background: b.h > 0.8 ? '#8200a1' : b.h > 0.55 ? '#4a5fb0' : '#00adc0',
            }}
          />
        ))}
        <div
          className="absolute"
          style={{
            left: -6 * k,
            right: -6 * k,
            top: `${progress * 100}%`,
            height: 3 * k,
            background: AC,
            boxShadow: `0 0 ${14 * k}px rgba(255,93,71,.8)`,
          }}
        />
      </div>
      <div
        className="absolute font-display font-bold tracking-[0.1em] tabular-nums"
        style={{
          left: w + 10 * k,
          top: `calc(${progress * 100}% - ${14 * k}px)`,
          fontSize: 16 * k,
          color: AC,
        }}
      >
        {fmtTime(elapsed)}
      </div>
      <div
        className="absolute tracking-[0.1em] text-[#ececec]/40 tabular-nums"
        style={{
          left: w + 10 * k,
          top: `calc(${progress * 100}% + ${10 * k}px)`,
          fontSize: 12 * k,
        }}
      >
        −{fmtTime(len - elapsed)}
      </div>
      {stream != null && (
        <div
          className="absolute font-display tracking-[0.1em] whitespace-nowrap"
          style={{
            left: w + 10 * k,
            top: `calc(${progress * 100}% + ${88 * k}px)`,
            padding: `${5 * k}px ${9 * k}px`,
            fontSize: 12 * k,
            color: '#ffcf3d',
            background: 'rgba(255,207,61,.14)',
            boxShadow: 'inset 0 0 0 1px rgba(255,207,61,.4)',
          }}
        >
          STREAM IN {fmtTime(stream)}
        </div>
      )}
    </div>
  );
}

/* ── the whole overlay ────────────────────────────────────────────────────── */

export function PlayHud({
  song,
  chart,
  telemetry,
  density,
  skin,
  reverse,
  numTracks = 4,
  musicRate,
  pbPercent,
  practiceNote,
  fps,
  onFullscreen,
}: {
  song: Song;
  chart: Steps;
  telemetry: HudTelemetry;
  density: HudDensity;
  skin: NoteSkin;
  reverse: boolean;
  numTracks?: number;
  musicRate: number;
  /** Your stored best on this chart, 0..1, or null if never cleared. */
  pbPercent: number | null;
  /** e.g. "PRACTICE · M17–M32 · LOOP 3" or "▶ REPLAY". */
  practiceNote?: string | null;
  fps: number;
  onFullscreen: () => void;
}) {
  const { w, h } = useViewport();
  const m = fieldMetrics(w, h, numTracks, skin, reverse);
  const k = m.k;
  const stats = useChartStats(song, chart);
  const full = density === 'full';

  const barH = 78 * k;
  const colTop = 62 * k;
  const timelineLeft = m.fieldRight + 26 * k;
  const colLeft = full ? timelineLeft + 52 * k + 216 * k : m.fieldRight + 90 * k;
  const colWidth = Math.max(300 * k, Math.min(440 * k, w - colLeft - 24 * k));

  const pct = telemetry.percent * 100;
  const gc = gradeColor(telemetry.grade);
  const delta = pbPercent == null ? null : pct - pbPercent * 100;
  const money = Math.round(telemetry.percent * 1_000_000).toLocaleString();
  const len = stats?.lengthSeconds ?? 0;
  const progress = len > 0 ? Math.max(0, Math.min(1, telemetry.elapsed / len)) : 0;

  const diffName = difficultyToString(chart.difficulty);
  const labels = skin === 'itg' ? ITG_LABELS : A3_JUDGMENT;

  // Danger reads in peripheral vision, so you never have to look away from the
  // arrows to find out you are about to fail.
  const danger = !telemetry.failed && telemetry.life < 0.25;
  const dangerAlpha = danger ? 0.1 + 0.28 * (1 - telemetry.life / 0.25) : 0;

  return (
    <div className="pointer-events-none absolute inset-0 z-[3] font-grotesk text-[#ececec] [font-variant-numeric:tabular-nums]">
      {dangerAlpha > 0 && (
        <div
          className="absolute inset-0"
          style={{
            boxShadow: `inset 0 0 ${190 * k}px ${60 * k}px rgba(224,24,24,${dangerAlpha.toFixed(3)})`,
          }}
        />
      )}

      {/* LIFE caption under the (relocated, field-aligned) GPU gauge. Hidden
          under reverse — there the gauge tucks flush between the receptors and
          the bottom strip (ddrA3Skin.pushGauge) with no room for a label. */}
      {!reverse && (
        <div
          className="absolute flex justify-between font-display tracking-[0.22em] text-[#ececec]/35"
          style={{
            left: m.fieldLeft,
            width: m.fieldWidth,
            // The GPU gauge sits at gy = 41×ds with gh = 26×ds (ddrA3Skin.pushGauge).
            top: m.ds * 67 + 6 * k,
            fontSize: 11 * k,
          }}
        >
          <span style={danger ? { color: '#e01818' } : undefined}>
            {danger ? 'DANGER' : 'LIFE'}
          </span>
          <span style={{ color: danger ? '#e01818' : '#59f07f' }}>
            {Math.round(telemetry.life * 100)}%
          </span>
        </div>
      )}

      {full && stats && (
        <ChartTimeline
          stats={stats}
          elapsed={telemetry.elapsed}
          left={timelineLeft}
          top={colTop}
          bottom={barH + 40 * k}
          k={k}
        />
      )}

      <div className="absolute" style={{ left: colLeft, top: colTop, width: colWidth }}>
        <Label k={k}>SCORE</Label>
        <div className="flex items-end" style={{ gap: 20 * k, marginTop: 4 * k }}>
          <span className="font-display font-bold leading-[.9]" style={{ fontSize: 96 * k }}>
            {pct.toFixed(2)}
            <span className="text-[#ececec]/50" style={{ fontSize: 44 * k }}>
              %
            </span>
          </span>
          <span
            className="font-display leading-none font-bold"
            style={{ fontSize: 66 * k, color: gc, textShadow: `0 0 ${24 * k}px ${gc}80` }}
          >
            {telemetry.grade}
          </span>
        </div>
        <div
          className="flex items-center"
          style={{ gap: 14 * k, marginTop: 8 * k, fontSize: 15 * k }}
        >
          {delta != null ? (
            <span className="font-bold" style={{ color: delta >= 0 ? '#59f07f' : '#ff9d3d' }}>
              {delta >= 0 ? '▲ +' : '▼ '}
              {delta.toFixed(2)} vs YOUR PB
            </span>
          ) : (
            <span className="text-[#ececec]/45">NO PB ON THIS CHART</span>
          )}
          <span className="text-[#ececec]/40">·</span>
          <span className="text-[#ececec]/55">{money}</span>
        </div>

        <div style={{ marginTop: 26 * k }}>
          <Label k={k}>TIMING</Label>
        </div>
        <div style={{ marginTop: 8 * k }}>
          <TimingBar recentMs={telemetry.recentMs} meanMs={telemetry.meanMs} k={k} />
        </div>

        {full && (
          <>
            <div style={{ marginTop: 26 * k }}>
              <Label k={k}>JUDGMENTS</Label>
            </div>
            <div className="flex flex-col" style={{ marginTop: 8 * k }}>
              {TALLY_ORDER.map((tns) => {
                const j = labels[tns];
                if (!j) return null;
                return (
                  <div
                    key={tns}
                    className="grid items-center border-b border-white/5"
                    style={{ gridTemplateColumns: `1fr ${76 * k}px`, height: 34 * k }}
                  >
                    <span
                      className="font-display font-semibold tracking-[0.08em]"
                      style={{ fontSize: 17 * k, color: j.color }}
                    >
                      {j.label}
                    </span>
                    <span
                      className="text-right font-display font-bold"
                      style={{ fontSize: 22 * k }}
                    >
                      {telemetry.counts[tns] ?? 0}
                    </span>
                  </div>
                );
              })}
              <div
                className="grid items-center border-t border-white/20"
                style={{ gridTemplateColumns: `1fr ${76 * k}px`, height: 34 * k }}
              >
                <span
                  className="font-display tracking-[0.08em] text-[#ececec]/60"
                  style={{ fontSize: 17 * k }}
                >
                  MAX COMBO
                </span>
                <span className="text-right font-display font-bold" style={{ fontSize: 22 * k }}>
                  {telemetry.maxCombo}
                </span>
              </div>
            </div>
          </>
        )}

        {!full && stats && (
          <>
            <div style={{ marginTop: 34 * k }}>
              <Label k={k}>REMAINING</Label>
            </div>
            <div className="flex items-baseline" style={{ gap: 12 * k, marginTop: 2 * k }}>
              <span className="font-display leading-none font-bold" style={{ fontSize: 50 * k }}>
                {fmtTime(len - telemetry.elapsed)}
              </span>
              <span className="text-[#ececec]/35" style={{ fontSize: 14 * k }}>
                of {fmtTime(len)}
              </span>
            </div>
          </>
        )}
      </div>

      {/* One bottom strip. Replaces the song panel AND the buttons that were
          drawn on top of the score panel. */}
      <div
        className="pointer-events-auto absolute inset-x-0 bottom-0 flex items-center bg-black/[.86]"
        style={{ height: barH, gap: 24 * k, paddingLeft: 24 * k, paddingRight: 24 * k }}
      >
        <div className="absolute inset-x-0 top-0 bg-white/10" style={{ height: 4 * k }} />
        <div
          className="absolute top-0 left-0"
          style={{ height: 4 * k, width: `${progress * 100}%`, background: AC }}
        />
        <span className="font-display font-bold whitespace-nowrap" style={{ fontSize: 24 * k }}>
          {song.displayFullTitle || 'Untitled'}
        </span>
        <span className="truncate text-[#ececec]/55" style={{ fontSize: 16 * k }}>
          {song.artist}
        </span>
        <span
          className="font-display font-bold tracking-[0.1em] whitespace-nowrap"
          style={{
            fontSize: 14 * k,
            color: '#0b0c0e',
            background: difficultyColor(diffName),
            padding: `${3 * k}px ${10 * k}px`,
          }}
        >
          {diffName.toUpperCase()} {chart.meter}
        </span>
        {musicRate !== 1 && (
          <span className="whitespace-nowrap text-[#ffcf3d]" style={{ fontSize: 15 * k }}>
            ×{musicRate.toFixed(2)}
          </span>
        )}
        {practiceNote && (
          <span
            className="whitespace-nowrap border px-2 py-0.5 tracking-[0.14em]"
            style={{ fontSize: 13 * k, color: AC, borderColor: AC }}
          >
            {practiceNote}
          </span>
        )}
        <span className="flex-1" />
        <span
          className="flex items-center font-display tracking-[0.14em] whitespace-nowrap text-[#ececec]/45"
          style={{ fontSize: 13 * k, gap: 9 * k }}
        >
          <span
            className="inline-flex items-center justify-center border border-white/[0.18] text-[#ececec]"
            style={{ minWidth: 26 * k, height: 22 * k, padding: `0 ${6 * k}px`, fontSize: 11 * k }}
          >
            SELECT
          </span>
          HOLD TO QUIT
        </span>
        <button
          onClick={onFullscreen}
          title="Fullscreen"
          className="border border-white/15 bg-white/[0.04] text-[#ececec]/70 hover:border-[#ff5d47] hover:text-[#ececec]"
          style={{ fontSize: 13 * k, padding: `${6 * k}px ${12 * k}px` }}
        >
          ⛶
        </button>
        <span
          className="tracking-[0.12em] whitespace-nowrap text-[#ececec]/30"
          style={{ fontSize: 12 * k }}
        >
          {fps} FPS
        </span>
      </div>
    </div>
  );
}
