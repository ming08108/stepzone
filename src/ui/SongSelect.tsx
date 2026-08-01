/**
 * Song-select screen — a full-viewport three-pane layout: a persistent
 * collection RAIL (smart collections + packs), the song LIST, and the
 * INSPECTOR for the chart you're about to start.
 *
 * What changed from the pack-wheel version, and why:
 *
 *  · NO MODES. The pack wheel was a screen you entered with START and left
 *    through a BACK row buried in the SELECT menu, and inside it ◀▶ meant
 *    "move one card" while outside it meant "difficulty". A pack is now just a
 *    collection in the rail, so ▲▼ always moves the cursor in the focused pane
 *    and ◀▶ ALWAYS changes difficulty — everywhere, in every state.
 *
 *  · ONE SELECTION TREATMENT. Rail rows, song rows and difficulty slots all
 *    render focus through songSelectUi's `focusStyle()`. The pane that owns
 *    ▲▼ shows its cursor at full strength; the other keeps a half-strength
 *    marker so you can see where you'll land, without two cursors competing.
 *
 *  · FILTERS ARE CONTROLS, NOT AN OVERLAY. The old strip was simultaneously a
 *    row of buttons and a keyboard overlay with its own cursor, its own hint
 *    text, and two unrelated actions (BACK, RESET) hiding among the values.
 *    They are now plain controls: click them, or type in search via `/`.
 *
 *  · CLEAR STATE IS VISIBLE. Every row leads with ✓ / ◔ / ○, and "Not cleared"
 *    and "Never played" are collections — with thousands of songs that question
 *    should be one keypress, not a sort order you have to reconstruct.
 *
 * The pure row/filter/sort/window logic still lives in songSelectModel.ts, the
 * library in libraryStore.ts, and the new presentation vocabulary (focus style,
 * collections, clear state) in songSelectUi.ts.
 */
import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { readSongAudio } from '../io/songFiles';
import { resolveBackground, subscribeBgConvert, type BgConvertStatus } from '../io/bgVideo';
import { clearVideoCache, videoCacheStats } from '../io/videoCache';
import { prefetchSong, previewCached, previewSong, stopPreview } from '../audio/songPreview';
import { loadFavorites, saveFavorites } from '../app/favorites';
import { keyboardRole } from '../input/inputBus';
import { loadScores } from '../app/scores';
import { loadStats } from '../app/stats';
import { bestChartsPerSlot, DIFF_SLOT_NAMES } from './difficultyUi';
import { buildChartSeed, type ChartSeed } from './devSeed';
import { NamePrompt } from './NamePrompt';
import { shouldPromptForName } from '../net/identity';
import { isRoomCode } from '../net/versus';
import { MultiplayerPanel } from './MultiplayerPanel';
import { announceBrowsing, roomBrowsing, roomState, subscribeRoom, suggestSong } from './roomStore';
import type { PlayRequest } from './playRequest';
import { useGamepadKeys } from './useGamepadKeys';
import {
  buildBestsBySong,
  filterSort,
  SORTS,
  toSongVMs,
  virtualWindow,
  type SongVM,
  type Sort,
} from './songSelectModel';
import {
  addDropped,
  addFiles,
  addFolderFromPicker,
  ensureLoaded,
  finishRestore,
  forgetSource,
  initLibrary,
  libraryState,
  packArtUrl,
  refreshSources,
  requestPackArt,
  rescanSource,
  subscribeLibrary,
  toggleSource,
} from './libraryStore';
import {
  applyCollection,
  buildLastPlayed,
  collectionLabel,
  AC,
  type Collection,
} from './songSelectUi';
import { buildRail, CollectionRail } from './CollectionRail';
import { ROW_H, ROW_H_FOCUSED, SongListHeader, SongRow } from './SongRow';
import { SongInspector } from './SongInspector';
import { KeyLegend, type LegendActions } from './KeyLegend';

/** Which pane owns ▲▼. */
type Pane = 'rail' | 'list';

// A ?join=CODE share link, consumed ONCE at module level: StrictMode's dev
// double-mount re-runs state initializers after the URL param is stripped, so
// the consumed value must outlive the component instance.
let consumedJoinCode: string | null | undefined;
function consumeJoinCode(): string | undefined {
  if (consumedJoinCode === undefined) {
    const code = new URLSearchParams(location.search).get('join');
    consumedJoinCode = code && isRoomCode(code) ? code : null;
    if (consumedJoinCode) history.replaceState(null, '', location.pathname);
  }
  return consumedJoinCode ?? undefined;
}

// Session-scoped view state, kept across remounts so returning from a song
// lands you exactly where you left.
const saved = {
  sort: 'title' as Sort,
  search: '',
  minLv: 1,
  maxLv: 999, // sentinel "no cap" — displayed/applied as the library's max level
  sel: 0,
  diff: 2,
  favOnly: false,
  collection: { kind: 'all' } as Collection,
  railCursor: 4, // SMART_COLLECTIONS index of 'all'
  pane: 'list' as Pane,
};

export function SongSelect({
  onPlay,
  onOptions,
}: {
  onPlay: (r: PlayRequest) => void;
  onOptions: () => void;
}) {
  const { entries, sources, loading, packArtVersion } = useSyncExternalStore(
    subscribeLibrary,
    libraryState,
  );

  const [viewH, setViewH] = useState(400);
  const [scrollAnim, setScrollAnim] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setScrollAnim(true), 160);
    return () => window.clearTimeout(t);
  }, []);

  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const wheelAcc = useRef(0);
  const restoring = useRef(false);

  const [drag, setDrag] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [bgConvert, setBgConvert] = useState<BgConvertStatus | null>(null);
  const [videoCache, setVideoCache] = useState<{ bytes: number; count: number } | null>(null);

  const [pane, setPane] = useState<Pane>(saved.pane);
  const [collection, setCollection] = useState<Collection>(saved.collection);
  const [railCursor, setRailCursor] = useState(saved.railCursor);
  const [sel, setSel] = useState(saved.sel);
  const [diff, setDiff] = useState(saved.diff);
  const [sort, setSort] = useState<Sort>(saved.sort);
  const [search, setSearch] = useState(saved.search);
  const [minLv, setMinLv] = useState(saved.minLv);
  const [maxLv, setMaxLv] = useState(saved.maxLv);
  const [favOnly, setFavOnly] = useState(saved.favOnly);
  const [favs, setFavs] = useState(() => loadFavorites());

  const [joinCode] = useState(consumeJoinCode);
  const [versusOpen, setVersusOpen] = useState(joinCode !== undefined);
  const [namePromptOpen, setNamePromptOpen] = useState(
    () => shouldPromptForName() && joinCode === undefined,
  );
  const [suggested, setSuggested] = useState<string | null>(null);

  useGamepadKeys();
  useEffect(() => subscribeBgConvert(setBgConvert), []);
  useEffect(() => {
    if (showSources) void videoCacheStats().then(setVideoCache);
  }, [showSources, bgConvert]);

  const vsRoom = useSyncExternalStore(subscribeRoom, roomState);
  const isRoomGuest = vsRoom.k === 'in-room' && !vsRoom.room.isHost;
  const isRoomHost = vsRoom.k === 'in-room' && vsRoom.room.isHost;
  const roomBrowse = vsRoom.k === 'in-room' ? vsRoom.room : null;
  const browsingLabel = isRoomGuest ? (roomBrowsing()?.title ?? null) : null;

  const stats = useMemo(() => loadStats(), []);
  const scores = useMemo(() => loadScores(), []);
  const bestsBySong = useMemo(() => buildBestsBySong(scores), [scores]);
  const lastPlayed = useMemo(() => buildLastPlayed(scores), [scores]);

  const pendingNames = sources
    .filter((s) => s.enabled && s.permission === 'prompt')
    .map((s) => s.name);

  const toggleFav = useCallback(
    (k: string) => {
      setFavs((prev) => {
        const next = new Set(prev);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        saveFavorites(next);
        return next;
      });
    },
    [setFavs],
  );

  /* ── measurement ──────────────────────────────────────────────────────── */

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    initLibrary();
    void refreshSources();
  }, []);

  useEffect(() => {
    if (folderRef.current) folderRef.current.webkitdirectory = true;
  }, []);

  const chooseFolder = async () => {
    if (!(await addFolderFromPicker())) folderRef.current?.click();
  };

  // While the reload banner is up, any real keypress doubles as the permission
  // gesture; synthetic (gamepad-adapter) keys carry no user activation.
  useEffect(() => {
    if (pendingNames.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.isTrusted || e.key === 'Escape' || restoring.current) return;
      restoring.current = true;
      void finishRestore().finally(() => {
        restoring.current = false;
      });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pendingNames.length]);

  /* ── the list ─────────────────────────────────────────────────────────── */

  const songs = useMemo<SongVM[]>(
    () => toSongVMs(entries, bestsBySong, stats.songPlays),
    [entries, bestsBySong, stats],
  );

  const levelCeil = useMemo(() => {
    let m = 20;
    for (const s of songs) for (const lv of s.levels) if (lv != null && lv > m) m = lv;
    return m;
  }, [songs]);
  const effMaxLv = Math.min(maxLv, levelCeil);

  // Search / level range / favourites / sort — orthogonal to the collection.
  const filtered = useMemo(
    () => filterSort(songs, { search, minLv, maxLv: effMaxLv, favOnly, favs, sort, diff }),
    [songs, search, minLv, effMaxLv, favOnly, favs, sort, diff],
  );

  const railCtx = useMemo(() => ({ favs, diff, lastPlayed }), [favs, diff, lastPlayed]);
  const { items: railItems, firstPackIndex } = useMemo(
    () => buildRail(filtered, railCtx),
    [filtered, railCtx],
  );

  const shown = useMemo(
    () => applyCollection(filtered, collection, railCtx),
    [filtered, collection, railCtx],
  );

  // A collection that filtering emptied (e.g. a pack outside the level range)
  // falls back to ALL rather than showing an unexplained blank list.
  useEffect(() => {
    if (shown.length === 0 && filtered.length > 0 && collection.kind === 'pack') {
      setCollection({ kind: 'all' });
      setRailCursor(4);
    }
  }, [shown.length, filtered.length, collection]);

  const railClamped = Math.min(railCursor, Math.max(0, railItems.length - 1));
  const selClamped = Math.min(sel, Math.max(0, shown.length - 1));
  const song = shown[selClamped] ?? null;
  const songEntry = song?.entry ?? null;

  useEffect(() => {
    saved.sort = sort;
    saved.search = search;
    saved.minLv = minLv;
    saved.maxLv = maxLv;
    saved.sel = selClamped;
    saved.diff = diff;
    saved.favOnly = favOnly;
    saved.collection = collection;
    saved.railCursor = railClamped;
    saved.pane = pane;
  });

  /* ── previews / prefetch / art (unchanged plumbing) ───────────────────── */

  useEffect(() => {
    if (!song?.entry) {
      stopPreview();
      return;
    }
    let alive = true;
    void ensureLoaded(song.entry).then((e) => {
      if (alive) previewSong(e, previewCached(e) ? 120 : 450);
    });
    return () => {
      alive = false;
    };
  }, [song?.entry]);
  useEffect(() => () => stopPreview(), []);

  useEffect(() => {
    if (shown.length === 0) return;
    let alive = true;
    const t = setTimeout(() => {
      void (async () => {
        for (const off of [1, -1, 2, -2]) {
          const vm = shown[selClamped + off];
          if (!vm || !alive) continue;
          const e = await ensureLoaded(vm.entry);
          if (alive) prefetchSong(e);
        }
      })();
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [selClamped, shown]);

  // Pack banners for the rail. The rail is always visible now, so this walks
  // once per library rather than only while a pack grid is open — still
  // sequential, still deduped against the store cache.
  useEffect(() => {
    let alive = true;
    const queued = new Set<string>();
    const jobs: { pack: string; sourceId: string; dir: string }[] = [];
    for (const s of filtered) {
      const pack = s.pack || '—';
      if (queued.has(pack) || packArtUrl(pack) !== undefined) continue;
      const e = s.entry;
      if (!e?.sourceId || !e.lazyDir || !e.lazyDir.includes('/')) continue;
      queued.add(pack);
      jobs.push({
        pack,
        sourceId: e.sourceId,
        dir: e.lazyDir.slice(0, e.lazyDir.lastIndexOf('/')),
      });
    }
    if (jobs.length === 0) return;
    void (async () => {
      for (const j of jobs) {
        if (!alive) return;
        await requestPackArt(j.pack, j.sourceId, j.dir);
      }
    })();
    return () => {
      alive = false;
    };
  }, [filtered]);

  const railArt = useCallback(
    (pack: string) => packArtUrl(pack) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [packArtVersion],
  );

  useEffect(() => {
    if (isRoomHost && roomBrowse?.phase === 'lobby' && song) {
      announceBrowsing(song.title, song.artist);
    }
  }, [isRoomHost, roomBrowse?.phase, song]);

  // DEV-only e2e hook (unchanged).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __seedChartData?: () => Promise<ChartSeed | null> };
    w.__seedChartData = async () => {
      const e = song?.entry;
      if (!e) return null;
      const loaded = await ensureLoaded(e);
      const chart = bestChartsPerSlot(loaded.song)[diff];
      return chart ? buildChartSeed(loaded.song, chart) : null;
    };
    return () => {
      delete w.__seedChartData;
    };
  }, [song?.entry, diff]);

  /* ── actions ──────────────────────────────────────────────────────────── */

  const start = useCallback(async () => {
    const s = shown[Math.min(sel, Math.max(0, shown.length - 1))];
    if (!s) return;
    if (isRoomGuest) {
      suggestSong(s.title, s.artist);
      setSuggested(s.title);
      window.setTimeout(() => setSuggested(null), 2200);
      return;
    }
    if (s.levels[diff] == null) return;
    const entry = await ensureLoaded(s.entry);
    const chart = bestChartsPerSlot(entry.song)[diff];
    if (!chart) return;
    const audio = await readSongAudio(entry);
    const bg = await resolveBackground(entry);
    onPlay({ song: entry.song, chart, encodedAudio: audio, backgroundFile: bg, entry });
  }, [shown, sel, diff, onPlay, isRoomGuest]);

  const pickCollection = useCallback((c: Collection, index: number) => {
    setCollection(c);
    setRailCursor(index);
    setSel(0);
  }, []);

  const resetFilters = () => {
    setSort('title');
    setSearch('');
    setMinLv(1);
    setMaxLv(999);
    setFavOnly(false);
  };

  /* ── keyboard / pad ───────────────────────────────────────────────────────
     The whole model, in four lines:
       ▲▼      move the cursor in the focused pane
       ◀▶      difficulty — always, in every pane, in every state
       SELECT  swap the focused pane (LIBRARY ⇄ SONGS)
       START   play (or, from the rail, jump into the songs)
     Plus, for keyboard players: `/` focuses search, Esc leaves it, F favorites.
  ------------------------------------------------------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (versusOpen || namePromptOpen) return;

      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT';
      const role = keyboardRole(e.code);
      const isConfirm = e.key === 'Enter' || role === 'confirm';
      const isSwap = e.key === 'Escape' || e.key === 'Shift' || e.key === 'Tab' || role === 'back';

      if (typing) {
        // Search owns typing; Esc/Enter hand the keys back to the list.
        if (e.key === 'Escape' || isConfirm) {
          e.preventDefault();
          searchRef.current?.blur();
          setPane('list');
        }
        return;
      }

      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }

      // ◀▶ is difficulty everywhere.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setDiff((v) => Math.max(0, Math.min(4, v + (e.key === 'ArrowRight' ? 1 : -1))));
        return;
      }

      if (isSwap) {
        e.preventDefault();
        setPane((p) => (p === 'rail' ? 'list' : 'rail'));
        return;
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        if (pane === 'rail') {
          const n = Math.max(1, railItems.length);
          setRailCursor((p) => {
            const next = Math.max(0, Math.min(n - 1, Math.min(p, n - 1) + dir));
            const item = railItems[next];
            if (item) {
              setCollection(item.collection);
              setSel(0);
            }
            return next;
          });
        } else {
          const n = Math.max(1, shown.length);
          setSel((s) => (Math.min(s, n - 1) + dir + n) % n);
        }
        return;
      }

      if (isConfirm) {
        e.preventDefault();
        if (pane === 'rail') setPane('list');
        else void start();
        return;
      }

      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        if (song) toggleFav(song.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pane, railItems, shown, song, start, toggleFav, versusOpen, namePromptOpen]);

  const onDrop = async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDrag(false);
    await addDropped(e.dataTransfer);
  };

  /* ── virtualization ───────────────────────────────────────────────────── */

  const { off, first, last, topFade, botFade } = virtualWindow(
    shown.length,
    viewH,
    selClamped,
    ROW_H,
  );

  const legend: LegendActions = isRoomGuest
    ? { updown: 'SONG', start: 'SUGGEST', fav: 'FAVORITE' }
    : pane === 'rail'
      ? { updown: 'COLLECTION', select: 'SONGS', start: 'SHOW SONGS', fav: null }
      : { updown: 'SONG', select: 'LIBRARY', start: 'PLAY' };

  const note = isRoomGuest
    ? suggested
      ? `SUGGESTED “${suggested}”`
      : roomBrowse?.song
        ? 'THE HOST PICKED A SONG — GET READY'
        : browsingLabel
          ? `HOST IS LOOKING AT: ${browsingLabel}`
          : 'IN A ROOM — THE HOST PICKS THE SONG'
    : undefined;

  return (
    <div
      className="fixed inset-0 flex flex-col overflow-hidden bg-[#0b0c0e] font-grotesk text-[#ececec] [font-variant-numeric:tabular-nums]"
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
    >
      {/* Header — search is a first-class control, not a filter-strip afterthought */}
      <div className="flex h-[64px] flex-none items-center gap-6 border-b border-white/[0.09] bg-[#0e0f12] px-6">
        <span className="font-display text-[20px] font-bold tracking-[0.22em]">STEPZONE</span>
        <div className="flex h-[36px] max-w-[520px] flex-1 items-center gap-[10px] border border-white/[0.14] bg-white/[0.03] px-3 focus-within:border-[#ff5d47]">
          <span className="text-[14px] text-[#ececec]/40">⌕</span>
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSel(0);
            }}
            placeholder={`Search ${songs.length.toLocaleString()} songs, artists, packs…`}
            className="min-w-0 flex-1 bg-transparent text-[14px] tracking-[0.04em] outline-none placeholder:text-[#ececec]/40"
          />
          <span className="border border-white/[0.14] px-[6px] py-px text-[11px] tracking-[0.1em] text-[#ececec]/35">
            /
          </span>
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-5 font-display text-[12px] tracking-[0.12em] text-[#ececec]/50">
          <span title="Lifetime steps hit">
            <span className="font-semibold text-[#ececec]">{stats.steps.toLocaleString()}</span>{' '}
            STEPS
          </span>
          <span className="h-[18px] w-px bg-white/[0.12]" />
          <button
            onClick={() => setShowSources((v) => !v)}
            className="hover:text-[#ececec]"
            style={{ color: showSources ? AC : undefined }}
            title="Manage song folders"
          >
            FOLDERS{sources.length > 0 ? ` (${sources.length})` : ''}
          </button>
          <button onClick={onOptions} className="hover:text-[#ececec]">
            OPTIONS
          </button>
        </div>
      </div>

      {/* Song-folder sources panel (unchanged behaviour, header-anchored) */}
      {showSources && (
        <div className="absolute top-[62px] right-[20px] z-30 w-[360px] border border-white/[0.14] bg-[#101114] p-[14px] text-[12px] tracking-[0.08em]">
          <div className="mb-2 flex items-center justify-between text-[#ececec]/50">
            <span>SONG FOLDERS</span>
            <button onClick={() => setShowSources(false)} className="hover:text-[#ececec]">
              ✕
            </button>
          </div>
          {sources.length === 0 && (
            <div className="py-2 text-[#ececec]/40">NONE YET — ADD YOUR SONGS FOLDER OR A PACK</div>
          )}
          {sources.map((s) => {
            const count = entries.filter((e) => e.sourceId === s.id).length;
            return (
              <div
                key={s.id}
                className="flex items-center gap-2 border-t border-white/[0.06] py-[7px]"
              >
                <button
                  onClick={() => void toggleSource(s)}
                  className="w-[18px] text-center text-[13px]"
                  style={{ color: s.enabled ? AC : 'rgba(236,236,236,.35)' }}
                  title={s.enabled ? 'Disable (keep remembered)' : 'Enable'}
                >
                  {s.enabled ? '■' : '□'}
                </button>
                <span className="min-w-0 flex-1 truncate" style={{ opacity: s.enabled ? 1 : 0.45 }}>
                  {s.name}
                </span>
                <span className="whitespace-nowrap text-[#ececec]/40">
                  {s.enabled && s.permission === 'prompt'
                    ? 'LOCKED'
                    : count > 0
                      ? `${count} SONGS`
                      : ''}
                </span>
                {s.enabled && (
                  <button
                    onClick={() => void rescanSource(s)}
                    className="text-[#ececec]/40 hover:text-[#ececec]"
                    title="Rescan this folder"
                  >
                    ⟳
                  </button>
                )}
                <button
                  onClick={() => void forgetSource(s)}
                  className="text-[#ececec]/40 hover:text-[#ff5d47]"
                  title="Forget this folder"
                >
                  ✕
                </button>
              </div>
            );
          })}
          <button
            onClick={() => void chooseFolder()}
            className="mt-3 w-full border border-white/[0.14] py-[6px] hover:border-[#ff5d47] hover:text-[#ececec]"
          >
            + ADD FOLDER
          </button>
          {videoCache && videoCache.count > 0 && (
            <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2 text-[#ececec]/40">
              <span>
                BG VIDEO CACHE — {(videoCache.bytes / 1048576).toFixed(0)} MB ({videoCache.count})
              </span>
              <button
                onClick={() =>
                  void clearVideoCache().then(() => videoCacheStats().then(setVideoCache))
                }
                className="hover:text-[#ff5d47]"
              >
                CLEAR
              </button>
            </div>
          )}
        </div>
      )}

      {pendingNames.length > 0 && (
        <button
          onClick={() => void finishRestore()}
          className="flex h-[40px] flex-none items-center justify-center gap-2 border-b border-white/[0.09] text-[12px] tracking-[0.14em]"
          style={{ color: AC, background: AC + '14' }}
        >
          RELOAD SONG LIBRARY “{pendingNames.join(', ').toUpperCase()}” — PRESS ANY KEY OR CLICK,
          THEN ALLOW ACCESS
        </button>
      )}

      <input
        ref={folderRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void addFiles(files);
        }}
      />

      <div className="flex min-h-0 flex-1">
        <CollectionRail
          items={railItems}
          firstPackIndex={firstPackIndex}
          cursor={railClamped}
          active={collection}
          focused={pane === 'rail'}
          packArt={railArt}
          onPick={(c, i) => {
            pickCollection(c, i);
            setPane('rail');
          }}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Context bar — where you are, and the two filters that narrow it */}
          <div className="flex h-[52px] flex-none items-center gap-3 border-b border-white/[0.09] px-[22px]">
            <span className="font-display text-[17px] font-semibold tracking-[0.08em] uppercase">
              {collectionLabel(collection)}
            </span>
            <span className="text-[13px] text-[#ececec]/45 tabular-nums">
              {shown.length.toLocaleString()} songs
            </span>
            <span className="flex-1" />
            <button
              onClick={() => setFavOnly((v) => !v)}
              className="flex h-[30px] items-center gap-2 border px-[10px] text-[12px] tracking-[0.08em]"
              style={{
                borderColor: favOnly ? AC : 'rgba(255,255,255,.14)',
                color: favOnly ? '#ececec' : 'rgba(236,236,236,.6)',
                background: favOnly ? AC + '14' : 'transparent',
              }}
            >
              <span className="opacity-55">FAVES</span>
              <span className="font-bold">{favOnly ? '★ ONLY' : 'ALL'}</span>
            </button>
            <div className="flex h-[30px] items-center gap-2 border border-white/[0.14] px-[10px] text-[12px] tracking-[0.08em] text-[#ececec]/60">
              <span className="opacity-55">LV</span>
              <button
                className="px-[3px] font-bold hover:text-white"
                aria-label="decrease min level"
                onClick={() => setMinLv((v) => Math.max(1, v - 1))}
              >
                −
              </button>
              <span className="min-w-[42px] text-center font-bold text-[#ececec] tabular-nums">
                {minLv}–{effMaxLv}
              </span>
              <button
                className="px-[3px] font-bold hover:text-white"
                aria-label="increase max level"
                onClick={() => setMaxLv((v) => Math.min(levelCeil, Math.min(v, levelCeil) + 1))}
              >
                +
              </button>
            </div>
            <button
              onClick={() => {
                setSort(SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length]);
                setSel(0);
              }}
              className="flex h-[30px] items-center gap-2 border border-white/[0.14] px-[10px] text-[12px] tracking-[0.08em] text-[#ececec]/60 hover:border-[#ff5d47]"
            >
              <span className="opacity-55">SORT</span>
              <span className="font-bold text-[#ececec]">{sort.toUpperCase()} ▾</span>
            </button>
            <button
              onClick={resetFilters}
              className="h-[30px] px-[10px] text-[12px] tracking-[0.08em] text-[#ececec]/45 hover:text-[#ff5d47]"
              title="Clear search, level range, faves and sort"
            >
              ↺
            </button>
          </div>

          <SongListHeader diffName={DIFF_SLOT_NAMES[diff]} />

          <div
            ref={listRef}
            className="relative min-h-0 flex-1 overflow-hidden"
            onWheel={(e) => {
              wheelAcc.current += e.deltaY;
              if (Math.abs(wheelAcc.current) < 30) return;
              const dir = wheelAcc.current > 0 ? 1 : -1;
              wheelAcc.current = 0;
              const n = Math.max(1, shown.length);
              setSel((prev) => Math.max(0, Math.min(n - 1, Math.min(prev, n - 1) + dir)));
            }}
          >
            <div
              className="absolute inset-0"
              style={{
                maskImage: `linear-gradient(to bottom, ${topFade ? 'transparent' : 'black'} 0, black 8%, black 92%, ${botFade ? 'transparent' : 'black'} 100%)`,
                WebkitMaskImage: `linear-gradient(to bottom, ${topFade ? 'transparent' : 'black'} 0, black 8%, black 92%, ${botFade ? 'transparent' : 'black'} 100%)`,
              }}
            >
              <div
                className="absolute inset-x-0 top-0"
                style={{
                  height: shown.length * ROW_H + (ROW_H_FOCUSED - ROW_H),
                  transform: `translateY(${off}px)`,
                  // Rows sit on a uniform ROW_H grid; the focused row grows
                  // 4px in each direction over its neighbours instead of
                  // reflowing the strip, so growing the cursor never shifts
                  // the rows around it.
                  transition: scrollAnim ? 'transform .16s ease-out' : 'none',
                }}
              >
                {shown.slice(first, last).map((s, k) => {
                  const i = first + k;
                  const focused = i === selClamped;
                  return (
                    <div
                      key={s.key + i}
                      className="absolute inset-x-0"
                      style={{ top: i * ROW_H + (focused ? -4 : 0), zIndex: focused ? 1 : 0 }}
                    >
                      <SongRow
                        vm={s}
                        diff={diff}
                        focused={focused}
                        paneFocused={pane === 'list'}
                        isFav={favs.has(s.key)}
                        onSelect={() => {
                          setSel(i);
                          setPane('list');
                        }}
                        onPlay={() => {
                          setSel(i);
                          void start();
                        }}
                        onToggleFav={() => toggleFav(s.key)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {shown.length === 0 && !loading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
                <div className="font-display text-[15px] tracking-[0.2em] text-[#ececec]/45">
                  NOTHING IN {collectionLabel(collection).toUpperCase()}
                </div>
                <button
                  onClick={resetFilters}
                  className="border px-[14px] py-[6px] text-[12px] tracking-[0.12em]"
                  style={{ borderColor: AC, color: AC }}
                >
                  CLEAR FILTERS ↺
                </button>
              </div>
            )}

            {drag && (
              <div
                className="absolute inset-0 z-10 flex items-center justify-center text-[15px] tracking-[0.14em]"
                style={{ background: 'rgba(11,12,14,.85)', color: AC }}
              >
                DROP A SONG FOLDER / PACK
              </div>
            )}

            {loading && (
              <div
                className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4"
                style={{ background: 'rgba(11,12,14,.82)' }}
              >
                <div
                  className="text-[15px] tracking-[0.18em]"
                  style={{ color: AC, animation: 'blinkStart 1.4s infinite' }}
                >
                  {loading.msg}
                </div>
                <div className="h-[3px] w-[300px] overflow-hidden bg-white/[0.12]">
                  <div
                    className="h-full transition-[width] duration-150"
                    style={{
                      width: loading.frac != null ? `${Math.round(loading.frac * 100)}%` : '100%',
                      opacity: loading.frac != null ? 1 : 0.25,
                      background: AC,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <SongInspector
          vm={song}
          entry={songEntry}
          diff={diff}
          isFav={song ? favs.has(song.key) : false}
          bannerUrl={song?.entry.bannerUrl ?? null}
          onPickDiff={setDiff}
          onPlay={() => void start()}
        />
      </div>

      {versusOpen && (
        <MultiplayerPanel initialCode={joinCode} onClose={() => setVersusOpen(false)} />
      )}
      {namePromptOpen && <NamePrompt onDone={() => setNamePromptOpen(false)} />}

      <KeyLegend actions={legend} note={note} />
    </div>
  );
}
