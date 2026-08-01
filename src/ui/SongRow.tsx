/**
 * One row of the song list.
 *
 * Three changes from the old table row, all of them about "what is selected"
 * and "what should I play next":
 *
 *  1. The focus treatment is `focusStyle()` — identical to the rail and the
 *     filter chips — and the focused row is 8px taller, so the cursor is
 *     legible from across a room and from the corner of your eye on a pad.
 *  2. A clear-state glyph leads the row (✓ / ◔ / ○). With thousands of songs,
 *     "have I beaten this" is the question the eye asks first.
 *  3. Title and artist stack. Artist was a full column competing with the title
 *     for the same visual weight; stacking buys the level chip real estate and
 *     lets the level be big enough to read at a glance.
 */
import {
  CLEAR_COLOR,
  CLEAR_GLYPH,
  clearState,
  FAV_CLR,
  focusStyle,
  type ClearState,
} from './songSelectUi';
import { DIFF_SLOT_COLORS } from './difficultyUi';
import type { SongVM } from './songSelectModel';

export const ROW_H = 54;
export const ROW_H_FOCUSED = 62;

const GRID = 'grid-cols-[22px_1fr_74px_58px_62px]';

const GRADE_COLOR: Record<string, string> = {
  AAA: '#ffcf3d',
  AA: '#59f07f',
  A: '#59f07f',
  B: 'rgba(236,236,236,.72)',
  C: 'rgba(236,236,236,.72)',
  D: '#ff5c5c',
};

export function SongListHeader({ diffName }: { diffName: string }) {
  return (
    <div
      className={`grid h-[26px] flex-none ${GRID} items-center gap-[14px] border-b border-white/[0.06] px-[22px] font-display text-[10px] tracking-[0.2em] text-[#ececec]/35`}
    >
      <span />
      <span>TITLE</span>
      <span className="justify-self-end">BPM</span>
      <span className="justify-self-end">YOU</span>
      <span className="justify-self-end">{diffName}</span>
    </div>
  );
}

export function SongRow({
  vm,
  diff,
  focused,
  paneFocused,
  isFav,
  onSelect,
  onPlay,
  onToggleFav,
}: {
  vm: SongVM;
  diff: number;
  focused: boolean;
  /** True when the list owns ▲▼. */
  paneFocused: boolean;
  isFav: boolean;
  onSelect: () => void;
  onPlay: () => void;
  onToggleFav: () => void;
}) {
  const state: ClearState = clearState(vm, diff);
  const best = vm.bests[diff];
  const lv = vm.levels[diff];
  const slotColor = DIFF_SLOT_COLORS[diff];
  const big = focused && paneFocused;

  return (
    <div
      onClick={onSelect}
      onDoubleClick={onPlay}
      className={`grid ${GRID} flex-none cursor-pointer items-center gap-[14px] border-b border-white/[0.035] px-[22px] whitespace-nowrap`}
      style={{ height: big ? ROW_H_FOCUSED : ROW_H, ...focusStyle(focused, paneFocused) }}
    >
      <span
        className="text-[13px] leading-none"
        style={{ color: CLEAR_COLOR[state] }}
        title={state}
        aria-label={state}
      >
        {CLEAR_GLYPH[state]}
      </span>

      <span className="flex min-w-0 flex-col gap-px">
        <span className="flex min-w-0 items-center gap-[7px]">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleFav();
            }}
            aria-label={isFav ? 'Unfavorite' : 'Favorite'}
            className="flex-none text-[14px] leading-none"
            style={{ color: isFav ? FAV_CLR : 'rgba(236,236,236,.22)' }}
          >
            {isFav ? '★' : '☆'}
          </button>
          <span
            className="truncate"
            style={{
              fontSize: big ? 19 : 16,
              fontWeight: focused ? 700 : 400,
              color: focused ? '#fff' : 'rgba(236,236,236,.72)',
            }}
          >
            {vm.title}
          </span>
        </span>
        <span
          className="truncate text-[12px]"
          style={{ color: focused ? 'rgba(255,255,255,.6)' : 'rgba(236,236,236,.38)' }}
        >
          {vm.artist}
        </span>
      </span>

      <span
        className="justify-self-end text-[14px] tabular-nums"
        style={{ color: focused ? 'rgba(255,255,255,.75)' : 'rgba(236,236,236,.45)' }}
      >
        {vm.bpm}
      </span>

      <span
        className="justify-self-end text-[14px] font-bold tabular-nums"
        style={{ color: best ? (GRADE_COLOR[best.grade] ?? '#ececec') : 'rgba(236,236,236,.25)' }}
      >
        {best ? best.grade : '—'}
      </span>

      <span
        className="justify-self-end min-w-[40px] px-2 text-center font-display font-bold tabular-nums"
        style={{
          fontSize: big ? 18 : 16,
          paddingTop: big ? 4 : 3,
          paddingBottom: big ? 4 : 3,
          color: big ? '#0b0c0e' : slotColor,
          background: big ? slotColor : `${slotColor}1a`,
        }}
      >
        {lv == null ? '—' : lv}
      </span>
    </div>
  );
}
