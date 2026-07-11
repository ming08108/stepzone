/**
 * In-race room UI: the live rival readout stacked top-left during play
 * (RivalBars — one row per opponent, ahead/behind colored against you), and
 * the results-screen standings (RoomStandings — a ranked, animated reveal
 * from last place up to the winner, skippable with any confirm press).
 * Read-only DOM overlays on coarse ticks; judging and input never touch this.
 */
import { useEffect, useRef, useState } from 'react';
import type { GameSession } from '../game/session';
import type { PlayerState, RoomPeer } from '../net/roomPeer';
import { diffColor } from './DiffBadge';
import type { RoomPlayInfo } from './playRequest';

const TICK_MS = 150;
const AC = '#ff5d47';

interface RivalRow {
  id: number;
  label: string;
  percent: number;
  combo: number;
  diff: number;
  left: boolean;
  finished: boolean;
}

/** The live opponents readout — one compact row per rival, top-left. */
export function RivalBars({ session, versus }: { session: GameSession; versus: RoomPlayInfo }) {
  const [rows, setRows] = useState<RivalRow[]>([]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const you = session.judge.percentDancePoints;
      const players = new Map(versus.room.players.map((p) => [p.id, p]));
      setRows(
        versus.opponents.map((o) => {
          const p = players.get(o.id);
          const percent = p?.result?.percent ?? p?.snap?.percent ?? 0;
          return {
            id: o.id,
            label: `${o.name} · LV${o.pick.meter}`,
            percent,
            combo: p?.snap?.combo ?? 0,
            diff: you - percent,
            left: p?.left ?? true,
            finished: (p?.result ?? null) !== null,
          };
        }),
      );
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [session, versus]);

  if (rows.length === 0) return null;
  return (
    <div className="absolute left-4 top-4 z-[3] flex flex-col gap-1.5">
      {rows.map((r) => (
        <div
          key={r.id}
          className="border bg-black/45 px-3 py-1.5 text-[12px] tracking-[0.14em] text-[#ececec]/85"
          style={{ borderColor: r.left ? 'rgba(255,255,255,.2)' : diffColor(r.diff) + '66' }}
        >
          {r.left ? (
            <span className="text-[#ececec]/45">{r.label} — DISCONNECTED</span>
          ) : (
            <>
              {r.label} {(r.percent * 100).toFixed(2)}%{r.finished ? ' · DONE' : ` ×${r.combo}`}{' '}
              <span className="font-bold" style={{ color: diffColor(r.diff) }}>
                {r.diff >= 0 ? '+' : ''}
                {(r.diff * 100).toFixed(2)}%
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

interface StandingRow {
  id: number;
  name: string;
  meter: number | null;
  you: boolean;
  /** null = still playing (live percent shown from the snap instead). */
  result: { percent: number; grade: string; failed: boolean } | null;
  livePercent: number;
  left: boolean;
}

function standingRows(room: RoomPeer, selfId: number): StandingRow[] {
  const rows = room.players
    .filter((p) => p.result !== null || p.done || p.snap !== null || p.id === selfId || p.left)
    .map((p) => ({
      id: p.id,
      name: p.name,
      meter: p.pick?.meter ?? null,
      you: p.id === selfId,
      result: p.result
        ? { percent: p.result.percent, grade: p.result.grade, failed: p.result.failed }
        : null,
      livePercent: p.snap?.percent ?? 0,
      left: p.left && p.result === null,
    }));
  // Finished sort by percent; still-playing ride below by live percent; the
  // disconnected sit at the bottom.
  return rows.sort((a, b) => {
    if (a.left !== b.left) return a.left ? 1 : -1;
    const ap = a.result?.percent ?? -1 + a.livePercent; // unfinished under finished
    const bp = b.result?.percent ?? -1 + b.livePercent;
    return bp - ap;
  });
}

const REVEAL_STEP_MS = 550;
const REVEAL_ROW_MS = 450;

/**
 * Ranked standings with a skippable reveal: rows land last-place-first, each
 * sliding in with its percent bar filling; the winner lands last and pulses.
 * `skipSignal` increments to jump straight to the final table (Play routes
 * the first confirm press here); `onRevealed` reports when the show is over
 * so the next confirm can mean CONTINUE.
 */
export function RoomStandings({
  versus,
  skipSignal,
  onRevealed,
}: {
  versus: RoomPlayInfo;
  skipSignal: number;
  onRevealed: (done: boolean) => void;
}) {
  const room = versus.room;
  const rows = standingRows(room, room.selfId);
  const [skipped, setSkipped] = useState(false);
  const revealMs = rows.length * REVEAL_STEP_MS + REVEAL_ROW_MS;
  const [revealed, setRevealed] = useState(false);
  const onRevealedRef = useRef(onRevealed);
  onRevealedRef.current = onRevealed;

  useEffect(() => {
    if (skipSignal > 0) setSkipped(true);
  }, [skipSignal]);

  useEffect(() => {
    if (skipped || revealed) {
      setRevealed(true);
      onRevealedRef.current(true);
      return;
    }
    const t = window.setTimeout(() => {
      setRevealed(true);
      onRevealedRef.current(true);
    }, revealMs);
    return () => window.clearTimeout(t);
  }, [skipped, revealed, revealMs]);

  const final = skipped || revealed;
  const n = rows.length;
  return (
    <div className="w-[460px] max-w-full">
      <div className="mb-2 text-[13px] tracking-[0.3em] text-[#ececec]/60">STANDINGS</div>
      <div className="flex flex-col gap-1.5">
        {rows.map((r, rank) => {
          // Reveal order: last place first, winner last.
          const delayMs = (n - 1 - rank) * REVEAL_STEP_MS;
          const winner = rank === 0 && r.result !== null && !r.left;
          const pct = r.result?.percent ?? r.livePercent;
          const anim = final
            ? 'none'
            : `standingsIn ${REVEAL_ROW_MS}ms ${delayMs}ms cubic-bezier(.2,.9,.25,1) both`;
          return (
            <div
              key={r.id}
              className="relative overflow-hidden border px-4 py-2"
              style={{
                animation: anim,
                borderColor: winner ? AC : 'rgba(255,255,255,.14)',
                background: winner ? AC + '14' : 'rgba(0,0,0,.35)',
                boxShadow: winner && final ? `0 0 26px ${AC}55` : undefined,
              }}
            >
              {/* percent bar under the text */}
              <div
                className="absolute inset-y-0 left-0"
                style={{
                  width: `${Math.round(pct * 100)}%`,
                  background: r.you ? '#ffffff14' : '#ffffff0a',
                  transition: final ? undefined : `width 600ms ${delayMs + 150}ms ease-out`,
                }}
              />
              <div className="relative flex items-center gap-3 text-[15px] tracking-[0.08em]">
                <span className="w-7 flex-none font-black tabular-nums text-[#ececec]/55">
                  {r.left ? '—' : `${rank + 1}.`}
                </span>
                <span className={`min-w-0 flex-1 truncate${r.you ? ' font-bold' : ''}`}>
                  {r.name}
                  {r.you ? ' (YOU)' : ''}
                  {r.meter != null && <span className="text-[#ececec]/45"> · LV{r.meter}</span>}
                </span>
                {r.left ? (
                  <span className="text-[12px] tracking-[0.14em] text-[#ececec]/45">
                    DISCONNECTED
                  </span>
                ) : r.result ? (
                  <>
                    <span
                      className="text-[12px] font-bold tracking-[0.12em]"
                      style={{ color: r.result.failed ? AC : '#59f07f' }}
                    >
                      {r.result.failed ? 'FAIL' : r.result.grade}
                    </span>
                    <span className="font-bold tabular-nums">
                      {(r.result.percent * 100).toFixed(2)}%
                    </span>
                  </>
                ) : (
                  <span className="text-[12px] tracking-[0.14em] text-[#ffd94b]">
                    PLAYING… {(r.livePercent * 100).toFixed(1)}%
                  </span>
                )}
                {winner && (
                  <span
                    className="text-[12px] font-black tracking-[0.2em]"
                    style={{ color: AC, animation: final ? 'blinkStart 1.4s infinite' : 'none' }}
                  >
                    WINNER
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {!final && (
        <div className="mt-2 text-center text-[11px] tracking-[0.2em] text-[#ececec]/35">
          START — SKIP
        </div>
      )}
    </div>
  );
}

/** True while any rival is still mid-song (standings are provisional). */
export function raceStillRunning(room: RoomPeer, opponents: RoomPlayInfo['opponents']): boolean {
  const players = new Map<number, PlayerState>(room.players.map((p) => [p.id, p]));
  return opponents.some((o) => {
    const p = players.get(o.id);
    return p ? !p.left && p.result === null : false;
  });
}
