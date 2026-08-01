/**
 * Shared board fetch for the song-select leaderboard surfaces (the WORLD
 * header readout and the side panel): resolves the highlighted entry's chart
 * for the current difficulty slot, hashes it, and fetches the board at the
 * current music rate. Debounced so cursor wiggling doesn't fetch, with a
 * short-lived cache so revisiting a song is instant (fresh scores still show
 * up after the TTL when returning from a play).
 */
import { useEffect, useState } from 'react';
import { chartKey } from '../app/scores';
import type { LibraryEntry } from '../io/songFiles';
import { fetchLeaderboard } from '../net/leaderboard';
import type { LeaderboardResponse } from '../net/protocol';
import { rateKey } from '../net/protocol';
import { bestChartsPerSlot } from './difficultyUi';
import { ensureLoaded } from './libraryStore';
import { useSettings } from './SettingsContext';

const cache = new Map<string, { at: number; board: LeaderboardResponse }>();
const CACHE_TTL_MS = 30_000;
/** Wait for the cursor to settle before hashing + fetching. */
const DEBOUNCE_MS = 250;
const LIMIT = 10;

/** 'loading' while settling/fetching; 'offline' when the API is unreachable
 *  (callers collapse their UI); otherwise the board. */
export type BoardState = LeaderboardResponse | 'loading' | 'offline';

export function useLeaderboard(
  entry: LibraryEntry | null,
  diff: number,
  /** Board rate override — a room guest plays at the ROOM's rate, not the
   *  local musicRate setting. Defaults to the setting. */
  rateOverride?: number,
): BoardState {
  const { settings } = useSettings();
  const rate = rateOverride ?? settings.musicRate;
  const [state, setState] = useState<BoardState>('loading');

  useEffect(() => {
    setState('loading');
    if (!entry) return;
    let alive = true;
    const t = setTimeout(() => {
      void (async () => {
        const loaded = await ensureLoaded(entry);
        const chart = bestChartsPerSlot(loaded.song)[diff];
        if (!chart) {
          if (alive) setState('offline'); // no chart on this slot — nothing to show
          return;
        }
        const hash = chartKey(loaded.song, chart);
        const key = `${hash}·${rateKey(rate)}`;
        const cached = cache.get(key);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
          if (alive) setState(cached.board);
          return;
        }
        const fresh = await fetchLeaderboard(hash, rate, LIMIT);
        if (!alive) return;
        if (!fresh) {
          setState('offline');
          return;
        }
        cache.set(key, { at: Date.now(), board: fresh });
        setState(fresh);
      })();
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [entry, diff, rate]);

  return state;
}
