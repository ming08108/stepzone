/**
 * The results screen (design 5a "SCORECARD") — three columns instead of one
 * centred ribbon, and every number gets a comparison:
 *
 *  · VERDICT — the grade slams in beside the percent, with the delta against
 *    your previous best as the third-largest thing on screen, and ONE status
 *    block that says whether this score counted (submitted / local-only and
 *    why) instead of three scattered one-liners.
 *  · BREAKDOWN — each judgment tier shows its count, its share, and the
 *    percent it cost you (counts × tapDancePoints, the same weights the score
 *    uses), so "where did I leak points" has an answer — called out in a
 *    sentence when one tier dominates.
 *  · PROGRESS — your recent attempts on this chart (ChartScore.history) and
 *    the live leaderboard around you.
 *
 * The reveal is an arcade cascade of one-shot CSS animations (index.css);
 * prefers-reduced-motion collapses them globally.
 */
import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { chartKey, type ChartScore } from '../app/scores';
import { tapDancePoints } from '../gameplay/scoring';
import { fetchLeaderboard } from '../net/leaderboard';
import { getIdentity } from '../net/identity';
import type { LeaderboardResponse, ReplayEvent } from '../net/protocol';
import { HoldNoteScore, TapNoteScore } from '../notes/noteTypes';
import { difficultyToString } from '../song/difficulty';
import type { Song } from '../song/song';
import type { Steps } from '../song/steps';
import { difficultyColor } from './difficultyUi';
import { gradeColor, TimingBar } from './hud/PlayHud';
import { useSettings } from './SettingsContext';

const AC = '#ff5d47';

export interface Result {
  percent: number;
  grade: string;
  maxCombo: number;
  failed: boolean;
  counts: Record<number, number>;
  holdCounts: Record<number, number>;
  best: ChartScore | null;
  isNewRecord: boolean;
  offsets: number[];
  /** This run used a keyboard for notes, so it was held back from the board. */
  keyboardBlocked: boolean;
  /** These results are from watching a replay, not a fresh play. */
  isReplay: boolean;
}

/** ITG wording + tier colours (matches the in-play HUD tally). */
const TIERS: Array<[TapNoteScore, string, string]> = [
  [TapNoteScore.W1, 'FANTASTIC', '#38f0ff'],
  [TapNoteScore.W2, 'EXCELLENT', '#ffd23d'],
  [TapNoteScore.W3, 'GREAT', '#59f07f'],
  [TapNoteScore.W4, 'DECENT', '#c86bff'],
  [TapNoteScore.W5, 'WAY OFF', '#ff9d3d'],
  [TapNoteScore.Miss, 'MISS', '#ff5d47'],
];

const MAX_TAP = tapDancePoints(TapNoteScore.W1);

function SectionLabel({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-[10px]">
      <span className="font-display text-[10px] tracking-[0.24em] text-[#ececec]/35">
        {children}
      </span>
      <span className="h-px flex-1 bg-white/[0.07]" />
      {right}
    </div>
  );
}

const BTN_OUTLINE =
  'flex h-[52px] cursor-pointer items-center justify-center px-[24px] font-display text-[14px] tracking-[0.12em] text-[#ececec]/80 outline-none hover:text-[#ececec]';

export function Results({
  song,
  chart,
  result,
  pbPercent,
  effRate,
  isVersus,
  isPractice,
  doneSel,
  ctaRef,
  retryRef,
  watchReplayRef,
  onContinue,
  onRetry,
  onWatchReplay,
  lastReplay,
  children,
}: {
  song: Song;
  chart: Steps;
  result: Result;
  /** Your stored best BEFORE this run (0..1), or null. */
  pbPercent: number | null;
  effRate: number;
  isVersus: boolean;
  isPractice: boolean;
  doneSel: number;
  ctaRef: RefObject<HTMLButtonElement>;
  retryRef: RefObject<HTMLButtonElement>;
  watchReplayRef: RefObject<HTMLButtonElement>;
  onContinue: () => void;
  onRetry: () => void;
  onWatchReplay: (events: ReplayEvent[]) => void;
  lastReplay: ReplayEvent[];
  /** Versus: the standings block, rendered in place of the breakdown. */
  children?: ReactNode;
}) {
  const { settings } = useSettings();
  const gc = gradeColor(result.grade);
  const pct = result.percent * 100;
  const delta = pbPercent == null ? null : pct - pbPercent * 100;

  /* ── submission status, in one block ─────────────────────────────────── */
  const submitted = !result.isReplay && !result.keyboardBlocked && !isPractice;
  const caveat = result.isReplay
    ? 'REPLAY — NOTHING RECORDED'
    : isPractice
      ? 'PRACTICE SECTION — SCORE NOT SAVED'
      : result.keyboardBlocked
        ? 'KEYBOARD PLAY — NOT SENT TO THE LEADERBOARD'
        : effRate !== 1
          ? `RATE ×${effRate.toFixed(2)} — LOCAL RECORD NOT SAVED`
          : null;

  /* ── leaderboard around you (fetched fresh — the submit just landed) ──── */
  const [board, setBoard] = useState<LeaderboardResponse | null>(null);
  useEffect(() => {
    if (isVersus) return;
    let alive = true;
    // Give the fire-and-forget submit a beat to land before reading the board.
    const t = setTimeout(() => {
      void fetchLeaderboard(chartKey(song, chart), effRate, 10).then((b) => {
        if (alive && b) setBoard(b);
      });
    }, 600);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [song, chart, effRate, isVersus]);
  const me = getIdentity().playerId;
  const myRow = board?.rows.find((r) => r.playerId === me) ?? null;

  /* ── the breakdown numbers ────────────────────────────────────────────── */
  const totalTaps = TIERS.reduce((a, [t]) => a + (result.counts[t] ?? 0), 0);
  const hitTaps = totalTaps - (result.counts[TapNoteScore.Miss] ?? 0);
  const holdsTotal =
    (result.holdCounts[HoldNoteScore.Held] ?? 0) +
    (result.holdCounts[HoldNoteScore.LetGo] ?? 0) +
    (result.holdCounts[HoldNoteScore.Missed] ?? 0);
  // Possible dance points, the denominator the % uses: every judged tap at W1
  // weight plus every hold at held weight (3 each — holdDancePoints(Held)).
  const possible = totalTaps * MAX_TAP + holdsTotal * 3;
  const lostPct = (tns: TapNoteScore) =>
    possible > 0
      ? (((result.counts[tns] ?? 0) * (MAX_TAP - tapDancePoints(tns))) / possible) * 100
      : 0;
  const biggestLeak = useMemo(() => {
    let best: { label: string; color: string; lost: number; n: number } | null = null;
    for (const [tns, label, color] of TIERS) {
      if (tns === TapNoteScore.W1) continue;
      const lost = lostPct(tns);
      if (lost > 0.05 && (!best || lost > best.lost)) {
        best = { label, color, lost, n: result.counts[tns] ?? 0 };
      }
    }
    return best;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
  const missLost = lostPct(TapNoteScore.Miss);

  /* ── timing summary + the concrete next step ──────────────────────────── */
  const recentMs = result.offsets.map((o) => o * 1000);
  const meanMs = recentMs.length ? recentMs.reduce((a, b) => a + b, 0) / recentMs.length : null;
  const suggest =
    meanMs != null && Math.abs(meanMs) > 5 ? Math.round(settings.audioOffsetMs - meanMs) : null;

  /* ── attempt history (this run included — recordPlay appended it) ─────── */
  const history = result.best?.history ?? [];
  const shown = history.slice(-8);
  const histLo = Math.min(...shown, result.percent) * 100 - 1;
  const histHi = Math.max(...shown, result.percent) * 100 + 0.4;

  const diffName = difficultyToString(chart.difficulty);

  return (
    <div
      className="absolute inset-0 z-[2] flex flex-col overflow-hidden text-[#ececec] backdrop-blur-[2px] [font-variant-numeric:tabular-nums]"
      style={{ background: 'rgba(5,6,8,.88)' }}
    >
      {/* Header band */}
      <div
        className="mx-auto flex w-full max-w-[1780px] flex-none items-baseline gap-5 px-[4%] pt-[40px]"
        style={{ animation: 'dropIn 460ms cubic-bezier(.2,.8,.3,1) 100ms both' }}
      >
        <span className="font-display text-[14px] tracking-[0.32em] text-[#ececec]/50">
          RESULTS
        </span>
        <span className="flex-1" />
        <span className="truncate font-display text-[19px] font-bold">
          {song.displayFullTitle || 'Untitled'}
        </span>
        <span className="text-[13px] whitespace-nowrap text-[#ececec]/50">{song.artist}</span>
        <span
          className="font-display text-[12px] font-bold tracking-[0.1em] whitespace-nowrap"
          style={{ color: '#0b0c0e', background: difficultyColor(diffName), padding: '3px 10px' }}
        >
          {diffName.toUpperCase()} {chart.meter}
        </span>
      </div>

      <div className="mx-auto flex w-full max-w-[1780px] min-h-0 flex-1 gap-[3%] overflow-y-auto px-[4%] pt-[30px] pb-[16px]">
        {/* ── VERDICT ─────────────────────────────────────────────────────── */}
        <div className="flex w-[30%] min-w-[380px] flex-none flex-col gap-[20px]">
          <div className="flex items-center gap-[26px]">
            <div
              className="flex h-[170px] min-w-[170px] items-center justify-center border-2"
              style={{
                borderColor: gc,
                background: `${gc}0d`,
                boxShadow: `0 0 60px ${gc}44, inset 0 0 34px ${gc}24`,
                animation: 'slamIn 460ms cubic-bezier(.2,.9,.3,1) 280ms both',
              }}
            >
              <span
                className="font-display leading-none font-bold"
                style={{
                  color: gc,
                  fontSize: result.grade.length > 2 ? 66 : 92,
                  textShadow: `0 0 30px ${gc}aa`,
                }}
              >
                {result.grade}
              </span>
            </div>
            <div className="flex flex-col items-start gap-[6px]">
              <div
                className="font-display text-[62px] leading-none font-bold"
                style={{ animation: 'popIn 420ms cubic-bezier(.2,1.1,.3,1) 420ms both' }}
              >
                {pct.toFixed(2)}
                <span className="text-[32px] text-[#ececec]/50">%</span>
              </div>
              <div
                className="font-display text-[17px] font-bold tracking-[0.24em]"
                style={{
                  color: result.failed ? AC : '#59f07f',
                  animation: 'fadeIn 320ms linear 700ms both',
                }}
              >
                {result.failed ? 'FAILED' : 'CLEARED'}
              </div>
              {delta != null ? (
                <div
                  className="mt-1 flex items-baseline gap-[10px] origin-left"
                  style={{ animation: 'popIn 420ms cubic-bezier(.2,1.1,.3,1) 1450ms both' }}
                >
                  <span
                    className="font-display text-[26px] font-bold"
                    style={{
                      color: delta >= 0 ? '#59f07f' : '#ff9d3d',
                      textShadow: delta >= 0 ? '0 0 22px rgba(89,240,127,.6)' : undefined,
                    }}
                  >
                    {delta >= 0 ? '▲ +' : '▼ '}
                    {delta.toFixed(2)}
                  </span>
                  <span className="text-[13px] text-[#ececec]/50">
                    on your best of {(pbPercent! * 100).toFixed(2)}%
                  </span>
                </div>
              ) : (
                <div
                  className="mt-1 text-[13px] tracking-[0.1em] text-[#ececec]/45"
                  style={{ animation: 'fadeIn 320ms linear 1450ms both' }}
                >
                  FIRST SCORE ON THIS CHART
                </div>
              )}
            </div>
          </div>

          {/* Whether this score counted — one status block, not three lines. */}
          <div
            className="flex items-center gap-[14px] px-[18px] py-[13px]"
            style={{
              background: caveat ? 'rgba(255,207,61,.07)' : 'rgba(89,240,127,.08)',
              boxShadow: caveat
                ? 'inset 0 0 0 1px rgba(255,207,61,.35)'
                : 'inset 0 0 0 1px rgba(89,240,127,.4)',
              animation: 'riseIn 440ms cubic-bezier(.2,.8,.3,1) 1600ms both',
            }}
          >
            <span className="text-[18px]" style={{ color: caveat ? '#ffcf3d' : '#59f07f' }}>
              {caveat ? '▲' : result.isNewRecord && !result.failed ? '★' : '✓'}
            </span>
            <div className="min-w-0 flex-1">
              <div
                className="font-display text-[14px] font-bold tracking-[0.12em]"
                style={{ color: caveat ? '#ffcf3d' : '#59f07f' }}
              >
                {caveat ??
                  (result.isNewRecord && !result.failed
                    ? 'NEW RECORD — SUBMITTED'
                    : 'SUBMITTED TO THE LEADERBOARD')}
              </div>
              {submitted && myRow && (
                <div className="mt-[2px] text-[12px] text-[#ececec]/60">
                  You are <span className="font-bold text-[#ececec]">#{myRow.rank}</span> of{' '}
                  {board?.total} on this chart.
                </div>
              )}
            </div>
          </div>

          {/* THIS RUN */}
          <div>
            <div className="font-display text-[10px] tracking-[0.24em] text-[#ececec]/35">
              THIS RUN
            </div>
            <div className="mt-[10px] grid grid-cols-3 gap-px bg-white/[0.07]">
              {(
                [
                  [
                    'MAX COMBO',
                    String(result.maxCombo),
                    `${result.counts[TapNoteScore.Miss] ?? 0} break${(result.counts[TapNoteScore.Miss] ?? 0) === 1 ? '' : 's'}`,
                    '#ececec',
                  ],
                  ['NOTES HIT', String(hitTaps), `of ${totalTaps}`, '#ececec'],
                  [
                    'AVG TIMING',
                    meanMs == null ? '—' : `${meanMs >= 0 ? '+' : ''}${meanMs.toFixed(1)}`,
                    meanMs == null
                      ? 'no taps'
                      : meanMs > 5
                        ? 'ms late'
                        : meanMs < -5
                          ? 'ms early'
                          : 'ms — on time',
                    meanMs != null && Math.abs(meanMs) > 5 ? '#ffcf3d' : '#ececec',
                  ],
                ] as const
              ).map(([label, value, note, color]) => (
                <div key={label} className="bg-[#050506] px-[13px] py-[11px]">
                  <div className="text-[10px] tracking-[0.18em] text-[#ececec]/35">{label}</div>
                  <div
                    className="mt-[3px] font-display text-[23px] font-bold tabular-nums"
                    style={{ color }}
                  >
                    {value}
                  </div>
                  <div className="text-[11px] text-[#ececec]/40">{note}</div>
                </div>
              ))}
            </div>
          </div>

          {/* TIMING — the same bar as the in-play HUD, plus the next step. */}
          <div>
            <SectionLabel
              right={
                meanMs != null ? (
                  <span
                    className="text-[12px]"
                    style={{ color: Math.abs(meanMs) > 5 ? '#ffcf3d' : '#59f07f' }}
                  >
                    avg {meanMs >= 0 ? '+' : ''}
                    {meanMs.toFixed(1)} ms {meanMs > 5 ? 'late' : meanMs < -5 ? 'early' : ''}
                  </span>
                ) : undefined
              }
            >
              TIMING
            </SectionLabel>
            <div className="mt-[10px]">
              <TimingBar recentMs={recentMs.slice(-60)} meanMs={meanMs} k={0.72} />
            </div>
            {suggest != null && (
              <div className="mt-[8px] text-[13px] text-[#ececec]/55">
                Nudging <span className="text-[#ececec]">AUDIO OFFSET</span> to {suggest} ms would
                centre you.
              </div>
            )}
          </div>
        </div>

        {/* ── BREAKDOWN (or the versus standings) ─────────────────────────── */}
        <div
          className="min-w-0 flex-1"
          style={{ animation: 'riseIn 440ms cubic-bezier(.2,.8,.3,1) 820ms both' }}
        >
          {isVersus ? (
            <div className="flex flex-col items-center pt-2">{children}</div>
          ) : (
            <div className="flex flex-col gap-[14px]">
              <div className="font-display text-[10px] tracking-[0.24em] text-[#ececec]/35">
                WHERE THE POINTS WENT
              </div>

              {totalTaps > 0 && (
                <div className="flex h-[13px] gap-px">
                  {TIERS.map(([tns, , color]) => {
                    const n = result.counts[tns] ?? 0;
                    if (n === 0) return null;
                    return (
                      <div
                        key={tns}
                        style={{ width: `${(n / totalTaps) * 100}%`, background: color }}
                      />
                    );
                  })}
                </div>
              )}

              <div>
                <div className="grid h-[26px] grid-cols-[1fr_88px_74px_104px] items-center gap-3 font-display text-[10px] tracking-[0.2em] text-[#ececec]/35">
                  <span />
                  <span className="text-right">COUNT</span>
                  <span className="text-right">SHARE</span>
                  <span className="text-right">% LOST</span>
                </div>
                {TIERS.map(([tns, label, color]) => {
                  const n = result.counts[tns] ?? 0;
                  const lost = lostPct(tns);
                  return (
                    <div
                      key={tns}
                      className="grid h-[42px] grid-cols-[1fr_88px_74px_104px] items-center gap-3 border-b border-white/[0.05]"
                    >
                      <span className="flex items-center gap-[10px]">
                        <span className="h-2 w-2" style={{ background: color }} />
                        <span
                          className="font-display text-[16px] font-semibold tracking-[0.08em]"
                          style={{ color }}
                        >
                          {label}
                        </span>
                      </span>
                      <span className="text-right font-display text-[20px] font-bold">{n}</span>
                      <span className="text-right text-[13px] text-[#ececec]/45">
                        {totalTaps > 0 ? `${((n / totalTaps) * 100).toFixed(1)}%` : '—'}
                      </span>
                      <span
                        className="text-right font-display text-[16px] font-bold"
                        style={{
                          color:
                            lost >= 1
                              ? '#c86bff'
                              : lost > 0
                                ? 'rgba(236,236,236,.7)'
                                : 'rgba(236,236,236,.3)',
                        }}
                      >
                        {lost > 0 ? lost.toFixed(2) : '—'}
                      </span>
                    </div>
                  );
                })}
                <div className="grid h-[42px] grid-cols-[1fr_88px_74px_104px] items-center gap-3 border-t border-white/20">
                  <span className="font-display text-[15px] tracking-[0.08em] text-[#ececec]/60">
                    MAX COMBO
                  </span>
                  <span className="text-right font-display text-[20px] font-bold">
                    {result.maxCombo}
                  </span>
                  <span className="text-right text-[13px] text-[#ececec]/45">
                    {result.counts[TapNoteScore.Miss] ?? 0} breaks
                  </span>
                  <span className="text-right font-display text-[16px] font-bold text-[#ececec]/50">
                    —
                  </span>
                </div>
              </div>

              {biggestLeak && (
                <div
                  className="px-[16px] py-[12px]"
                  style={{
                    background: 'rgba(200,107,255,.08)',
                    boxShadow: 'inset 0 0 0 1px rgba(200,107,255,.32)',
                  }}
                >
                  <div className="text-[13px] leading-[1.5] text-[#ececec]/75">
                    Your biggest leak is{' '}
                    <span className="font-bold" style={{ color: biggestLeak.color }}>
                      {biggestLeak.label}
                    </span>{' '}
                    — {biggestLeak.n} note{biggestLeak.n === 1 ? '' : 's'} cost you{' '}
                    <span className="font-bold text-[#ececec]">{biggestLeak.lost.toFixed(2)}%</span>
                    {biggestLeak.label !== 'MISS' && biggestLeak.lost > missLost
                      ? ` — more than your ${result.counts[TapNoteScore.Miss] ?? 0} misses did. That's a timing problem, not an accuracy one.`
                      : '.'}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── PROGRESS ────────────────────────────────────────────────────── */}
        {!isVersus && (
          <div
            className="flex w-[26%] min-w-[320px] flex-none flex-col gap-[22px]"
            style={{ animation: 'riseIn 440ms cubic-bezier(.2,.8,.3,1) 980ms both' }}
          >
            {shown.length > 1 && (
              <div>
                <SectionLabel>{`YOUR LAST ${shown.length} ATTEMPTS`}</SectionLabel>
                <div className="mt-[12px] flex h-[104px] items-end gap-2">
                  {shown.map((h, i) => {
                    const mine = i === shown.length - 1;
                    const frac = Math.max(
                      0.04,
                      (h * 100 - histLo) / Math.max(0.1, histHi - histLo),
                    );
                    return (
                      <div
                        key={i}
                        className="flex h-full flex-1 flex-col items-center justify-end gap-[5px]"
                      >
                        <span
                          className="text-[11px] font-bold tabular-nums"
                          style={{ color: mine ? AC : 'rgba(236,236,236,.45)' }}
                        >
                          {(h * 100).toFixed(2)}
                        </span>
                        <div
                          className="w-full"
                          style={{
                            height: `${frac * 100}%`,
                            background: mine ? AC : 'rgba(236,236,236,.22)',
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-[7px] text-[11px] text-[#ececec]/40">
                  Oldest on the left · this run in coral
                </div>
              </div>
            )}

            {board && board.rows.length > 0 && (
              <div>
                <SectionLabel
                  right={
                    <span className="text-[11px] text-[#ececec]/40 tabular-nums">
                      {board.total} PLAYERS
                    </span>
                  }
                >
                  LEADERBOARD
                </SectionLabel>
                <div className="mt-[10px]">
                  {board.rows.slice(0, 7).map((r) => {
                    const mine = r.playerId === me;
                    return (
                      <div
                        key={r.playerId}
                        className="grid h-[33px] grid-cols-[44px_1fr_86px_38px] items-center gap-2 border-b border-white/[0.05] px-[10px]"
                        style={
                          mine
                            ? {
                                background:
                                  'linear-gradient(90deg, rgba(89,240,127,.20), rgba(89,240,127,.04))',
                                boxShadow: 'inset 0 0 0 1px rgba(89,240,127,.5)',
                                color: '#59f07f',
                              }
                            : undefined
                        }
                      >
                        <span className="font-bold opacity-75 tabular-nums">#{r.rank}</span>
                        <span className="min-w-0 truncate text-[13px]">
                          {r.playerName}
                          {mine ? ' ★' : ''}
                        </span>
                        <span className="text-right font-display text-[14px] font-bold tabular-nums">
                          {(r.percent * 100).toFixed(2)}%
                        </span>
                        <span className="text-right text-[12px] opacity-70">{r.grade}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── ACTION BAR — real buttons, one filled primary ────────────────── */}
      <div
        className="flex h-[88px] flex-none items-center gap-[14px] border-t border-white/[0.09] bg-[#0e0f12] px-[4%]"
        style={{ animation: 'riseIn 440ms cubic-bezier(.2,.8,.3,1) 1750ms both' }}
      >
        <button
          ref={ctaRef}
          onClick={onContinue}
          className="flex h-[52px] cursor-pointer items-center justify-center px-[42px] font-display text-[17px] font-bold tracking-[0.2em] outline-none"
          style={{
            background: AC,
            color: '#0b0c0e',
            boxShadow: doneSel === 0 ? `0 0 0 2px #fff` : undefined,
          }}
        >
          CONTINUE ▸
        </button>
        {!isVersus && (
          <button
            ref={retryRef}
            onClick={onRetry}
            className={BTN_OUTLINE}
            style={{
              boxShadow:
                doneSel === 1
                  ? `inset 0 0 0 1px ${AC}, 0 0 20px ${AC}40`
                  : 'inset 0 0 0 1px rgba(255,255,255,.18)',
              color: doneSel === 1 ? '#ececec' : undefined,
            }}
          >
            RETRY
          </button>
        )}
        {!isVersus && !result.isReplay && (
          <button
            ref={watchReplayRef}
            onClick={() => onWatchReplay(lastReplay)}
            className={BTN_OUTLINE}
            style={{
              boxShadow:
                doneSel === 2
                  ? `inset 0 0 0 1px ${AC}, 0 0 20px ${AC}40`
                  : 'inset 0 0 0 1px rgba(255,255,255,.18)',
              color: doneSel === 2 ? '#ececec' : undefined,
            }}
          >
            WATCH REPLAY
          </button>
        )}
        <span className="flex-1" />
        {(
          [
            ['▲▼', 'ACTION'],
            ['START', 'CONFIRM'],
            ['SELECT', 'BACK TO SONGS'],
          ] as const
        ).map(([key, act]) => (
          <span
            key={key}
            className="flex items-center gap-[9px] pl-[22px] font-display text-[12px] tracking-[0.12em]"
          >
            <span className="inline-flex h-[22px] min-w-[26px] items-center justify-center border border-white/[0.18] px-[6px] text-[11px] text-[#ececec]">
              {key}
            </span>
            <span className="text-[#ececec]/55">{act}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
