/**
 * Live opponent readout during a versus match — the rival's streamed percent
 * / combo next to your own, updated from the match controller's latest snap.
 * Same shape as the ghost-race badge: a read-only DOM overlay on a coarse
 * tick, no input, pad-only untouched.
 */
import { useEffect, useState } from 'react';
import type { GameSession } from '../game/session';
import type { VersusMatch } from '../net/versusMatch';
import { DiffBadge } from './DiffBadge';

const TICK_MS = 150;

interface View {
  diff: number;
  oppoPercent: number;
  combo: number;
  left: boolean;
  finished: boolean;
}

export function VersusBar({
  session,
  match,
  name,
}: {
  session: GameSession;
  match: VersusMatch;
  name: string;
}) {
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const o = match.opponent;
      const oppoPercent = o.result?.percent ?? o.snap?.percent ?? 0;
      setView({
        diff: session.judge.percentDancePoints - oppoPercent,
        oppoPercent,
        combo: o.snap?.combo ?? 0,
        left: o.left,
        finished: o.result !== null,
      });
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [session, match]);

  if (!view) return null;
  if (view.left) {
    return (
      <div
        className="absolute left-4 top-4 z-[3] border bg-black/45 px-3 py-1.5 text-[12px] tracking-[0.14em] text-[#ececec]/85"
        style={{ borderColor: 'rgba(255,255,255,.2)' }}
      >
        <span className="text-[#ececec]/45">{name} — DISCONNECTED</span>
      </div>
    );
  }
  return (
    <DiffBadge diff={view.diff}>
      {name} {(view.oppoPercent * 100).toFixed(2)}%{view.finished ? ' · DONE' : ` ×${view.combo}`}
    </DiffBadge>
  );
}
