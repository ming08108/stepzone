/**
 * Results-screen room standings (RoomStandings — a ranked, animated reveal
 * from last place up to the winner, skippable with any confirm press).
 * Read-only DOM overlay on a coarse tick; judging and input never touch this.
 */
import { useEffect, useRef, useState } from 'react';
import type { RoomPeer } from '../net/roomPeer';
import type { RoomPlayInfo } from './playRequest';

const AC = '#ff5d47';

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
        <div className="mt-2 text-center text-[11px] tracking-[0.2em] text-[#ececec]/55">
          START — SKIP
        </div>
      )}
    </div>
  );
}
