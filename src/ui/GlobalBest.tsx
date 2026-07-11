/**
 * Compact online-leaderboard readout for the song-select header: the world
 * best on the highlighted chart (at the current music rate), plus your rank
 * when you appear in the top rows. Purely informational — it takes no focus
 * and no input — so pad-only operation (skill: pad-controls) is untouched.
 * Renders nothing while loading, offline, or when the board is empty, which
 * also keeps the header clean before the API is deployed.
 */
import { useEffect, useState } from 'react';
import { chartKey } from '../app/scores';
import { getIdentity } from '../net/identity';
import { fetchLeaderboard } from '../net/leaderboard';
import type { LeaderboardResponse } from '../net/protocol';
import { rateKey } from '../net/protocol';
import type { LibraryEntry } from '../io/songFiles';
import { bestChartsPerSlot } from './difficultyUi';
import { ensureLoaded } from './libraryStore';
import { useSettings } from './SettingsContext';

/** Short-lived board cache so cursor wiggling doesn't refetch (fresh scores
 *  still show up when returning from a play, after the TTL). */
const cache = new Map<string, { at: number; board: LeaderboardResponse }>();
const CACHE_TTL_MS = 30_000;
/** Wait for the cursor to settle before hashing + fetching. */
const DEBOUNCE_MS = 250;

export function GlobalBest({ entry, diff }: { entry: LibraryEntry | null; diff: number }) {
  const { settings } = useSettings();
  const rate = settings.musicRate;
  const [board, setBoard] = useState<LeaderboardResponse | null>(null);

  useEffect(() => {
    setBoard(null);
    if (!entry) return;
    let alive = true;
    const t = setTimeout(() => {
      void (async () => {
        const loaded = await ensureLoaded(entry);
        const chart = bestChartsPerSlot(loaded.song)[diff];
        if (!chart || !alive) return;
        const key = `${chartKey(loaded.song, chart)}·${rateKey(rate)}`;
        const cached = cache.get(key);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
          setBoard(cached.board);
          return;
        }
        const fresh = await fetchLeaderboard(chartKey(loaded.song, chart), rate, 10);
        if (!fresh) return; // offline / undeployed — show nothing
        cache.set(key, { at: Date.now(), board: fresh });
        if (alive) setBoard(fresh);
      })();
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [entry, diff, rate]);

  const top = board?.rows[0];
  if (!board || !top) return null;
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
