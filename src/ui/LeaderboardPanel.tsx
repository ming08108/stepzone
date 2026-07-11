/**
 * Full leaderboard overlay for the highlighted chart — opened from the song
 * list's SELECT menu (RANKS row), per the pad-controls invariant: ▲▼ scroll,
 * START or SELECT closes. It owns its keyboard handling while mounted
 * (SongSelect's nav handler is gated off), so the pad drives it through the
 * same synthetic-keydown bridge as every other menu.
 */
import { useEffect, useRef, useState } from 'react';
import { chartKey } from '../app/scores';
import { keyboardRole } from '../input/inputBus';
import type { LibraryEntry } from '../io/songFiles';
import { getIdentity } from '../net/identity';
import { fetchLeaderboard } from '../net/leaderboard';
import type { LeaderboardResponse } from '../net/protocol';
import { bestChartsPerSlot, DIFF_SLOT_COLORS, DIFF_SLOT_NAMES } from './difficultyUi';
import { ensureLoaded } from './libraryStore';
import { useSettings } from './SettingsContext';

const AC = '#ff5d47';
const VISIBLE_ROWS = 12;

type Board = 'loading' | 'unavailable' | LeaderboardResponse;

export function LeaderboardPanel({
  entry,
  diff,
  onClose,
}: {
  entry: LibraryEntry;
  diff: number;
  onClose: () => void;
}) {
  const { settings } = useSettings();
  const rate = settings.musicRate;
  const [board, setBoard] = useState<Board>('loading');
  const [top, setTop] = useState(0); // first visible row (▲▼ scroll)
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const loaded = await ensureLoaded(entry);
      const chart = bestChartsPerSlot(loaded.song)[diff];
      if (!chart) {
        if (alive) setBoard('unavailable');
        return;
      }
      const fresh = await fetchLeaderboard(chartKey(loaded.song, chart), rate, 50);
      if (alive) setBoard(fresh ?? 'unavailable');
    })();
    return () => {
      alive = false;
    };
  }, [entry, diff, rate]);

  const rows = typeof board === 'object' ? board.rows : [];
  const maxTop = Math.max(0, rows.length - VISIBLE_ROWS);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const role = keyboardRole(e.code);
      const isConfirm = e.key === 'Enter' || role === 'confirm';
      const isBack = e.key === 'Escape' || e.key === 'Shift' || role === 'back';
      const isArrow = e.key === 'ArrowUp' || e.key === 'ArrowDown';
      if (!isConfirm && !isBack && !isArrow) return;
      e.preventDefault();
      if (isConfirm || isBack) {
        onClose();
        return;
      }
      setTop((v) => (e.key === 'ArrowDown' ? Math.min(maxTop, v + 1) : Math.max(0, v - 1)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, maxTop]);

  useEffect(() => {
    listRef.current?.children[top]?.scrollIntoView({ block: 'nearest' });
  }, [top]);

  const me = getIdentity().playerId;
  const title = entry.song.displayFullTitle || 'Untitled';

  return (
    <div className="absolute inset-0 z-[30] flex items-center justify-center bg-black/60">
      <div className="flex max-h-[80%] w-[560px] max-w-[92%] flex-col border border-white/15 bg-[#0b0c0e] shadow-2xl">
        <div className="flex flex-none items-baseline gap-3 border-b border-white/[0.09] px-5 py-3">
          <span className="text-[13px] font-bold tracking-[0.22em]" style={{ color: AC }}>
            RANKS
          </span>
          <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{title}</span>
          <span
            className="flex-none text-[12px] tracking-[0.1em]"
            style={{ color: DIFF_SLOT_COLORS[diff] }}
          >
            {DIFF_SLOT_NAMES[diff]}
          </span>
          {rate !== 1 && (
            <span className="flex-none text-[12px] tracking-[0.1em] text-[#ffcf3d]">
              {rate.toFixed(2)}x
            </span>
          )}
          <button
            onClick={onClose}
            title="Close"
            className="flex-none px-1 text-[15px] text-[#ececec]/40 hover:text-[#ececec]"
          >
            ✕
          </button>
        </div>

        <div ref={listRef} className="min-h-[120px] flex-1 overflow-hidden px-5 py-3">
          {board === 'loading' && <div className="py-6 text-center text-[#ececec]/40">…</div>}
          {board === 'unavailable' && (
            <div className="py-6 text-center text-[13px] tracking-[0.12em] text-[#ececec]/40">
              OFFLINE — NO BOARD
            </div>
          )}
          {typeof board === 'object' && rows.length === 0 && (
            <div className="py-6 text-center text-[13px] tracking-[0.12em] text-[#ececec]/40">
              NO SCORES YET — SET THE FIRST ONE
            </div>
          )}
          {rows.slice(top, top + VISIBLE_ROWS).map((r) => {
            const mine = r.playerId === me;
            return (
              <div
                key={r.playerId}
                className="grid grid-cols-[44px_1fr_92px_52px_72px_24px] items-center gap-2 border-b border-white/[0.05] py-[7px] text-[14px]"
                style={mine ? { color: '#59f07f' } : undefined}
              >
                <span
                  className="font-bold text-[#ececec]/55"
                  style={mine ? { color: '#59f07f' } : undefined}
                >
                  #{r.rank}
                </span>
                <span className="min-w-0 truncate">
                  {r.playerName}
                  {mine ? ' (YOU)' : ''}
                </span>
                <span className="text-right font-bold">{(r.percent * 100).toFixed(2)}%</span>
                <span className="text-right">{r.grade}</span>
                <span className="text-right text-[#ececec]/55">{r.maxCombo}x</span>
                <span
                  className="text-center text-[#ececec]/40"
                  title={r.hasGhost ? 'ghost available' : ''}
                >
                  {r.hasGhost ? '▶' : ''}
                </span>
              </div>
            );
          })}
          {typeof board === 'object' && rows.length > 0 && board.total > rows.length && (
            <div className="pt-2 text-center text-[11px] tracking-[0.14em] text-[#ececec]/35">
              {board.total} PLAYERS TOTAL
            </div>
          )}
        </div>

        <div className="flex flex-none justify-end border-t border-white/[0.09] px-5 py-2">
          <span className="text-[11px] tracking-[0.14em]" style={{ color: AC }}>
            ▲▼ SCROLL · START / SELECT — CLOSE
          </span>
        </div>
      </div>
    </div>
  );
}
