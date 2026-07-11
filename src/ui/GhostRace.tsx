/**
 * Race-the-ghost overlay — compares the live judge against a stored
 * scoreboard timeline (GhostFrame[], docs/LEADERBOARDS.md) on the song clock.
 * A read-only DOM badge over the GPU canvas: takes no input, so pad-only
 * operation is untouched. Ticks on a coarse interval (not rAF) — a scoreboard
 * race needs ~7 Hz, and that keeps React re-renders negligible next to the
 * GPU frame loop.
 */
import { useEffect, useRef, useState } from 'react';
import type { GameSession } from '../game/session';
import type { GhostFrame } from '../net/protocol';

export interface GhostInfo {
  /** Display label — the opponent's name, or YOUR BEST when racing yourself. */
  name: string;
  frames: GhostFrame[];
}

const TICK_MS = 150;

export function GhostRace({ session, ghost }: { session: GameSession; ghost: GhostInfo }) {
  const [diff, setDiff] = useState<number | null>(null);
  // Frames are time-ordered and the song clock only advances, so a walking
  // cursor finds the current frame in O(1) per tick.
  const cursor = useRef(0);

  useEffect(() => {
    cursor.current = 0;
    const timer = window.setInterval(() => {
      const t = session.songNow;
      const frames = ghost.frames;
      if (t < frames[0].atSong) {
        setDiff(null); // lead-in: nothing to compare yet
        return;
      }
      let i = cursor.current;
      while (i + 1 < frames.length && frames[i + 1].atSong <= t) i++;
      cursor.current = i;
      setDiff(session.judge.percentDancePoints - frames[i].percent);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [session, ghost]);

  if (diff === null) return null;
  const ahead = diff >= 0;
  const clr = ahead ? '#59f07f' : '#ff5d47';
  return (
    <div
      className="absolute left-4 top-4 z-[3] border bg-black/45 px-3 py-1.5 text-[12px] tracking-[0.14em] text-[#ececec]/85"
      style={{ borderColor: clr + '66' }}
    >
      VS {ghost.name}{' '}
      <span className="font-bold" style={{ color: clr }}>
        {ahead ? '+' : ''}
        {(diff * 100).toFixed(2)}%
      </span>
    </div>
  );
}
