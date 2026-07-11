/**
 * Always-visible leaderboard beside the song list: the top rows for the
 * highlighted chart (current difficulty slot × music rate), refreshed as the
 * cursor moves. Read-only — takes no focus and no input, so pad navigation
 * is untouched; the RANKS overlay (SELECT menu) remains the full scrollable
 * view. Collapses entirely when offline and hides on narrow viewports so the
 * list never gets squeezed.
 */
import type { LibraryEntry } from '../io/songFiles';
import { getIdentity } from '../net/identity';
import { useSettings } from './SettingsContext';
import { useLeaderboard } from './useLeaderboard';

export function LeaderboardSide({ entry, diff }: { entry: LibraryEntry | null; diff: number }) {
  const board = useLeaderboard(entry, diff);
  const { settings } = useSettings();
  if (board === 'offline') return null;
  const me = getIdentity().playerId;
  return (
    <div className="hidden w-[300px] flex-none flex-col overflow-hidden border-l border-white/[0.09] px-[18px] py-3 min-[1100px]:flex">
      <div className="mb-2 flex flex-none items-baseline gap-3">
        <span className="text-[11px] tracking-[0.2em] text-[#ececec]/40">RANKS</span>
        <span className="h-px flex-1 bg-white/[0.07]" />
        {settings.musicRate !== 1 && (
          <span className="text-[11px] tracking-[0.1em] text-[#ffcf3d]">
            {settings.musicRate.toFixed(2)}x
          </span>
        )}
      </div>
      {board === 'loading' ? (
        <div className="py-4 text-center text-[12px] text-[#ececec]/25">…</div>
      ) : board.rows.length === 0 ? (
        <div className="py-4 text-center text-[11px] leading-relaxed tracking-[0.12em] text-[#ececec]/30">
          NO SCORES YET
          <br />
          SET THE FIRST ONE
        </div>
      ) : (
        <>
          {board.rows.map((r) => {
            const mine = r.playerId === me;
            return (
              <div
                key={r.playerId}
                className="grid grid-cols-[30px_1fr_74px_34px] items-center gap-1.5 border-b border-white/[0.05] py-[5px] text-[13px]"
                style={mine ? { color: '#59f07f' } : undefined}
              >
                <span
                  className="font-bold text-[#ececec]/45"
                  style={mine ? { color: '#59f07f' } : undefined}
                >
                  #{r.rank}
                </span>
                <span className="min-w-0 truncate" title={r.playerName}>
                  {r.playerName}
                  {mine ? ' ★' : ''}
                </span>
                <span className="text-right font-bold tabular-nums">
                  {(r.percent * 100).toFixed(2)}%
                </span>
                <span className="text-right text-[#ececec]/55">{r.grade}</span>
              </div>
            );
          })}
          {board.total > board.rows.length && (
            <div className="pt-2 text-center text-[10px] tracking-[0.14em] text-[#ececec]/30">
              {board.total} PLAYERS
            </div>
          )}
        </>
      )}
    </div>
  );
}
