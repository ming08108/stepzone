/**
 * Chart info panel beside the song list (left of RANKS): the ITG-style note and
 * tech breakdown for the highlighted chart's current difficulty slot — a
 * notes-per-second density graph with peak NPS, the step/jump/hold/… tallies,
 * and Crossovers/Footswitches/Sideswitches/Jacks/Brackets. Read-only, takes no
 * focus, so pad navigation is untouched. Hides on narrow viewports (it needs the
 * width) and when no chart is highlighted.
 */
import { useEffect, useMemo, useState } from 'react';
import type { LibraryEntry } from '../io/songFiles';
import { computeChartStats, type ChartStats } from '../analysis/chartStats';
import type { Steps } from '../song/steps';
import { bestChartsPerSlot } from './difficultyUi';

const GRAPH_LO = '#00adc0';
const GRAPH_HI = '#8200a1';

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Filled area chart of the per-measure NPS series, time-proportional. */
function DensityGraph({ stats }: { stats: ChartStats }) {
  const bins = stats.nps;
  const path = useMemo(() => {
    if (bins.length === 0) return '';
    const t0 = bins[0].t0;
    const span = Math.max(0.001, bins[bins.length - 1].t1 - t0);
    const x = (t: number) => ((t - t0) / span) * 100;
    // Step outline across the top of each measure bar, then close along the floor.
    let d = `M 0 100`;
    for (const b of bins) {
      const y = 100 - b.h * 100;
      d += ` L ${x(b.t0).toFixed(2)} ${y.toFixed(2)} L ${x(b.t1).toFixed(2)} ${y.toFixed(2)}`;
    }
    d += ` L 100 100 Z`;
    return d;
  }, [bins]);

  return (
    <div className="relative h-[52px] w-full overflow-hidden rounded-[3px] bg-[#141c22]">
      {bins.length === 0 ? (
        <div className="flex h-full items-center justify-center text-[10px] tracking-[0.14em] text-[#ececec]/35">
          NO STREAMS
        </div>
      ) : (
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="npsfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={GRAPH_HI} />
              <stop offset="1" stopColor={GRAPH_LO} />
            </linearGradient>
          </defs>
          <path d={path} fill="url(#npsfill)" />
        </svg>
      )}
    </div>
  );
}

function Row({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="w-8 text-right font-bold tabular-nums text-[#ececec]">{n}</span>
      <span className="text-[#ececec]/55">{label}</span>
    </div>
  );
}

export function ChartStatsSide({ entry, diff }: { entry: LibraryEntry | null; diff: number }) {
  const chart = entry ? (bestChartsPerSlot(entry.song)[diff] ?? null) : null;

  // The full StepParity solver is heavy, so don't run it on every song the cursor
  // flies past — debounce until the selection settles. The panel keeps showing the
  // last computed stats meanwhile (and always reserves its width) so scrolling
  // never reflows the song table.
  const [settled, setSettled] = useState<{ entry: LibraryEntry | null; chart: Steps | null }>({
    entry,
    chart,
  });
  useEffect(() => {
    const id = setTimeout(() => setSettled({ entry, chart }), 130);
    return () => clearTimeout(id);
  }, [entry, chart]);

  const stats = useMemo<ChartStats | null>(() => {
    if (!settled.entry || !settled.chart) return null;
    try {
      const timing = settled.chart.getTimingData(settled.entry.song.timing);
      return computeChartStats(settled.chart.getNoteData(), timing, settled.chart.stepsType);
    } catch {
      return null;
    }
  }, [settled]);

  const t = stats?.tech ?? null;

  return (
    <div className="hidden w-[300px] flex-none flex-col gap-3 overflow-hidden border-l border-white/[0.09] px-[18px] py-3 min-[1400px]:flex">
      {!stats ? (
        <div className="flex flex-1 items-center justify-center text-[11px] tracking-[0.2em] text-[#ececec]/25">
          …
        </div>
      ) : (
        <ChartStatsBody stats={stats} t={t} />
      )}
    </div>
  );
}

function ChartStatsBody({ stats, t }: { stats: ChartStats; t: ChartStats['tech'] }) {
  return (
    <>
      <div className="flex flex-none items-baseline gap-3">
        <span className="text-[11px] tracking-[0.2em] text-[#ececec]/40">STATS</span>
        <span className="h-px flex-1 bg-white/[0.07]" />
        <span className="text-[11px] tracking-[0.1em] text-[#ececec]/55">
          {stats.peakNps.toFixed(1)} peak
        </span>
      </div>

      <DensityGraph stats={stats} />
      <div className="flex justify-between text-[10px] tracking-[0.12em] text-[#ececec]/40">
        <span>NPS</span>
        <span>{fmtTime(stats.lengthSeconds)}</span>
      </div>

      {t && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-[3px] border-t border-white/[0.06] pt-2 text-[13px]">
          <Row n={t.crossovers} label="Crossovers" />
          <Row n={t.footswitches} label="Footswitches" />
          <Row n={t.sideswitches} label="Sideswitches" />
          <Row n={t.jacks} label="Jacks" />
          <Row n={t.brackets} label="Brackets" />
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-[3px] border-t border-white/[0.06] pt-2 text-[13px]">
        <Row n={stats.steps} label="Steps" />
        <Row n={stats.mines} label="Mines" />
        <Row n={stats.jumps} label="Jumps" />
        <Row n={stats.hands} label="Hands" />
        <Row n={stats.holds} label="Holds" />
        <Row n={stats.rolls} label="Rolls" />
        {stats.lifts > 0 && <Row n={stats.lifts} label="Lifts" />}
        {stats.fakes > 0 && <Row n={stats.fakes} label="Fakes" />}
      </div>
    </>
  );
}
