/**
 * The pre-song wait (design 6c) — GPU init, audio decode and sprite prewarm
 * take several seconds, and the old splash spent them on a blinking LOADING….
 * This one briefs the player instead: the chart's density with the hardest
 * passage marked, the tallies, your PB as an explicit target, the rank a small
 * improvement would take, and — at the moment you could still notice a mod
 * left on from last session — the exact settings you're about to play under.
 *
 * All of it is data the app already has: computeChartStats (song select makes
 * the same call), the stored ChartScore, and the leaderboard fetch (cached in
 * useLeaderboard's store; here a one-shot fetch). The progress bar is fed by
 * GameSession.onLoadStage.
 */
import { useEffect, useMemo, useState } from 'react';
import { computeChartStats } from '../analysis/chartStats';
import { chartKey, loadScores } from '../app/scores';
import { fetchLeaderboard } from '../net/leaderboard';
import type { LeaderboardResponse } from '../net/protocol';
import type { Settings } from '../app/settings';
import { difficultyToString } from '../song/difficulty';
import type { Song } from '../song/song';
import type { Steps } from '../song/steps';
import { difficultyColor } from './difficultyUi';

const AC = '#ff5d47';

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

/** The settings line — the last chance to catch a mod left on from last time. */
export function modsLine(s: Settings, effRate: number): string {
  const parts = [
    s.scrollMode === 'X'
      ? `XMOD ${s.scrollValue.toFixed(2)}`
      : `${s.scrollMode}MOD ${Math.round(s.scrollValue)}`,
  ];
  if (s.turn !== 'none') parts.push(s.turn.toUpperCase());
  if (s.reverse) parts.push('REVERSE');
  if (s.noteSkin !== 'arcade') parts.push('SIMPLY LOVE');
  parts.push(`BG ${s.bgMode.toUpperCase()}`);
  parts.push(`×${effRate.toFixed(2)}`);
  return parts.join(' · ');
}

export function LoadingSplash({
  song,
  chart,
  pack,
  settings,
  effRate,
  stage,
  frac,
  statusOverride,
}: {
  song: Song;
  chart: Steps;
  pack?: string | null;
  settings: Settings;
  effRate: number;
  /** Current load stage name from GameSession.onLoadStage. */
  stage: string;
  /** 0..1 progress estimate for the bar. */
  frac: number;
  /** Replaces the stage line (e.g. "SYNCING WITH THE ROOM…"). */
  statusOverride?: string | null;
}) {
  const stats = useMemo(() => {
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

  const pb = useMemo(() => loadScores()[chartKey(song, chart)] ?? null, [song, chart]);

  const [board, setBoard] = useState<LeaderboardResponse | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchLeaderboard(chartKey(song, chart), effRate, 10).then((b) => {
      if (alive && b) setBoard(b);
    });
    return () => {
      alive = false;
    };
  }, [song, chart, effRate]);

  // The hardest passage: the run of adjacent near-peak measures around the max.
  const peak = useMemo(() => {
    if (!stats || stats.nps.length === 0) return null;
    let maxI = 0;
    for (let i = 1; i < stats.nps.length; i++) if (stats.nps[i].h > stats.nps[maxI].h) maxI = i;
    let a = maxI;
    let b = maxI;
    while (a > 0 && stats.nps[a - 1].h >= 0.8) a--;
    while (b < stats.nps.length - 1 && stats.nps[b + 1].h >= 0.8) b++;
    // Bins start at the first measure WITH a note — offset by the lead-in.
    return { a, b, measure: stats.firstMeasure + maxI + 1 };
  }, [stats]);

  // The rank just above your PB — what a small improvement buys.
  const nextRank = useMemo(() => {
    if (!board || !pb) return null;
    const above = [...board.rows].reverse().find((r) => r.percent > pb.percent);
    return above ?? null;
  }, [board, pb]);

  const diffName = difficultyToString(chart.difficulty);
  const dcolor = difficultyColor(diffName);
  const title = song.displayFullTitle || 'Untitled';
  const meta = [song.artist || '—', stats ? `${fmtTime(stats.lengthSeconds)}` : null, pack || null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className="absolute inset-0 z-[2] flex flex-col text-[#ececec] backdrop-blur-[2px]"
      style={{ background: 'rgba(5,6,8,.82)' }}
    >
      <div className="mx-auto flex h-full w-full max-w-[1700px] flex-col px-[6%] pt-[10vh] pb-[8vh]">
        <div className="font-display text-[13px] tracking-[0.34em] text-[#ececec]/40">
          NOW PLAYING
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-6">
          <div className="font-display text-[min(4.5vw,72px)] leading-none font-bold">{title}</div>
          <div
            className="mb-1 font-display text-[16px] font-bold tracking-[0.1em] whitespace-nowrap"
            style={{ color: '#0b0c0e', background: dcolor, padding: '5px 13px' }}
          >
            {diffName.toUpperCase()} {chart.meter}
          </div>
        </div>
        <div className="mt-2 text-[19px] text-[#ececec]/55">{meta}</div>

        <div className="mt-[6vh] flex min-h-0 flex-1 gap-[5%]">
          <div className="min-w-0 flex-[3]">
            <div className="flex items-baseline gap-3">
              <span className="font-display text-[11px] tracking-[0.24em] text-[#ececec]/35">
                WHAT YOU&apos;RE ABOUT TO PLAY
              </span>
              <span className="h-px flex-1 bg-white/[0.07]" />
              {stats && peak && (
                <span className="text-[13px] text-[#ececec]/50">
                  peak {stats.peakNps.toFixed(1)} NPS at M{peak.measure}
                </span>
              )}
            </div>
            {stats && (
              <div className="relative mt-3 flex h-[120px] items-end gap-[2px]">
                {stats.nps.map((b, i) => (
                  <div
                    key={i}
                    className="min-w-0 flex-1"
                    style={{
                      height: `${Math.round(8 + 92 * b.h)}%`,
                      // Same density buckets as the in-play chart timeline.
                      background: b.h > 0.8 ? '#8200a1' : b.h > 0.55 ? '#4a5fb0' : '#00adc0',
                    }}
                  />
                ))}
                {peak && (
                  <div
                    className="absolute -top-[6px] -bottom-[6px]"
                    style={{
                      left: `${(peak.a / stats.nps.length) * 100}%`,
                      right: `${(1 - (peak.b + 1) / stats.nps.length) * 100}%`,
                      boxShadow: 'inset 0 0 0 2px rgba(255,93,71,.6)',
                    }}
                  />
                )}
              </div>
            )}
            {stats && (
              <div className="mt-5 flex flex-wrap gap-x-7 gap-y-2 text-[15px]">
                {(
                  [
                    [stats.steps, 'steps'],
                    [stats.jumps, 'jumps'],
                    [stats.holds, 'holds'],
                    ...(stats.tech
                      ? ([
                          [stats.tech.crossovers, 'crossovers'],
                          [stats.tech.jacks, 'jacks'],
                        ] as const)
                      : []),
                  ] as const
                ).map(([n, label]) => (
                  <span key={label} className="flex items-baseline gap-2">
                    <span className="font-display text-[21px] font-bold tabular-nums">{n}</span>
                    <span className="text-[#ececec]/45">{label}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-[2]">
            <div className="font-display text-[11px] tracking-[0.24em] text-[#ececec]/35">
              YOUR TARGET
            </div>
            <div className="mt-3 flex flex-col gap-4">
              {pb ? (
                <div>
                  <div className="text-[12px] tracking-[0.18em] text-[#ececec]/35">BEAT THIS</div>
                  <div className="font-display text-[40px] leading-[1.1] font-bold text-[#59f07f] tabular-nums">
                    {(pb.percent * 100).toFixed(2)}%
                  </div>
                  <div className="text-[14px] text-[#ececec]/45">
                    your best · {pb.plays} play{pb.plays === 1 ? '' : 's'}
                  </div>
                </div>
              ) : (
                <div>
                  <div className="text-[12px] tracking-[0.18em] text-[#ececec]/35">FIRST TRY</div>
                  <div className="font-display text-[24px] font-bold text-[#ececec]/80">
                    No record on this chart yet — set one.
                  </div>
                </div>
              )}
              {nextRank && pb && (
                <div>
                  <div className="text-[12px] tracking-[0.18em] text-[#ececec]/35">
                    NEXT RANK AT
                  </div>
                  <div className="font-display text-[28px] leading-[1.1] font-bold text-[#ffcf3d] tabular-nums">
                    {(nextRank.percent * 100).toFixed(2)}%
                  </div>
                  <div className="text-[14px] text-[#ececec]/45">
                    +{((nextRank.percent - pb.percent) * 100).toFixed(2)} puts you past{' '}
                    {nextRank.playerName}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-auto">
          <div className="flex items-baseline gap-4">
            <span className="font-display text-[15px] tracking-[0.16em]" style={{ color: AC }}>
              {statusOverride ?? stage}
            </span>
            <span className="flex-1" />
            <span className="font-display text-[20px] font-bold tabular-nums">
              {Math.round(Math.max(0, Math.min(1, frac)) * 100)}%
            </span>
          </div>
          <div className="relative mt-3 h-[9px] bg-white/10">
            <div
              className="absolute top-0 bottom-0 left-0 transition-[width] duration-300"
              style={{
                width: `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`,
                background: AC,
              }}
            />
          </div>
          <div className="mt-5 font-display text-[14px] tracking-[0.2em] text-[#ececec]/45">
            {modsLine(settings, effRate)}
          </div>
        </div>
      </div>
    </div>
  );
}
