/**
 * The screen's one key legend — a fixed five-slot footer.
 *
 * The old hint bar re-worded, re-ordered and dropped entries between the pack
 * grid, the song list, the SELECT overlay and room-guest mode, so the same
 * physical button appeared to mean four different things. The slots here are
 * always present, always in this order, always keycap-styled; only the ACTION
 * label changes with context, and an inapplicable slot dims rather than
 * disappearing — the map never moves under you.
 */

const SLOT_ORDER = ['updown', 'leftright', 'select', 'start', 'fav'] as const;
export type LegendSlot = (typeof SLOT_ORDER)[number];

const KEYCAP: Record<LegendSlot, string> = {
  updown: '▲▼',
  leftright: '◀▶',
  select: 'SELECT',
  start: 'START',
  fav: 'F',
};

const DEFAULTS: Record<LegendSlot, string> = {
  updown: 'SONG',
  leftright: 'DIFFICULTY',
  select: 'LIBRARY',
  start: 'PLAY',
  fav: 'FAVORITE',
};

/** `null` dims a slot (still shown, still in place); omitted uses the default. */
export type LegendActions = Partial<Record<LegendSlot, string | null>>;

/** Screen-specific keyboard-only hints appended AFTER the five fixed slots. */
export type LegendExtra = { key: string; act: string };

export function KeyLegend({
  actions,
  note,
  extras,
}: {
  actions?: LegendActions;
  note?: string;
  extras?: LegendExtra[];
}) {
  return (
    <div className="flex h-[46px] flex-none items-center border-t border-white/[0.09] bg-[#0e0f12] px-[22px] font-display text-[12px] tracking-[0.12em]">
      {SLOT_ORDER.map((slot) => {
        const raw = actions?.[slot];
        const off = raw === null;
        const label = off || raw === undefined ? DEFAULTS[slot] : raw;
        return (
          <span
            key={slot}
            className="flex items-center gap-[9px] pr-[26px]"
            style={{ opacity: off ? 0.28 : 1 }}
          >
            <span className="inline-flex h-[22px] min-w-[26px] items-center justify-center border border-white/[0.18] px-[6px] text-[11px] text-[#ececec]">
              {KEYCAP[slot]}
            </span>
            <span className="text-[#ececec]/55">{label}</span>
          </span>
        );
      })}
      {extras?.map((x) => (
        <span key={x.key} className="flex items-center gap-[9px] pr-[26px]">
          <span className="inline-flex h-[22px] min-w-[26px] items-center justify-center border border-white/[0.18] px-[6px] text-[11px] text-[#ececec]">
            {x.key}
          </span>
          <span className="text-[#ececec]/55">{x.act}</span>
        </span>
      ))}
      <span className="flex-1" />
      {note && (
        <span className="text-accent" style={{ animation: 'blinkStart 1.4s infinite' }}>
          {note}
        </span>
      )}
    </div>
  );
}
