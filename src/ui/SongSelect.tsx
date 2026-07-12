/**
 * Song-select screen — a full-viewport layout (fixed-height bars + a flexing
 * list) that fills any aspect ratio: a selected-song detail header with a
 * difficulty-chip stack, a filter strip, sortable columns, and a
 * keyboard-navigated centered list (virtualized for large libraries). The pure
 * row/filter/sort/window logic lives in songSelectModel.ts and the library
 * itself (entries, sources, object-URL lifecycle) in libraryStore.ts; this
 * file owns view state (filters, cursors, overlays) and layout.
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
import { bestChartsPerSlot, DIFF_SLOT_COLORS, DIFF_SLOT_NAMES } from './difficultyUi';
import { GlobalBest } from './GlobalBest';
import { buildChartSeed, type ChartSeed } from './devSeed';
import { ChartStatsSide } from './ChartStatsSide';
import { LeaderboardSide } from './LeaderboardSide';
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
  initials,
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

const AC = '#ff5d47';
const FAV_CLR = '#ffcf3d';
/** Classic 256×80 banner shape — the de-facto standard for pack art. */
const BANNER_RATIO = 256 / 80;

const ROW_H = 44;

/** A distinctive, deterministic gradient for a pack/song that has no art, so
 *  the ones "without bg images" look intentional and varied (each name gets its
 *  own hue) instead of the same flat stripes. */
function artGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (a + 42) % 360;
  return (
    `radial-gradient(135% 130% at 16% -10%, hsl(${a} 62% 34%) 0%, transparent 58%),` +
    `linear-gradient(140deg, hsl(${a} 44% 21%) 0%, hsl(${b} 50% 11%) 100%)`
  );
}

/** Sentinel "pack" that opens the flat all-songs view from the pack wheel. */
const ALL_PACK = '__ALL_SONGS__';
const packLabel = (p: string | null): string => (p === ALL_PACK ? 'ALL SONGS' : (p ?? '—'));

/** A row in the SELECT menu overlay (sort/filter, plus BACK inside a pack). */
type OverlayKind = 'back' | 'sort' | 'min' | 'max' | 'fav' | 'reset';

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

// Filter/selection state kept across remounts (e.g. after returning from a song)
// so the list doesn't reset. Session-scoped (resets on full reload).
const savedFilters = {
  sort: 'pack' as Sort, // packs are the arcade's natural grouping (todos3 #7)
  search: '',
  minLv: 1,
  maxLv: 999, // sentinel "no upper cap" — displayed/applied as the library's max level

  sel: 0,
  diff: 2,
  favOnly: false,
  openPack: null as string | null,
};

export function SongSelect({
  onPlay,
  onOptions,
}: {
  onPlay: (r: PlayRequest) => void;
  onOptions: () => void;
}) {
  // The library domain — entries, sources, load progress, pack art — lives in
  // libraryStore (module-scoped, so scans and lazy loads land there even if
  // this screen unmounts mid-flight); this component only renders it.
  const { entries, sources, loading, packArtVersion } = useSyncExternalStore(
    subscribeLibrary,
    libraryState,
  );
  const [viewH, setViewH] = useState(400);
  const [viewW, setViewW] = useState(1200);
  // Suppress the list's scroll transition for the first moment after mount, so
  // returning to song select doesn't re-animate the list sliding into place
  // (the row offset recomputes once the list height is measured). Real
  // navigation after that animates normally.
  const [scrollAnim, setScrollAnim] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setScrollAnim(true), 160);
    return () => window.clearTimeout(t);
  }, []);
  const gridRef = useRef<HTMLDivElement>(null);
  const selCardRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const restoring = useRef(false);
  const folderRef = useRef<HTMLInputElement>(null);
  // Legacy-background conversion activity + converted-video cache size.
  const [bgConvert, setBgConvert] = useState<BgConvertStatus | null>(null);
  const [videoCache, setVideoCache] = useState<{ bytes: number; count: number } | null>(null);

  useEffect(() => subscribeBgConvert(setBgConvert), []);
  // Cache stats show in the FOLDERS panel; refresh when it opens and as
  // conversions finish.
  useEffect(() => {
    if (showSources) void videoCacheStats().then(setVideoCache);
  }, [showSources, bgConvert]);

  // Enabled sources the browser wants a fresh gesture for drive the reload
  // banner; they clear as grants succeed (sources refreshes after each pass).
  const pendingNames = sources
    .filter((s) => s.enabled && s.permission === 'prompt')
    .map((s) => s.name);

  const [sel, setSel] = useState(savedFilters.sel);
  const [diff, setDiff] = useState(savedFilters.diff);
  const [sort, setSort] = useState<Sort>(savedFilters.sort);
  const [search, setSearch] = useState(savedFilters.search);
  const [minLv, setMinLv] = useState(savedFilters.minLv);
  const [maxLv, setMaxLv] = useState(savedFilters.maxLv);
  const [favOnly, setFavOnly] = useState(savedFilters.favOnly);
  // Pack wheel (always on, ITGmania-style): with no pack open the list shows a
  // table of packs (plus an ALL SONGS group); opening one shows its songs.
  // `packSel` is the pack cursor, `sel` the song cursor within the open pack.
  const [openPack, setOpenPack] = useState<string | null>(savedFilters.openPack);
  const [packSel, setPackSel] = useState(0);
  const [favs, setFavs] = useState(() => loadFavorites());
  const [overlay, setOverlay] = useState(false);
  // VERSUS overlay — owns the keys while open.
  // A ?join=CODE share link opens the versus panel mid-join on first mount
  // (consumed immediately so a later remount doesn't re-trigger it).
  const [joinCode] = useState(consumeJoinCode);
  const [versusOpen, setVersusOpen] = useState(joinCode !== undefined);
  // First-visit name prompt (net/identity); asked once, skippable on the pad.
  // An invite link skips it — the guest came to join, not to fill in forms.
  const [namePromptOpen, setNamePromptOpen] = useState(
    () => shouldPromptForName() && joinCode === undefined,
  );
  const [osel, setOsel] = useState(0);

  // Live room (roomStore) — drives the party dock and the guest song guard.
  const vsRoom = useSyncExternalStore(subscribeRoom, roomState);
  const isRoomGuest = vsRoom.k === 'in-room' && !vsRoom.room.isHost;
  const isRoomHost = vsRoom.k === 'in-room' && vsRoom.room.isHost;
  const roomBrowse = vsRoom.k === 'in-room' ? vsRoom.room : null;
  // What the host is browsing (guests only; re-read on each room notify).
  const browsingLabel = isRoomGuest ? (roomBrowsing()?.title ?? null) : null;
  // Transient "SUGGESTED!" confirmation after a guest nudges a song.
  const [suggested, setSuggested] = useState<string | null>(null);

  // Lifetime stats/scores, fresh each visit (plays recorded while away land).
  const stats = useMemo(() => loadStats(), []);
  const bestsBySong = useMemo(() => buildBestsBySong(loadScores()), []);

  const toggleFav = (k: string) => {
    const next = new Set(favs);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    saveFavorites(next);
    setFavs(next);
  };
  const searchRef = useRef<HTMLInputElement>(null);
  const wheelAcc = useRef(0);
  useGamepadKeys();

  // Measure the (fluid) list viewport for virtualization + centering, and its
  // width for the pack-grid column count.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      setViewH(el.clientHeight);
      setViewW(el.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Seed the starter pack + auto-load remembered folders (once per session —
  // the store serves later mounts instantly), and refresh the source list on
  // every visit: permissions can change while the screen is away.
  useEffect(() => {
    initLibrary();
    void refreshSources();
  }, []);

  // "+ ADD FOLDER": native directory picker where supported (Chromium — the
  // choice is remembered across reloads), <input webkitdirectory> elsewhere.
  const chooseFolder = async () => {
    if (!(await addFolderFromPicker())) folderRef.current?.click();
  };

  // While the banner is up, any real keypress doubles as the permission
  // gesture (the menus are keyboard-first); mouse users click the banner.
  // Synthetic (gamepad-adapter) keys carry no user activation and are skipped.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNames.length]);

  useEffect(() => {
    if (folderRef.current) folderRef.current.webkitdirectory = true;
  }, []);

  const songs = useMemo<SongVM[]>(
    () => toSongVMs(entries, bestsBySong, stats.songPlays),
    [entries, bestsBySong, stats],
  );

  // Highest chart level in the library (floored at 20 so a small library keeps
  // the familiar range). MAX LV defaults to "no cap" (a large sentinel) and is
  // applied/shown as effMaxLv, so charts above 20 — common in ITG/tech packs —
  // are reachable instead of being hidden by the old hard ceiling of 20.
  const levelCeil = useMemo(() => {
    let m = 20;
    for (const s of songs) for (const lv of s.levels) if (lv != null && lv > m) m = lv;
    return m;
  }, [songs]);
  const effMaxLv = Math.min(maxLv, levelCeil);

  const filtered = useMemo(
    () => filterSort(songs, { search, minLv, maxLv: effMaxLv, favOnly, favs, sort, diff }),
    [songs, search, minLv, effMaxLv, favOnly, favs, sort, diff],
  );

  // Pack wheel: an ALL SONGS group, then each pack (from the filtered songs)
  // A→Z with its song count.
  const packList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of filtered) {
      const p = s.pack || '—';
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    const packs = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([pack, count]) => ({ pack, count }));
    return [{ pack: ALL_PACK, count: filtered.length }, ...packs];
  }, [filtered]);

  // Pack-list level (nothing opened) vs inside an opened pack/all-songs group.
  const inPacks = openPack === null;
  const inPack = openPack !== null;
  // Songs shown in the list: the opened pack's songs (or all for ALL SONGS).
  const shownSongs = useMemo(
    () =>
      openPack === null || openPack === ALL_PACK
        ? filtered
        : filtered.filter((s) => (s.pack || '—') === openPack),
    [filtered, openPack],
  );
  const packClamped = Math.min(packSel, Math.max(0, packList.length - 1));
  // Pack grid: adaptive column count from the measured list width.
  const packCols = Math.max(1, Math.min(6, Math.floor((viewW - 56) / 300)));

  // Keep the highlighted pack card in view as the grid cursor moves.
  useEffect(() => {
    if (inPacks) selCardRef.current?.scrollIntoView({ block: 'nearest' });
  }, [packClamped, inPacks]);

  const openPackAt = (idx: number) => {
    const p = packList[idx];
    if (!p) return;
    setPackSel(idx);
    setOpenPack(p.pack);
    setSel(0);
  };
  const closePack = () => {
    setOpenPack(null);
    setSel(0);
  };

  const selClamped = Math.min(sel, Math.max(0, shownSongs.length - 1));
  const song = shownSongs[selClamped];
  const selPack = inPacks ? (packList[packClamped]?.pack ?? null) : null;
  const songBest = song?.bests[diff] ?? null;

  // Host: broadcast the highlighted song so waiting guests see what we're eyeing
  // (deduped in the store; only sends on an actual change).
  useEffect(() => {
    if (isRoomHost && roomBrowse?.phase === 'lobby' && !inPacks && song) {
      announceBrowsing(song.title, song.artist);
    }
  }, [isRoomHost, roomBrowse?.phase, inPacks, song]);

  // The header art box follows each image's own shape (jackets are square,
  // classic banners 3.2:1) instead of cropping everything to one fixed frame.
  // The standard 256×80 banner ratio is the clamp ceiling AND the resting
  // default, and the last loaded shape sticks until the next art loads — so
  // scrolling a pack of standard banners never resizes the box. Art outside
  // the clamp letterboxes over a blurred fill instead of cropping.
  const [artRatio, setArtRatio] = useState<number | null>(null);
  const bannerUrl = song?.entry.bannerUrl ?? null;
  const artW = Math.round(
    144 *
      Math.min(BANNER_RATIO, Math.max(1, bannerUrl ? (artRatio ?? BANNER_RATIO) : BANNER_RATIO)),
  );
  // Pack-wheel header: the highlighted pack's art (if scanned) + song count.
  const packBannerUrl = inPacks && selPack ? (packArtUrl(selPack) ?? null) : null;
  const packCount = inPacks ? (packList[packClamped]?.count ?? 0) : 0;

  // Remember filters/selection so returning from a song restores the list (#2).
  useEffect(() => {
    savedFilters.sort = sort;
    savedFilters.search = search;
    savedFilters.minLv = minLv;
    savedFilters.maxLv = maxLv;
    savedFilters.sel = selClamped;
    savedFilters.diff = diff;
    savedFilters.favOnly = favOnly;
    savedFilters.openPack = openPack;
  });

  // Loop the highlighted song's sample snippet (#5); stop when leaving.
  // Catalog rows load their files/simfile on first highlight (also fills in
  // the banner and real chart list for the detail panel).
  useEffect(() => {
    // No song is "highlighted" while browsing the pack list — stay silent.
    if (inPacks) {
      stopPreview();
      return;
    }
    // Inside a pack but nothing highlighted (filters emptied the list) — the
    // sample would otherwise keep looping with no new preview to supersede it.
    if (!song?.entry) {
      stopPreview();
      return;
    }
    let alive = true;
    void ensureLoaded(song.entry).then((e) => {
      // Already-decoded audio (prefetched neighbors) starts near-instantly.
      if (alive) previewSong(e, previewCached(e) ? 120 : 450);
    });
    return () => {
      alive = false;
    };
  }, [inPacks, song?.entry]);
  useEffect(() => () => stopPreview(), []);

  // DEV-only test hook (mirrors Play.tsx's window.__nfSession): expose the
  // highlighted chart's board hash + chartData + an ideal replay, so the
  // leaderboard e2e can seed genuine, re-simulatable v3 scores on the very
  // chart the header/RANKS panel query. Never attached in production.
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

  // Warm the preview cache for songs near the cursor (todos3 #4), so scrolling
  // onto a neighbor starts its sample immediately instead of after a decode.
  useEffect(() => {
    if (shownSongs.length === 0) return;
    let alive = true;
    const t = setTimeout(() => {
      void (async () => {
        for (const off of [1, -1, 2, -2]) {
          const vm = shownSongs[selClamped + off];
          if (!vm || !alive) continue;
          const e = await ensureLoaded(vm.entry); // no-op unless a catalog row
          if (alive) prefetchSong(e);
        }
      })();
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // shownSongs (not filtered) is what's indexed — it also changes when a pack
    // opens without filtered/selClamped moving, so prefetch the right neighbors.
  }, [selClamped, shownSongs]);

  // The selected song's pack art, a dim backdrop behind the detail header (#8).
  // Read straight from the store cache (recomputed as packArtVersion bumps);
  // the effect below just kicks a one-time walk when it isn't cached yet.
  const packArt = !inPacks && song?.pack ? (packArtUrl(song.pack) ?? null) : null;
  useEffect(() => {
    const pack = song?.pack;
    const e = song?.entry;
    if (inPacks || !pack || !e?.sourceId || !e.lazyDir || !e.lazyDir.includes('/')) return;
    void requestPackArt(pack, e.sourceId, e.lazyDir.slice(0, e.lazyDir.lastIndexOf('/')));
  }, [inPacks, song?.pack, song?.entry]);

  // Grid banners (#8): a catalog-restored library has an empty pack-art cache,
  // so nothing shows on first paint. When the pack grid is up, walk each shown
  // pack's folder once — sequentially (so a large library doesn't fire hundreds
  // of listings at once) and deduped against the detail walk above.
  useEffect(() => {
    if (!inPacks) return;
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
      // `alive` only stops issuing further walks after cleanup — completions
      // repaint via the store subscription regardless.
      for (const j of jobs) {
        if (!alive) return;
        await requestPackArt(j.pack, j.sourceId, j.dir);
      }
    })();
    return () => {
      alive = false;
    };
  }, [inPacks, filtered]);

  // Banner per pack-grid card, recomputed as banners arrive (packArtVersion).
  const packArtByIndex = useMemo(
    () => packList.map((p) => (p.pack === ALL_PACK ? null : (packArtUrl(p.pack) ?? null))),
    [packList, packArtVersion],
  );

  const start = useCallback(async () => {
    // In a room the HOST picks the song; a guest's START suggests the
    // highlighted song to the room instead.
    if (isRoomGuest) {
      const s = shownSongs[Math.min(sel, Math.max(0, shownSongs.length - 1))];
      if (s) {
        suggestSong(s.title, s.artist);
        setSuggested(s.title);
        window.setTimeout(() => setSuggested(null), 2200);
      }
      return;
    }
    const s = shownSongs[Math.min(sel, Math.max(0, shownSongs.length - 1))];
    if (!s || s.levels[diff] == null) return;
    const entry = await ensureLoaded(s.entry); // no-op unless a catalog row
    const chart = bestChartsPerSlot(entry.song)[diff];
    if (!chart) return;
    const audio = await readSongAudio(entry);
    // Playable background, cached conversion of a legacy .avi/.mpg, or null
    // (which also queues a background conversion for next time).
    const bg = await resolveBackground(entry);
    onPlay({ song: entry.song, chart, encodedAudio: audio, backgroundFile: bg, entry });
  }, [shownSongs, sel, diff, onPlay, isRoomGuest]);

  // RESET clears the FILTERS only — sort, search, level range, faves. It must
  // not touch navigation (which pack is open / the grid cursor); resetting your
  // filters shouldn't eject you out to the pack grid.
  const reset = () => {
    setSort('pack');
    setSearch('');
    setMinLv(1);
    setMaxLv(999);
    setFavOnly(false);
  };
  const adjust = (i: number, dir: number) => {
    const kind = overlayRows[i]?.kind;
    if (kind === 'sort') setSort(SORTS[(SORTS.indexOf(sort) + dir + SORTS.length) % SORTS.length]);
    else if (kind === 'min') setMinLv((v) => Math.max(1, Math.min(effMaxLv, v + dir)));
    // Step from the displayed value (effMaxLv), clamped to the library's ceiling.
    else if (kind === 'max')
      setMaxLv((v) => Math.max(minLv, Math.min(levelCeil, Math.min(v, levelCeil) + dir)));
    else if (kind === 'fav') setFavOnly((v) => !v);
  };
  // Confirm on a menu row: BACK leaves the pack, RESET clears filters, the value
  // rows just dismiss (they are tuned with ◀▶, not confirm).
  const activateRow = (i: number) => {
    const kind = overlayRows[i]?.kind;
    if (kind === 'back') {
      closePack();
      setOverlay(false);
    } else if (kind === 'reset') reset();
    else setOverlay(false);
  };

  // Keyboard navigation (arcade model).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const keys = [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Enter',
        'Escape',
        'Shift',
        'f',
        'F',
      ];
      // Honor custom keybinds for select/back (e.g. Slash → confirm), not just
      // the hard-coded Enter/Escape. Directional stays on the arrows so the
      // default KeyD/F/J/K → column binds don't hijack menu nav / the F fave key.
      const role = keyboardRole(e.code);
      const isConfirm = e.key === 'Enter' || role === 'confirm';
      const isBack = e.key === 'Escape' || e.key === 'Shift' || role === 'back';
      if (!keys.includes(e.key) && !isConfirm && !isBack) return;
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      // The VERSUS/name overlays own all keys while open (own listeners).
      if (versusOpen || namePromptOpen) return;
      if (overlay) {
        if (isBack) {
          e.preventDefault();
          setOverlay(false);
          return;
        }
        if (typing && !isConfirm) return;
        e.preventDefault();
        if (e.key === 'ArrowLeft') setOsel((v) => Math.max(0, v - 1));
        else if (e.key === 'ArrowRight') setOsel((v) => Math.min(overlayRows.length - 1, v + 1));
        else if (e.key === 'ArrowUp') adjust(osel, 1);
        else if (e.key === 'ArrowDown') adjust(osel, -1);
        else if (isConfirm) activateRow(osel);
      } else if (inPacks) {
        // Pack grid: ◀▶ move one, ▲▼ move a row (packCols), confirm opens.
        if (typing) return;
        e.preventDefault();
        const n = Math.max(1, packList.length);
        const cols = packCols;
        // Functional updates advance from the LATEST cursor (never a stale one).
        if (e.key === 'ArrowLeft') setPackSel((p) => Math.max(0, Math.min(p, n - 1) - 1));
        else if (e.key === 'ArrowRight') setPackSel((p) => Math.min(n - 1, Math.min(p, n - 1) + 1));
        else if (e.key === 'ArrowUp')
          setPackSel((p) => {
            const c = Math.min(p, n - 1);
            return c - cols >= 0 ? c - cols : c;
          });
        else if (e.key === 'ArrowDown')
          setPackSel((p) => Math.min(n - 1, Math.min(p, n - 1) + cols));
        else if (isConfirm) openPackAt(packClamped);
        // The grid is the root (nowhere to back out to), so SELECT jumps
        // straight to joining a versus room — the room defines the chart, so
        // a joiner never needs to pick a song first.
        else if (isBack) setVersusOpen(true);
      } else {
        if (typing) return;
        e.preventDefault();
        const n = Math.max(1, shownSongs.length);
        if (e.key === 'ArrowUp') setSel((s) => (Math.min(s, n - 1) - 1 + n) % n);
        else if (e.key === 'ArrowDown') setSel((s) => (Math.min(s, n - 1) + 1) % n);
        else if (e.key === 'ArrowLeft') setDiff((v) => Math.max(0, v - 1));
        else if (e.key === 'ArrowRight') setDiff((v) => Math.min(4, v + 1));
        else if (isConfirm) void start();
        else if (e.key === 'f' || e.key === 'F') {
          const s = shownSongs[selClamped];
          if (s) toggleFav(s.key);
        } else if (isBack) {
          // SELECT opens the menu (sort/filter, plus BACK TO PACKS inside a pack,
          // pre-highlighted so SELECT→START steps back up a level).
          setOverlay(true);
          setOsel(0);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    overlay,
    versusOpen,
    namePromptOpen,
    osel,
    filtered,
    selClamped,
    packClamped,
    packCols,
    inPacks,
    inPack,
    openPack,
    packList,
    shownSongs,
    start,
    sort,
    minLv,
    maxLv,
    favs,
  ]);

  const onDrop = async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDrag(false);
    await addDropped(e.dataTransfer);
  };

  // Virtualized window: center the cursor (pack or song), clamp at the ends.
  const total = inPacks ? packList.length : shownSongs.length;
  const { off, first, last, topFade, botFade } = virtualWindow(
    total,
    viewH,
    inPacks ? packClamped : selClamped,
    ROW_H,
  );

  const chips = DIFF_SLOT_NAMES.map((name, i) => {
    const lv = song?.levels[i];
    const on = i === diff;
    const has = lv != null;
    return { name, lv: has ? lv : '—', clr: DIFF_SLOT_COLORS[i], on, has };
  });

  // The SELECT menu. Inside a pack it leads with BACK TO PACKS, so SELECT is the
  // single "menu" button (options + up-a-level) the whole pad flow needs.
  const overlayRows: { label: string; value: string; kind: OverlayKind }[] = [
    ...(inPack ? [{ label: 'BACK', value: '‹ PACKS', kind: 'back' as OverlayKind }] : []),
    { label: 'SORT', value: sort.toUpperCase(), kind: 'sort' },
    { label: 'MIN LV', value: String(minLv), kind: 'min' },
    { label: 'MAX LV', value: String(effMaxLv), kind: 'max' },
    { label: 'FAVES', value: favOnly ? '★ ONLY' : 'ALL', kind: 'fav' },
    { label: 'RESET', value: '↺', kind: 'reset' },
  ];

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
      {/* Header */}
      <div className="flex h-[56px] flex-none items-center justify-between border-b border-white/[0.09] px-[28px]">
        <div className="flex items-baseline gap-3">
          <span className="text-[19px] font-bold tracking-[0.22em]">STEPZONE</span>
          <span className="text-[13px] tracking-[0.18em]" style={{ color: AC }}>
            SONG SELECT
          </span>
        </div>
        <div className="flex items-center gap-4 text-[13px] tracking-[0.08em] text-[#ececec]/62">
          <span title="Lifetime steps hit">{stats.steps.toLocaleString()} STEPS</span>
          <span>{filtered.length} SONGS</span>
          <button
            onClick={() => setShowSources((v) => !v)}
            className="border px-[10px] py-[4px] hover:border-[#ff5d47] hover:text-[#ececec]"
            style={{ borderColor: showSources ? AC : 'rgba(255,255,255,.14)' }}
            title="Manage song folders"
          >
            FOLDERS{sources.length > 0 ? ` (${sources.length})` : ''} ▾
          </button>
          <button onClick={onOptions} className="hover:text-[#ececec]" title="Options">
            ⚙
          </button>
        </div>
      </div>

      {/* Song-folder sources panel */}
      {showSources && (
        <div className="absolute right-[20px] top-[54px] z-30 w-[360px] border border-white/[0.14] bg-[#101114] p-[14px] text-[12px] tracking-[0.08em]">
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
                    title="Rescan this folder (pick up added/removed songs)"
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
              <span title="Legacy .avi/.mpg backgrounds converted for browser playback">
                BG VIDEO CACHE — {(videoCache.bytes / 1048576).toFixed(0)} MB ({videoCache.count})
              </span>
              <button
                onClick={() =>
                  void clearVideoCache().then(() => videoCacheStats().then(setVideoCache))
                }
                className="hover:text-[#ff5d47]"
                title="Delete converted videos (they re-convert on next play)"
              >
                CLEAR
              </button>
            </div>
          )}
        </div>
      )}

      {/* Pending-source restore (browsers require a gesture to re-grant access) */}
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

      {/* Detail panel — the selected song's pack art shows here (todos3 #8),
          a dim cinematic strip behind the header instead of washing out the
          whole list. */}
      <div
        className="flex h-[176px] flex-none items-center gap-6 border-b border-white/[0.09] px-[28px]"
        style={
          (inPacks ? packBannerUrl : packArt)
            ? {
                backgroundImage: `linear-gradient(to right, #0b0c0e 0%, rgba(11,12,14,.55) 30%, rgba(11,12,14,.55) 70%, #0b0c0e 100%), url(${inPacks ? packBannerUrl : packArt})`,
                backgroundSize: 'auto, cover',
                backgroundPosition: 'center, center',
              }
            : undefined
        }
      >
        <div
          className="relative h-[144px] flex-none overflow-hidden outline outline-1 outline-white/[0.14]"
          style={{ width: artW, transition: 'width .16s ease-out' }}
        >
          {inPacks ? (
            packBannerUrl ? (
              <img src={packBannerUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div
                className="flex h-full w-full items-center justify-center text-[42px] font-bold tracking-[0.06em] text-white/90"
                style={{
                  background: artGradient(selPack === ALL_PACK ? 'ALL SONGS' : (selPack ?? '')),
                }}
              >
                {selPack === ALL_PACK ? 'ALL' : selPack ? initials(selPack) : ''}
              </div>
            )
          ) : bannerUrl ? (
            <>
              <img
                src={bannerUrl}
                alt=""
                aria-hidden
                className="absolute inset-0 h-full w-full scale-110 object-cover blur-md brightness-[.4]"
              />
              <img
                key={bannerUrl}
                src={bannerUrl}
                alt=""
                loading="lazy"
                onLoad={(e) => {
                  const el = e.currentTarget;
                  if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                    setArtRatio(el.naturalWidth / el.naturalHeight);
                  }
                }}
                className="relative h-full w-full object-contain"
              />
            </>
          ) : (
            <div
              className="flex h-full w-full items-center justify-center text-[48px] font-bold tracking-[0.06em] text-white/90"
              style={{ background: artGradient(song?.title ?? '') }}
            >
              {song ? initials(song.title) : ''}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          {inPacks ? (
            <>
              <div className="text-[13px] tracking-[0.24em] text-[#ececec]/62">PACK</div>
              <div className="truncate text-[34px] font-bold leading-[1.15]">
                {packLabel(selPack)}
              </div>
              <div className="mt-2 flex gap-4 text-[14px] tracking-[0.06em] text-[#ececec]/62">
                <span>
                  {packCount} SONG{packCount === 1 ? '' : 'S'}
                </span>
                <span className="font-bold" style={{ color: AC }}>
                  SELECT TO OPEN ›
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="flex min-w-0 items-center gap-3">
                <button
                  onClick={() => song && toggleFav(song.key)}
                  title="Favorite (F)"
                  className="flex-none text-[26px] leading-none"
                  style={{ color: song && favs.has(song.key) ? FAV_CLR : 'rgba(236,236,236,.4)' }}
                >
                  {song && favs.has(song.key) ? '★' : '☆'}
                </button>
                <div className="truncate text-[34px] font-bold leading-[1.15]">
                  {song?.title ?? '—'}
                </div>
              </div>
              <div className="text-[17px] text-[#ececec]/60">{song?.artist ?? ''}</div>
              <div className="mt-2 flex items-center gap-4 text-[14px] tracking-[0.06em] text-[#ececec]/62">
                <span>BPM {song?.bpm ?? '—'}</span>
                {inPack ? (
                  <button
                    onClick={closePack}
                    className="font-bold hover:text-[#ececec]"
                    style={{ color: AC }}
                    title="Back to packs (Esc)"
                  >
                    ‹ {packLabel(openPack)}
                  </button>
                ) : (
                  <span>{song?.pack ?? ''}</span>
                )}
                <span className="font-bold" style={{ color: AC }}>
                  {DIFF_SLOT_NAMES[diff]} {song?.levels[diff] ?? '—'}
                </span>
                {songBest && (
                  <span style={{ color: '#59f07f' }}>
                    BEST {(songBest.percent * 100).toFixed(2)}% · {songBest.grade}
                  </span>
                )}
                <GlobalBest entry={song?.entry ?? null} diff={diff} />
                {song != null && song.plays > 0 && <span>{song.plays} PLAYS</span>}
              </div>
            </>
          )}
        </div>
        {!inPacks && (
          <div className="flex flex-none flex-col items-stretch gap-[5px]">
            {chips.map((c, i) => (
              <button
                key={c.name}
                onClick={() => setDiff(i)}
                disabled={!c.has}
                className="flex w-[158px] items-center gap-2 border px-[10px] py-[4px] text-[12px] tracking-[0.1em]"
                style={{
                  cursor: c.has ? 'pointer' : 'default',
                  opacity: c.has ? 1 : 0.3,
                  color: c.on ? '#ececec' : 'rgba(236,236,236,.55)',
                  borderColor: c.on ? AC : 'rgba(255,255,255,.12)',
                  background: c.on ? AC + '1a' : 'transparent',
                }}
              >
                <span className="h-2 w-2 flex-none rounded-full" style={{ background: c.clr }} />
                <span className="flex-1 text-left">{c.name}</span>
                <span className="font-bold">{c.lv}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Filter strip */}
      <div className="flex h-[46px] flex-none items-center gap-2 border-b border-white/[0.09] px-[28px]">
        <input
          ref={searchRef}
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setSel(0);
          }}
          placeholder="SEARCH…"
          className="w-[210px] border border-white/[0.14] bg-transparent px-[10px] py-[6px] text-[13px] tracking-[0.04em] text-[#ececec] outline-none"
        />
        {/* Sort/filter are a song-list tool; the pack grid keeps only SEARCH. */}
        {!inPacks &&
          overlayRows.map((o, i) => {
            const on = overlay && i === osel;
            // Action rows (BACK/RESET) fire on START/click;
            // value rows tune with ▲▼ — style them apart so the difference
            // reads at a glance (buttons get the accent tint, options don't).
            const isAction = o.kind === 'back' || o.kind === 'reset';
            const cls =
              'flex items-center gap-2 border px-[10px] py-[6px] text-[12px] tracking-[0.08em] whitespace-nowrap' +
              (isAction ? ' font-bold' : '');
            const st = isAction
              ? {
                  color: on ? '#ececec' : 'rgba(236,236,236,.8)',
                  borderColor: on ? AC : AC + '59',
                  background: on ? AC + '2b' : AC + '0d',
                }
              : {
                  color: on ? '#ececec' : 'rgba(236,236,236,.55)',
                  borderColor: on ? AC : 'rgba(255,255,255,.12)',
                  background: on ? AC + '14' : 'transparent',
                };
            // The level ranges clamp (no wrap), so a single-direction click would
            // strand the value — mouse users get explicit −/+ steppers. Keyboard
            // ▲▼ still adjusts the focused row.
            if (o.kind === 'min' || o.kind === 'max') {
              return (
                <div key={o.label} className={cls} style={st}>
                  <span className="opacity-60">{o.label}</span>
                  <button
                    aria-label={`decrease ${o.label}`}
                    className="px-[3px] font-bold hover:text-white"
                    onClick={() => {
                      setOsel(i);
                      adjust(i, -1);
                    }}
                  >
                    −
                  </button>
                  <span className="min-w-[18px] text-center font-bold">{o.value}</span>
                  <button
                    aria-label={`increase ${o.label}`}
                    className="px-[3px] font-bold hover:text-white"
                    onClick={() => {
                      setOsel(i);
                      adjust(i, 1);
                    }}
                  >
                    +
                  </button>
                </div>
              );
            }
            return (
              <button
                key={o.label}
                onClick={() => {
                  setOsel(i);
                  if (isAction) activateRow(i);
                  else adjust(i, 1);
                }}
                className={cls}
                style={st}
              >
                <span className={isAction ? '' : 'opacity-60'}>{o.label}</span>
                <span className="font-bold">{o.value}</span>
              </button>
            );
          })}
        <span className="flex-1" />
        {overlay && (
          <span className="text-[11px] tracking-[0.14em]" style={{ color: AC }}>
            {(() => {
              const k = overlayRows[Math.min(osel, overlayRows.length - 1)]?.kind;
              const action = k === 'back' || k === 'reset';
              return action
                ? '◀▶ MOVE · START — GO · SELECT — CLOSE'
                : '◀▶ MOVE · ▲▼ ADJUST · SELECT — CLOSE';
            })()}
          </span>
        )}
      </div>

      {/* Virtualized song list + the live board for the highlighted chart */}
      <div className="flex min-h-0 flex-1">
        {/* Header + rows share one column so they line up whether or not the
            RANKS panel (right) is present (it's absent offline / under 1100px). */}
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Column headers (song list only). */}
          {!inPacks && (
            <div className="grid h-[28px] flex-none grid-cols-[1.25fr_1fr_0.7fr_84px_84px_56px_64px] items-center gap-[18px] border-b border-white/[0.06] px-[28px]">
              {(
                [
                  ['TITLE', 'title', false],
                  ['ARTIST', 'artist', false],
                  ['PACK', 'pack', false],
                  ['BPM', 'bpm', true],
                  ['BEST', 'best', true],
                  ['PLAYS', 'plays', true],
                  ['LV', 'level', true],
                ] as const
              ).map(([label, key, end]) => {
                const on = sort === key;
                return (
                  <button
                    key={key}
                    onClick={() => {
                      setSort(key);
                      setSel(0);
                    }}
                    className="text-[11px] tracking-[0.14em] whitespace-nowrap"
                    style={{
                      justifySelf: end ? 'end' : 'start',
                      color: on ? AC : 'rgba(236,236,236,.4)',
                      fontWeight: on ? 700 : 400,
                    }}
                  >
                    {label}
                    {on ? ' ▾' : ''}
                  </button>
                );
              })}
            </div>
          )}
          <div
            ref={listRef}
            className="relative min-h-0 flex-1 overflow-hidden"
            onWheel={(e) => {
              // Song list: the wheel moves the selection (this container has no native
              // scroll). The pack grid scrolls natively (its own overflow-y-auto), so
              // leave the wheel to it — moving packSel here would double-move.
              if (inPacks) return;
              // Accumulate for trackpads.
              wheelAcc.current += e.deltaY;
              const step = 30;
              if (Math.abs(wheelAcc.current) < step) return;
              const dir = wheelAcc.current > 0 ? 1 : -1;
              wheelAcc.current = 0;
              const n = Math.max(1, shownSongs.length);
              setSel((prev) => Math.max(0, Math.min(n - 1, Math.min(prev, n - 1) + dir)));
            }}
          >
            {inPacks && (
              <div ref={gridRef} className="absolute inset-0 overflow-y-auto px-[20px] py-[16px]">
                <div
                  className="grid gap-[14px]"
                  style={{ gridTemplateColumns: `repeat(${packCols}, minmax(0, 1fr))` }}
                >
                  {packList.map((p, i) => {
                    const on = i === packClamped;
                    const art = packArtByIndex[i] ?? null;
                    return (
                      <div
                        key={p.pack}
                        ref={on ? selCardRef : undefined}
                        onClick={() => setPackSel(i)}
                        onDoubleClick={() => openPackAt(i)}
                        className="flex cursor-pointer flex-col overflow-hidden border transition-all"
                        style={{
                          borderColor: on ? AC : 'rgba(255,255,255,.10)',
                          background: on ? AC + '26' : 'rgba(255,255,255,.02)',
                          // Inset 2px accent ring (no layout shift) + a stronger glow
                          // so the highlighted pack reads at a glance across the grid.
                          boxShadow: on
                            ? `inset 0 0 0 2px ${AC}, 0 0 0 1px ${AC}, 0 6px 26px ${AC}55`
                            : 'none',
                        }}
                      >
                        <div
                          className="relative w-full overflow-hidden bg-black/40"
                          style={{ aspectRatio: '256 / 80' }}
                        >
                          {art ? (
                            <img src={art} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <div
                              className="flex h-full w-full items-center justify-center text-[24px] font-bold tracking-[0.08em] text-white/85"
                              style={{
                                background: artGradient(p.pack === ALL_PACK ? 'ALL SONGS' : p.pack),
                              }}
                            >
                              {p.pack === ALL_PACK ? '★ ALL' : initials(p.pack)}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-2 px-[12px] py-[9px]">
                          <span
                            className="truncate text-[15px] font-bold"
                            style={{ color: on ? '#ececec' : 'rgba(236,236,236,.82)' }}
                          >
                            {packLabel(p.pack)}
                          </span>
                          <span
                            className="flex-none text-[12px] tracking-[0.06em]"
                            style={{ color: on ? AC : 'rgba(236,236,236,.4)' }}
                          >
                            {p.count}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {!inPacks && (
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
                    height: total * ROW_H,
                    transform: `translateY(${off}px)`,
                    transition: scrollAnim ? 'transform .16s ease-out' : 'none',
                  }}
                >
                  {shownSongs.slice(first, last).map((s, k) => {
                    const i = first + k;
                    const on = i === selClamped;
                    const lv = s.levels[diff];
                    const best = s.bests[diff];
                    return (
                      <div
                        key={i}
                        onClick={() => setSel(i)}
                        onDoubleClick={() => {
                          setSel(i);
                          void start();
                        }}
                        className="absolute inset-x-0 grid cursor-pointer grid-cols-[1.25fr_1fr_0.7fr_84px_84px_56px_64px] items-center gap-[18px] border-b border-white/[0.04] px-[28px] whitespace-nowrap"
                        style={{
                          top: i * ROW_H,
                          height: ROW_H,
                          fontSize: 16,
                          fontWeight: on ? 700 : 400,
                          color: on ? '#ececec' : 'rgba(236,236,236,.6)',
                          background: on ? AC + '1a' : 'transparent',
                          borderLeft: on ? `2px solid ${AC}` : '2px solid transparent',
                        }}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFav(s.key);
                            }}
                            title="Favorite (F)"
                            aria-label={favs.has(s.key) ? 'Unfavorite' : 'Favorite'}
                            className="flex-none text-[15px] leading-none"
                            style={{ color: favs.has(s.key) ? FAV_CLR : 'rgba(236,236,236,.4)' }}
                          >
                            {favs.has(s.key) ? '★' : '☆'}
                          </button>
                          <span className="overflow-hidden text-ellipsis">{s.title}</span>
                        </span>
                        <span
                          className="overflow-hidden text-ellipsis"
                          style={{ color: on ? '#ececec' : 'rgba(236,236,236,.62)' }}
                        >
                          {s.artist}
                        </span>
                        <span
                          className="overflow-hidden text-ellipsis text-[14px]"
                          style={{ color: on ? '#ececec' : 'rgba(236,236,236,.5)' }}
                        >
                          {s.pack || '—'}
                        </span>
                        <span className="justify-self-end opacity-60">{s.bpm}</span>
                        <span
                          className="justify-self-end text-[13px]"
                          style={{ color: on ? '#ececec' : 'rgba(236,236,236,.7)' }}
                        >
                          {best ? `${(best.percent * 100).toFixed(1)} ${best.grade}` : ''}
                        </span>
                        <span
                          className="justify-self-end text-[13px]"
                          style={{ color: on ? '#ececec' : 'rgba(236,236,236,.5)' }}
                        >
                          {s.plays > 0 ? s.plays : ''}
                        </span>
                        <span
                          className="justify-self-end min-w-[40px] px-2 py-px text-center text-[14px] font-bold"
                          style={{ background: AC + '1f', color: AC }}
                        >
                          {lv == null ? '—' : lv}
                        </span>
                      </div>
                    );
                  })}
                </div>
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
                <div
                  className="h-[3px] w-[300px] overflow-hidden"
                  style={{ background: 'rgba(255,255,255,.12)' }}
                >
                  <div
                    className="h-full transition-[width] duration-150"
                    style={{
                      // Determinate bar while parsing (frac known); dim full bar
                      // while scanning so it never looks stalled at 0%.
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

        {!inPacks && (
          // One right column: leaderboard on top, chart stats stacked below it
          // (so it costs no extra width, and its height changes push nothing).
          <div className="hidden w-[300px] flex-none flex-col overflow-hidden border-l border-white/[0.09] min-[1100px]:flex">
            <LeaderboardSide entry={song?.entry ?? null} diff={diff} />
            <ChartStatsSide entry={song?.entry ?? null} diff={diff} />
          </div>
        )}
      </div>

      {versusOpen && (
        <MultiplayerPanel initialCode={joinCode} onClose={() => setVersusOpen(false)} />
      )}

      {/* The room dock (party roster) is a global element pinned bottom-right
          by App — not rendered per-screen, so it stays put as you navigate. */}

      {namePromptOpen && <NamePrompt onDone={() => setNamePromptOpen(false)} />}

      {/* Hint bar — context-aware (pack grid vs song list). */}
      <div className="flex h-[44px] flex-none items-center gap-6 border-t border-white/[0.09] px-[28px] text-[12px] tracking-[0.14em] text-[#ececec]/62">
        {isRoomGuest ? (
          // A guest can't pick — the host chooses — but can suggest a song and
          // see what the host is currently browsing.
          <>
            <span style={{ color: AC }} className="tracking-[0.16em]">
              {suggested
                ? `SUGGESTED “${suggested}”`
                : roomBrowse?.song
                  ? 'THE HOST PICKED A SONG — GET READY'
                  : browsingLabel
                    ? `HOST IS LOOKING AT: ${browsingLabel}`
                    : 'IN A ROOM — THE HOST PICKS THE SONG'}
            </span>
            {!inPacks && (
              <span style={{ color: AC, animation: 'blinkStart 1.4s infinite' }}>
                START — SUGGEST THIS SONG
              </span>
            )}
          </>
        ) : inPacks ? (
          <>
            <span>◀▶▲▼ PACK</span>
            <span style={{ color: AC, animation: 'blinkStart 1.4s infinite' }}>START — OPEN</span>
            <button onClick={() => setVersusOpen(true)} className="hover:text-[#ececec]">
              SELECT — MULTIPLAYER
            </button>
          </>
        ) : (
          <>
            <span>▲▼ SONG</span>
            <span>◀▶ DIFFICULTY</span>
            <span style={{ color: AC, animation: 'blinkStart 1.4s infinite' }}>START — PLAY</span>
            <button onClick={() => setOverlay((v) => !v)} className="hover:text-[#ececec]">
              {inPack ? 'SELECT — MENU' : 'SELECT — SORT / FILTER'}
            </button>
            <span>F — FAVORITE</span>
          </>
        )}
      </div>
    </div>
  );
}
