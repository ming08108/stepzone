/**
 * The persistent collection rail — the left pane of the redesigned song select.
 *
 * This replaces the pack WHEEL (a screen you entered with START and left with a
 * BACK row buried in the SELECT menu). A pack is now a filter that is always
 * visible and always one ▲▼ away, alongside the smart collections that answer
 * the questions players actually ask: what do I love, what haven't I cleared,
 * what have I never touched.
 *
 * Selection uses `focusStyle` — the same treatment as a song row — at full
 * strength when the rail owns the cursor and at half strength when it doesn't,
 * so there is never a second cursor competing for your eye.
 */
import { useEffect, useRef } from 'react';
import {
  artGradient,
  collectionCounts,
  focusStyle,
  packSummaries,
  sameCollection,
  SMART_COLLECTIONS,
  type Collection,
  type CollectionCounts,
} from './songSelectUi';
import { initials, type SongVM } from './songSelectModel';

export interface RailItem {
  collection: Collection;
  label: string;
  glyph: string | null;
  glyphColor: string;
  count: number;
}

/** Flat, index-addressable rail contents — the cursor is just an index. */
export function buildRail(
  songs: readonly SongVM[],
  ctx: { favs: ReadonlySet<string>; diff: number },
): { items: RailItem[]; firstPackIndex: number; counts: CollectionCounts } {
  const counts = collectionCounts(songs, ctx);
  const smart: RailItem[] = SMART_COLLECTIONS.map((s) => ({
    collection: { kind: s.kind } as Collection,
    label: s.label,
    glyph: s.glyph,
    glyphColor: s.glyphColor,
    count: counts[s.kind],
  }));
  const packs: RailItem[] = packSummaries(songs).map((p) => ({
    collection: { kind: 'pack', pack: p.pack },
    label: p.pack,
    glyph: null,
    glyphColor: '',
    count: p.count,
  }));
  return { items: [...smart, ...packs], firstPackIndex: smart.length, counts };
}

export function CollectionRail({
  items,
  firstPackIndex,
  cursor,
  active,
  focused,
  packArt,
  onPick,
}: {
  items: readonly RailItem[];
  firstPackIndex: number;
  /** Index of the rail's own cursor (may differ from the active collection). */
  cursor: number;
  active: Collection;
  /** True when the rail owns ▲▼. */
  focused: boolean;
  /** Pack name -> banner object URL, from libraryStore.packArtUrl. */
  packArt: (pack: string) => string | null;
  onPick: (c: Collection, index: number) => void;
}) {
  const cursorRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focused) cursorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor, focused]);

  const row = (item: RailItem, i: number) => {
    const on = focused ? i === cursor : sameCollection(item.collection, active);
    const isActive = sameCollection(item.collection, active);
    const art = item.collection.kind === 'pack' ? packArt(item.collection.pack) : null;
    return (
      <button
        key={`${item.collection.kind}:${item.label}`}
        ref={on && focused ? cursorRef : undefined}
        onClick={() => onPick(item.collection, i)}
        className="flex h-[44px] flex-none items-center gap-[10px] pr-[12px] pl-[9px] text-left"
        style={{
          ...focusStyle(on, focused),
          color: on ? '#fff' : isActive ? '#ececec' : 'rgba(236,236,236,.72)',
        }}
      >
        {item.glyph ? (
          <span className="w-[14px] flex-none text-center" style={{ color: item.glyphColor }}>
            {item.glyph}
          </span>
        ) : (
          <span
            className="flex h-[20px] w-[34px] flex-none items-center justify-center overflow-hidden"
            style={{
              background: art ? undefined : artGradient(item.label),
              backgroundImage: art ? `url(${art})` : undefined,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
          >
            {/* Art-less packs get an initials monogram over the deterministic
                gradient (the 1b mock's "DH" block) — a swatch you can actually
                tell apart, instead of an anonymous smear of colour. */}
            {!art && (
              <span className="font-display text-[9px] font-bold tracking-[0.06em] text-white/70">
                {initials(item.label)}
              </span>
            )}
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-[14px]"
          style={{ fontWeight: on ? 700 : 400 }}
        >
          {item.label}
        </span>
        <span
          className="flex-none text-[12px] tabular-nums"
          style={{ color: on ? '#ff5d47' : 'rgba(236,236,236,.4)', fontWeight: on ? 700 : 400 }}
        >
          {item.count.toLocaleString()}
        </span>
      </button>
    );
  };

  return (
    <div className="flex w-[264px] flex-none flex-col border-r border-white/[0.09] bg-[#0e0f12]">
      <div className="px-[18px] pt-[18px] pb-[8px] font-display text-[11px] tracking-[0.24em] text-[#ececec]/35">
        LIBRARY
      </div>
      <div className="flex flex-none flex-col px-[10px]">
        {items.slice(0, firstPackIndex).map(row)}
      </div>

      <div className="flex items-baseline gap-[10px] px-[18px] pt-[22px] pb-[8px]">
        <span className="font-display text-[11px] tracking-[0.24em] text-[#ececec]/35">PACKS</span>
        <span className="h-px flex-1 bg-white/[0.07]" />
        <span className="text-[11px] tracking-[0.1em] text-[#ececec]/35 tabular-nums">
          {items.length - firstPackIndex}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[10px] pb-[10px]">
        {items.slice(firstPackIndex).map((it, i) => row(it, firstPackIndex + i))}
      </div>
    </div>
  );
}
