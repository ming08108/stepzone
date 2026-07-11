/**
 * Compact online-leaderboard readout for the song-select header: the world
 * best on the highlighted chart (at the current music rate), plus your rank
 * when you appear in the top rows. Purely informational — it takes no focus
 * and no input — so pad-only operation (skill: pad-controls) is untouched.
 * Renders nothing while loading, offline, or when the board is empty, which
 * also keeps the header clean before the API is deployed. Data comes from
 * the shared useLeaderboard hook (one fetch feeds this and the side panel).
 */
import type { LibraryEntry } from '../io/songFiles';
import { getIdentity } from '../net/identity';
import { useLeaderboard } from './useLeaderboard';

export function GlobalBest({ entry, diff }: { entry: LibraryEntry | null; diff: number }) {
  const board = useLeaderboard(entry, diff);
  if (board === 'loading' || board === 'offline') return null;
  const top = board.rows[0];
  if (!top) return null;
  const me = board.rows.find((r) => r.playerId === getIdentity().playerId);
  return (
    <span style={{ color: '#ffcf3d' }}>
      <span className="text-[#ececec]/45">WORLD </span>
      {(top.percent * 100).toFixed(2)}% {me?.playerId === top.playerId ? 'YOU' : top.playerName}
      {me && me.playerId !== top.playerId && (
        <span className="text-[#ececec]/45"> · YOU #{me.rank}</span>
      )}
    </span>
  );
}
