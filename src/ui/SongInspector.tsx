/**
 * The inspector — the right pane. Everything about the ONE chart you are about
 * to play, in the order you need it: what it is, which difficulty is armed,
 * how you've done, how hard it is, and the button.
 *
 * The old screen scattered this across three places (a 176px header band, a
 * chip stack, and a right column that only appeared above 1100px), so reading
 * "what am I about to start" meant three saccades. The one thing it adds is the
 * difficulty ladder: five slots side by side, sized and colored by
 * difficultyUi's own palette, with the armed slot physically larger — so ◀▶
 * finally has a visible target, and the level you're about to play is repeated
 * on the START button.
 *
 * Data comes from the same hooks the old panels used (useLeaderboard,
 * computeChartStats), so nothing new is fetched or computed.
 */
import { useEffect, useMemo, useState } from 'react';
import { computeChartStats, type ChartStats } from '../analysis/chartStats';
import type { LibraryEntry } from '../io/songFiles';
import { getIdentity } from '../net/identity';
import type { Steps } from '../song/steps';
import { bestChartsPerSlot, DIFF_SLOT_COLORS, DIFF_SLOT_NAMES } from './difficultyUi';
import { useLeaderboard } from './useLeaderboard';
import { useSettings } from './SettingsContext';
import { initials, type SongVM } from './songSelectModel';
import {
  AC,
  artGradient,
  CLEAR_GLYPH,
  CLEAR_LABEL,
  clearState,
  FAV_CLR,
  type ClearState,
} from './songSelectUi';

const SHORT = ['BEG', 'EASY', 'MED', 'HARD', 'EXPERT'] as const;

/** Clear-state chip inks. Brighter than the row-glyph CLEAR_COLORs on purpose:
 *  the chip sits over banner art, and 'never' at 28% ink was unreadable there.
 *  (Rings are pre-mixed rgba because CLEAR_COLOR['never'] is itself rgba — a
 *  hex-suffix alpha like `${c}66` silently breaks on it.) */
const PILL_INK: Record<ClearState, string> = {
  cleared: '#59f07f',
  tried: '#ffcf3d',
  never: 'rgba(236,236,236,.75)',
};
const PILL_RING: Record<ClearState, string> = {
  cleared: 'rgba(89,240,127,.4)',
  tried: 'rgba(255,207,61,.4)',
  never: 'rgba(236,236,236,.25)',
};
const GRAPH_LO = '#00adc0';
const GRAPH_HI = '#8200a1';

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Debounced chart stats — the StepParity solver is heavy, so it never runs on
 *  songs the cursor merely flies past (same policy as the old ChartStatsSide). */
function useChartStats(entry: LibraryEntry | null, diff: number) {
  const chart = entry ? (bestChartsPerSlot(entry.song)[diff] ?? null) : null;
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

  const current = settled.entry === entry && settled.chart === chart;
  return { stats: current ? stats : null, chart, computing: !current && chart != null };
}

function DensityGraph({ stats }: { stats: ChartStats }) {
  const path = useMemo(() => {
    const bins = stats.nps;
    if (bins.length === 0) return '';
    const t0 = bins[0].t0;
    const span = Math.max(0.001, bins[bins.length - 1].t1 - t0);
    const x = (t: number) => ((t - t0) / span) * 100;
    let d = `M 0 100`;
    for (const b of bins) {
      const y = 100 - b.h * 100;
      d += ` L ${x(b.t0).toFixed(2)} ${y.toFixed(2)} L ${x(b.t1).toFixed(2)} ${y.toFixed(2)}`;
    }
    return d + ` L 100 100 Z`;
  }, [stats]);

  return (
    <div className="relative h-[48px] w-full overflow-hidden bg-[#141c22]">
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="nps-inspector" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={GRAPH_HI} />
            <stop offset="1" stopColor={GRAPH_LO} />
          </linearGradient>
        </defs>
        <path d={path} fill="url(#nps-inspector)" />
      </svg>
    </div>
  );
}

function Tally({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex gap-[7px] text-[13px]">
      <span className="w-[34px] text-right font-bold tabular-nums">{n}</span>
      <span className="text-[#ececec]/50">{label}</span>
    </div>
  );
}

function SectionLabel({ children, right }: { children: string; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline gap-[10px]">
      <span className="font-display text-[10px] tracking-[0.24em] text-[#ececec]/35">
        {children}
      </span>
      <span className="h-px flex-1 bg-white/[0.07]" />
      {right}
    </div>
  );
}

export function SongInspector({
  vm,
  entry,
  diff,
  isFav,
  bannerUrl,
  onPickDiff,
  onPlay,
}: {
  vm: SongVM | null;
  entry: LibraryEntry | null;
  diff: number;
  isFav: boolean;
  bannerUrl: string | null;
  onPickDiff: (slot: number) => void;
  onPlay: () => void;
}) {
  const board = useLeaderboard(entry, diff);
  const { settings } = useSettings();
  const { stats, chart, computing } = useChartStats(entry, diff);

  const best = vm?.bests[diff] ?? null;
  const state = vm ? clearState(vm, diff) : 'never';
  const me = getIdentity().playerId;
  const rows = board === 'loading' || board === 'offline' ? [] : board.rows;
  const top = rows[0] ?? null;
  const mine = rows.find((r) => r.playerId === me) ?? null;
  const playable = vm != null && vm.levels[diff] != null;

  return (
    // Hidden below ~1100px — the fixed rail + inspector would otherwise crush
    // the song list to nothing (the old side column had the same guard).
    <div className="hidden w-[372px] flex-none flex-col overflow-hidden border-l border-white/[0.09] bg-[#0e0f12] min-[1100px]:flex">
      {/* Identity */}
      <div className="relative h-[118px] flex-none overflow-hidden border-b border-white/[0.09]">
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={
            bannerUrl
              ? { backgroundImage: `url(${bannerUrl})` }
              : { background: artGradient(vm?.title ?? '') }
          }
        />
        {/* Banner-less songs get an initials monogram over the gradient (the
            1b mock's "DH" block), so the header still reads as THIS song.
            Centered in the band ABOVE the title/scrim so the two never collide. */}
        {!bannerUrl && vm && (
          <div className="absolute inset-x-0 top-[6px] bottom-[56px] flex items-center justify-center">
            <span className="font-display text-[28px] font-bold tracking-[0.1em] text-white/55">
              {initials(vm.title)}
            </span>
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0e0f12] via-[#0e0f12]/40 to-transparent" />
        <div className="absolute right-[20px] bottom-[12px] left-[20px]">
          <div className="flex items-center gap-2">
            <span
              className="text-[16px]"
              style={{ color: isFav ? FAV_CLR : 'rgba(236,236,236,.3)' }}
            >
              {isFav ? '★' : '☆'}
            </span>
            <span className="truncate font-display text-[25px] font-bold">{vm?.title ?? '—'}</span>
          </div>
          <div className="truncate text-[13px] text-[#ececec]/60">
            {[
              vm?.artist,
              vm?.bpm ? `${vm.bpm} BPM` : null,
              stats ? fmtTime(stats.lengthSeconds) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        {/* Clear-state chip: solid dark bed + glyph so it stays legible over
            ANY banner art (the border-only version vanished on bright art). */}
        <span
          className="absolute top-[12px] right-[16px] flex items-center gap-[6px] px-[8px] py-[3px] font-display text-[10px] font-semibold tracking-[0.14em] backdrop-blur-[3px]"
          style={{
            color: PILL_INK[state],
            background: 'rgba(8,9,12,.78)',
            boxShadow: `inset 0 0 0 1px ${PILL_RING[state]}`,
            borderLeft: `2px solid ${PILL_INK[state]}`,
          }}
        >
          <span className="text-[11px] leading-none">{CLEAR_GLYPH[state]}</span>
          {CLEAR_LABEL[state]}
        </span>
      </div>

      {/* Difficulty ladder — the target for ◀▶ */}
      <div className="px-[20px] pt-[16px] pb-[6px] font-display text-[10px] tracking-[0.24em] text-[#ececec]/35">
        DIFFICULTY ◀ ▶
      </div>
      <div className="flex gap-[6px] px-[20px]">
        {DIFF_SLOT_NAMES.map((_, i) => {
          const lv = vm?.levels[i];
          const has = lv != null;
          const on = i === diff;
          return (
            <button
              key={i}
              disabled={!has}
              onClick={() => onPickDiff(i)}
              className="flex flex-col items-center gap-[4px]"
              style={{
                flex: on ? 1.25 : 1,
                padding: on ? '10px 0 9px' : '8px 0 7px',
                borderTop: `3px solid ${DIFF_SLOT_COLORS[i]}`,
                background: on ? `${DIFF_SLOT_COLORS[i]}29` : 'rgba(255,255,255,.03)',
                boxShadow: on ? `inset 0 0 0 1px ${DIFF_SLOT_COLORS[i]}80` : 'none',
                opacity: has ? (on ? 1 : 0.55) : 0.22,
              }}
            >
              <span
                className="font-display font-bold tabular-nums"
                style={{ fontSize: on ? 26 : 20, lineHeight: 1, color: on ? '#fff' : '#ececec' }}
              >
                {has ? lv : '–'}
              </span>
              <span
                className="text-[9px] tracking-[0.1em]"
                style={{ color: on ? DIFF_SLOT_COLORS[i] : 'rgba(236,236,236,.5)' }}
              >
                {SHORT[i]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Your best vs world */}
      <div className="mx-[20px] mt-[14px] grid grid-cols-2 gap-px bg-white/[0.07]">
        <div className="bg-[#0e0f12] px-[12px] py-[9px]">
          <div className="text-[10px] tracking-[0.18em] text-[#ececec]/35">YOUR BEST</div>
          <div
            className="font-display text-[21px] font-bold tabular-nums"
            style={{ color: best ? '#59f07f' : 'rgba(236,236,236,.3)' }}
          >
            {best ? `${(best.percent * 100).toFixed(2)}%` : '—'}{' '}
            {best && <span className="text-[14px]">{best.grade}</span>}
          </div>
        </div>
        <div className="bg-[#0e0f12] px-[12px] py-[9px]">
          <div className="text-[10px] tracking-[0.18em] text-[#ececec]/35">
            WORLD{mine && top && mine.playerId !== top.playerId ? ` · YOU #${mine.rank}` : ''}
            {settings.musicRate !== 1 ? ` · ${settings.musicRate.toFixed(2)}x` : ''}
          </div>
          <div className="truncate font-display text-[21px] font-bold text-[#ffcf3d] tabular-nums">
            {top ? `${(top.percent * 100).toFixed(2)}%` : '—'}{' '}
            {top && (
              <span className="text-[12px] text-[#ececec]/50">
                {top.playerId === me ? 'YOU' : top.playerName}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Ranks */}
      {rows.length > 0 && (
        <div className="px-[20px] pt-[16px]">
          <SectionLabel
            right={
              board !== 'loading' && board !== 'offline' && board.total > rows.length ? (
                <span className="text-[11px] text-[#ececec]/40 tabular-nums">
                  {board.total} PLAYERS
                </span>
              ) : undefined
            }
          >
            RANKS
          </SectionLabel>
          {rows.slice(0, 5).map((r) => {
            const isMe = r.playerId === me;
            return (
              <div
                key={r.playerId}
                className="grid grid-cols-[28px_1fr_66px_26px] items-center gap-1.5 border-b border-white/[0.05] py-[5px] text-[13px]"
                style={isMe ? { color: '#59f07f' } : undefined}
              >
                <span className="font-bold opacity-70 tabular-nums">#{r.rank}</span>
                <span className="min-w-0 truncate">
                  {r.playerName}
                  {isMe ? ' ★' : ''}
                </span>
                <span className="text-right font-bold tabular-nums">
                  {(r.percent * 100).toFixed(2)}%
                </span>
                <span className="text-right opacity-70">{r.grade}</span>
              </div>
            );
          })}
          {mine && mine.rank > 5 && (
            <div
              className="grid grid-cols-[28px_1fr_66px_26px] items-center gap-1.5 border-b border-white/[0.05] py-[5px] text-[13px]"
              style={{ color: '#59f07f' }}
            >
              <span className="font-bold opacity-70 tabular-nums">#{mine.rank}</span>
              <span className="min-w-0 truncate">{mine.playerName} ★</span>
              <span className="text-right font-bold tabular-nums">
                {(mine.percent * 100).toFixed(2)}%
              </span>
              <span className="text-right opacity-70">{mine.grade}</span>
            </div>
          )}
        </div>
      )}

      {/* Density + tallies */}
      <div className="px-[20px] pt-[16px]">
        <SectionLabel
          right={
            stats ? (
              <span className="text-[11px] text-[#ececec]/55 tabular-nums">
                {stats.peakNps.toFixed(1)} peak NPS
              </span>
            ) : undefined
          }
        >
          DENSITY
        </SectionLabel>
        {stats ? (
          <DensityGraph stats={stats} />
        ) : (
          <div className="flex h-[48px] items-center justify-center bg-[#141c22] text-[10px] tracking-[0.22em] text-[#ececec]/30">
            {computing ? 'COMPUTING…' : chart ? 'NO STREAMS' : 'NO CHART'}
          </div>
        )}
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-x-[18px] gap-y-[4px] px-[20px] pt-[14px]">
          {stats.tech && (
            <>
              <Tally n={stats.tech.crossovers} label="Crossovers" />
              <Tally n={stats.tech.footswitches} label="Footswitches" />
              <Tally n={stats.tech.sideswitches} label="Sideswitches" />
              <Tally n={stats.tech.jacks} label="Jacks" />
              <Tally n={stats.tech.brackets} label="Brackets" />
            </>
          )}
          <Tally n={stats.steps} label="Steps" />
          <Tally n={stats.jumps} label="Jumps" />
          <Tally n={stats.holds} label="Holds" />
          <Tally n={stats.mines} label="Mines" />
          <Tally n={stats.hands} label="Hands" />
        </div>
      )}

      <span className="flex-1" />

      <div className="px-[20px] pb-[18px]">
        <button
          onClick={onPlay}
          disabled={!playable}
          className="flex h-[54px] w-full items-center justify-center gap-[12px] font-display text-[19px] font-bold tracking-[0.16em]"
          style={{
            background: playable ? AC : 'rgba(255,255,255,.06)',
            color: playable ? '#0b0c0e' : 'rgba(236,236,236,.35)',
          }}
        >
          <span>START</span>
          <span className="opacity-55">—</span>
          <span>
            {playable ? `PLAY ${DIFF_SLOT_NAMES[diff]} ${vm?.levels[diff]}` : 'NO CHART HERE'}
          </span>
        </button>
      </div>
    </div>
  );
}
