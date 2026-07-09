/**
 * Song-select screen — a full-viewport layout (fixed-height bars + a flexing
 * list) that fills any aspect ratio: a selected-song detail header with a
 * difficulty-chip stack, a filter strip, sortable columns, and a
 * keyboard-navigated centered list (virtualized for large libraries). The pure
 * row/filter/sort/window logic lives in songSelectModel.ts; this file owns
 * state, effects, and layout.
 */
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { starterEntries } from '../starter';
import {
  filesFromDataTransfer,
  loadLibraryFromFiles,
  pickPackImage,
  readSongAudio,
  type LibraryEntry,
} from '../io/songFiles';
import { resolveBackground, subscribeBgConvert, type BgConvertStatus } from '../io/bgVideo';
import { clearVideoCache, videoCacheStats } from '../io/videoCache';
import {
  addSourceFromDrop,
  addSourceFromPicker,
  ensureSourcePermission,
  grantPendingSources,
  listSources,
  loadCatalog,
  readSongFolder,
  readSource,
  removeSource,
  restoreSources,
  saveCatalog,
  setSourceEnabled,
  supportsFolderPicker,
  type SongSource,
} from '../io/localFolder';
import { prefetchSong, previewCached, previewSong, stopPreview } from '../audio/songPreview';
import { loadFavorites, saveFavorites } from '../app/favorites';
import { keyboardRole } from '../input/inputBus';
import { loadScores } from '../app/scores';
import { loadStats } from '../app/stats';
import { bestChartsPerSlot, DIFF_SLOT_COLORS, DIFF_SLOT_NAMES } from './difficultyUi';
import type { PlayRequest } from './playRequest';
import { useGamepadKeys } from './useGamepadKeys';
import {
  bpmText,
  buildBestsBySong,
  deriveLevels,
  entryDir,
  entryFromCatalog,
  filterSort,
  initials,
  SORTS,
  toSongVMs,
  virtualWindow,
  type SongVM,
  type Sort,
} from './songSelectModel';

const AC = '#ff5d47';
const FAV_CLR = '#ffcf3d';
/** Classic 256×80 banner shape — the de-facto standard for pack art. */
const BANNER_RATIO = 256 / 80;

const ROW_H = 44;

// The loaded library, kept across remounts like the filters below: returning
// from a song reuses it instead of re-reading the folder and re-deriving every
// row (parsed simfiles on the entries survive too). Session-scoped — a full
// page reload restores the library from the remembered folder on disk.
let libraryCache: LibraryEntry[] | null = null;

// Pack background art (todos3 #8): pack name -> object URL, null = known none.
// Module-scoped like libraryCache so revisits don't re-read pack folders.
const packArtUrls = new Map<string, string | null>();

/** Stash freshly-walked pack art (full scans carry the pack-root files). */
function stashPackImages(packImages: Map<string, File>): void {
  for (const [pack, file] of packImages) {
    if (!packArtUrls.get(pack)) packArtUrls.set(pack, URL.createObjectURL(file));
  }
}

// Filter/selection state kept across remounts (e.g. after returning from a song)
// so the list doesn't reset. Session-scoped (resets on full reload).
const savedFilters = {
  sort: 'pack' as Sort, // packs are the arcade's natural grouping (todos3 #7)
  search: '',
  minLv: 1,
  maxLv: 20,
  sel: 0,
  diff: 2,
  favOnly: false,
  group: 'all' as 'all' | 'pack',
  openPack: null as string | null,
};

export function SongSelect({
  onPlay,
  onOptions,
}: {
  onPlay: (r: PlayRequest) => void;
  onInspect: () => void;
  onOptions: () => void;
}) {
  const [entries, setEntries] = useState<LibraryEntry[]>(() => libraryCache ?? []);
  const [viewH, setViewH] = useState(400);
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  // Load status shown as an overlay over the list ("SCANNING…", "LOADING m/n").
  const [loading, setLoading] = useState<{ msg: string; frac?: number } | null>(null);
  // The remembered folder sources (io/localFolder) and their management panel.
  const [sources, setSources] = useState<SongSource[]>([]);
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
  const [group, setGroup] = useState<'all' | 'pack'>(savedFilters.group);
  // Pack-wheel drill-down: in 'pack' mode with no open pack, the list shows a
  // table of packs; opening one shows its songs. `packSel` is the pack cursor.
  const [openPack, setOpenPack] = useState<string | null>(savedFilters.openPack);
  const [packSel, setPackSel] = useState(0);
  const [favs, setFavs] = useState(() => loadFavorites());
  const [overlay, setOverlay] = useState(false);
  const [osel, setOsel] = useState(0);

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

  // Measure the (fluid) list viewport for virtualization + centering.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the module cache current: once real library content is in (a loaded
  // or catalog-cached song folder), leaving the screen must not lose it.
  useEffect(() => {
    if (entries.some((e) => e.files.length > 0 || e.sourceId)) libraryCache = entries;
  }, [entries]);

  // Parse a folder's files into entries. Entries from a remembered source are
  // tagged with its id, replace that source's previous songs (so rescans are
  // idempotent), and are summarized into a cached catalog so the next reload
  // skips the walk+parse entirely; untagged loads (multi-folder drops, the
  // fallback input) simply append for this session. The starter pack stays.
  const addSourceEntries = useCallback(async (files: File[], sourceId?: string) => {
    if (files.length === 0) return;
    setLoading({ msg: 'LOADING SONGS…' });
    try {
      const { entries: loaded, packImages } = await loadLibraryFromFiles(files, (done, total) =>
        setLoading({ msg: `LOADING SONGS… ${done} / ${total}`, frac: done / total }),
      );
      stashPackImages(packImages);
      const tagged = sourceId ? loaded.map((e) => ({ ...e, sourceId })) : loaded;
      if (tagged.length) {
        setEntries((prev) => [
          ...prev.filter((e) => !sourceId || e.sourceId !== sourceId),
          ...tagged,
        ]);
      }
      if (sourceId) {
        void saveCatalog(
          sourceId,
          tagged.map((e) => {
            const bpm = bpmText(e);
            return {
              dir: entryDir(e),
              title: e.song.displayFullTitle || e.sourceName,
              artist: e.song.artist,
              pack: e.pack,
              bpm: bpm.sort > 0 ? bpm.text : undefined,
              levels: deriveLevels(e.song),
            };
          }),
        );
      }
    } finally {
      setLoading(null);
    }
  }, []);

  // Bring one source into the library: from its cached catalog when available
  // (instant — no disk walk), else a full scan that also writes the catalog.
  const loadSource = useCallback(
    async (id: string, forceScan = false) => {
      if (!forceScan) {
        const cached = await loadCatalog(id);
        if (cached && cached.length > 0) {
          setEntries((prev) => [
            ...prev.filter((e) => e.sourceId !== id),
            ...cached.map((c) => entryFromCatalog(id, c)),
          ]);
          return;
        }
      }
      const folder = await readSource(id, (n) =>
        setLoading({ msg: `SCANNING FOLDER… ${n} FILES` }),
      );
      if (folder) await addSourceEntries(folder.files, id);
      setLoading(null);
    },
    [addSourceEntries],
  );

  // A catalog row being opened: read its song folder (one directory listing)
  // and parse the simfile, writing the result back onto the entry in place.
  const ensureLoaded = useCallback(async (entry: LibraryEntry): Promise<LibraryEntry> => {
    if (!entry.lazyDir || !entry.sourceId || entry.song.charts.length > 0) return entry;
    const files = await readSongFolder(entry.sourceId, entry.lazyDir);
    if (!files || files.length === 0) return entry;
    const { entries: parsed } = await loadLibraryFromFiles(files);
    const full = parsed[0];
    if (!full) return entry;
    const merged: LibraryEntry = {
      ...entry,
      song: full.song,
      files: full.files,
      bannerUrl: full.bannerUrl,
    };
    setEntries((prev) => prev.map((e) => (e === entry ? merged : e)));
    return merged;
  }, []);

  // Folder-walk progress ticks (the phase before any songs can be counted).
  const scanTick = useCallback(
    (n: number) => setLoading({ msg: `SCANNING FOLDER… ${n} FILES` }),
    [],
  );

  // Auto-load the remembered song folder, once per session (on a remount the
  // cache serves the list instantly). A remembered folder the browser won't
  // silently re-open surfaces as a click-to-restore banner instead.
  useEffect(() => {
    if (libraryCache) return;
    let cancelled = false;
    // The bundled starter pack — synthesized originals, so a fresh install has
    // real songs to play before any folder is picked. A loaded folder is
    // appended after these (addSourceEntries keeps file-less entries).
    setEntries(starterEntries());
    void (async () => {
      const { granted } = await restoreSources();
      if (cancelled) return;
      for (const g of granted) await loadSource(g.id);
      setSources(await listSources());
      setLoading(null);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The panel needs the source list even when the library came from the
  // remount cache (the effect above returns early then).
  useEffect(() => {
    void listSources().then(setSources);
  }, []);

  // "+ ADD FOLDER": native directory picker where supported (Chromium — the
  // choice is remembered across reloads), <input webkitdirectory> elsewhere.
  const chooseFolder = async () => {
    if (supportsFolderPicker()) {
      const added = await addSourceFromPicker(scanTick);
      if (added) {
        await addSourceEntries(added.folder.files, added.id);
        setSources(await listSources());
      }
      setLoading(null);
    } else {
      folderRef.current?.click();
    }
  };

  // Re-grant access to the pending sources and load them (cached catalogs make
  // this near-instant). Sources still denied (dismissed prompt, no activation)
  // stay in the banner for another try; dead folders are dropped by the layer.
  const finishRestore = async () => {
    const wasPending = new Set(
      sources.filter((s) => s.enabled && s.permission === 'prompt').map((s) => s.id),
    );
    await grantPendingSources();
    const after = await listSources();
    for (const s of after) {
      if (s.enabled && s.permission === 'granted' && wasPending.has(s.id)) {
        await loadSource(s.id);
      }
    }
    setSources(after);
    setLoading(null);
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

  // Source management (FOLDERS panel): toggle a source's songs in/out of the
  // library, rescan one whose contents changed on disk, or forget it entirely.
  // Enabling/rescanning may prompt for permission (the click is the gesture).
  const toggleSource = async (s: SongSource) => {
    if (s.enabled) {
      await setSourceEnabled(s.id, false);
      setEntries((prev) => prev.filter((e) => e.sourceId !== s.id));
    } else {
      await setSourceEnabled(s.id, true);
      if (await ensureSourcePermission(s.id)) await loadSource(s.id);
      setLoading(null);
    }
    setSources(await listSources());
  };

  const rescanSource = async (s: SongSource) => {
    await loadSource(s.id, true);
    setSources(await listSources());
  };

  const removeSrc = async (s: SongSource) => {
    await removeSource(s.id);
    setEntries((prev) => prev.filter((e) => e.sourceId !== s.id));
    setSources(await listSources());
  };

  useEffect(() => {
    if (folderRef.current) folderRef.current.webkitdirectory = true;
  }, []);

  const songs = useMemo<SongVM[]>(
    () => toSongVMs(entries, bestsBySong, stats.songPlays),
    [entries, bestsBySong, stats],
  );

  const filtered = useMemo(
    () => filterSort(songs, { search, minLv, maxLv, favOnly, favs, sort, diff }),
    [songs, search, minLv, maxLv, favOnly, favs, sort, diff],
  );

  // Pack wheel: the list of packs (from the filtered songs), A→Z with counts.
  const packList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of filtered) {
      const p = s.pack || '—';
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([pack, count]) => ({ pack, count }));
  }, [filtered]);

  // Pack-list level (pack mode, nothing opened) vs inside an opened pack.
  const inPacks = group === 'pack' && openPack === null;
  const inPack = group === 'pack' && openPack !== null;
  // Songs shown in the list: everything, or just the opened pack's songs.
  const shownSongs = useMemo(
    () =>
      group === 'pack' && openPack !== null
        ? filtered.filter((s) => (s.pack || '—') === openPack)
        : filtered,
    [filtered, openPack, group],
  );
  const packClamped = Math.min(packSel, Math.max(0, packList.length - 1));

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
  const packBannerUrl = inPacks && selPack ? (packArtUrls.get(selPack) ?? null) : null;
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
    savedFilters.group = group;
    savedFilters.openPack = openPack;
  });

  // Loop the highlighted song's sample snippet (#5); stop when leaving.
  // Catalog rows load their files/simfile on first highlight (also fills in
  // the banner and real chart list for the detail panel).
  useEffect(() => {
    if (!song?.entry) return;
    let alive = true;
    void ensureLoaded(song.entry).then((e) => {
      // Already-decoded audio (prefetched neighbors) starts near-instantly.
      if (alive) previewSong(e, previewCached(e) ? 120 : 450);
    });
    return () => {
      alive = false;
    };
  }, [song?.entry, ensureLoaded]);
  useEffect(() => () => stopPreview(), []);

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
  }, [selClamped, filtered, ensureLoaded]);

  // The selected song's pack art, a dim backdrop behind the detail header (#8).
  // Full scans stashed it already; catalog rows resolve it with one directory
  // listing of the pack folder, remembered (even as "none") per pack.
  const [packArt, setPackArt] = useState<string | null>(null);
  useEffect(() => {
    const pack = song?.pack || '';
    const entry = song?.entry;
    if (!pack || !entry) {
      setPackArt(null);
      return;
    }
    const known = packArtUrls.get(pack);
    if (known !== undefined) {
      setPackArt(known);
      return;
    }
    if (!entry.sourceId || !entry.lazyDir || !entry.lazyDir.includes('/')) {
      setPackArt(null);
      return;
    }
    let alive = true;
    setPackArt(null);
    const packDir = entry.lazyDir.slice(0, entry.lazyDir.lastIndexOf('/'));
    void readSongFolder(entry.sourceId, packDir).then((files) => {
      const pick = pickPackImage(files ?? []);
      const url = pick ? URL.createObjectURL(pick) : null;
      packArtUrls.set(pack, url);
      if (alive) setPackArt(url);
    });
    return () => {
      alive = false;
    };
  }, [song?.pack, song?.entry]);

  const start = useCallback(async () => {
    const s = shownSongs[Math.min(sel, Math.max(0, shownSongs.length - 1))];
    if (!s || s.levels[diff] == null) return;
    const entry = await ensureLoaded(s.entry); // no-op unless a catalog row
    const chart = bestChartsPerSlot(entry.song)[diff];
    if (!chart) return;
    const audio = await readSongAudio(entry);
    // Playable background, cached conversion of a legacy .avi/.mpg, or null
    // (which also queues a background conversion for next time).
    const bg = await resolveBackground(entry);
    onPlay({ song: entry.song, chart, encodedAudio: audio, backgroundFile: bg });
  }, [shownSongs, sel, diff, onPlay, ensureLoaded]);

  const reset = () => {
    setSort('pack');
    setSearch('');
    setMinLv(1);
    setMaxLv(20);
    setFavOnly(false);
    setGroup('all');
    setOpenPack(null);
    setPackSel(0);
  };
  const adjust = (i: number, dir: number) => {
    if (i === 0) setSort(SORTS[(SORTS.indexOf(sort) + dir + SORTS.length) % SORTS.length]);
    else if (i === 1) setMinLv((v) => Math.min(maxLv, Math.max(1, v + dir)));
    else if (i === 2) setMaxLv((v) => Math.max(minLv, Math.min(20, v + dir)));
    else if (i === 3) setFavOnly((v) => !v);
    else if (i === 4) {
      setGroup((v) => (v === 'pack' ? 'all' : 'pack'));
      setOpenPack(null);
      setPackSel(0);
      setSel(0);
    }
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
        else if (isConfirm) osel === overlayRows.length - 1 ? reset() : setOverlay(false);
      } else if (inPacks) {
        // Pack-wheel level: navigate packs, confirm opens one, back → options.
        if (typing) return;
        e.preventDefault();
        const n = Math.max(1, packList.length);
        if (e.key === 'ArrowUp') setPackSel((packClamped - 1 + n) % n);
        else if (e.key === 'ArrowDown') setPackSel((packClamped + 1) % n);
        else if (isConfirm) openPackAt(packClamped);
        else if (isBack) {
          setOverlay(true);
          setOsel(0);
        }
      } else {
        if (typing) return;
        e.preventDefault();
        const n = Math.max(1, shownSongs.length);
        if (e.key === 'ArrowUp') setSel((selClamped - 1 + n) % n);
        else if (e.key === 'ArrowDown') setSel((selClamped + 1) % n);
        else if (e.key === 'ArrowLeft') setDiff((v) => Math.max(0, v - 1));
        else if (e.key === 'ArrowRight') setDiff((v) => Math.min(4, v + 1));
        else if (isConfirm) void start();
        else if (e.key === 'f' || e.key === 'F') {
          const s = shownSongs[selClamped];
          if (s) toggleFav(s.key);
        } else if (isBack) {
          // Inside a pack → back returns to the pack list; else open options.
          if (inPack) closePack();
          else {
            setOverlay(true);
            setOsel(0);
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, osel, filtered, selClamped, start, sort, minLv, maxLv, favs]);

  const onDrop = async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDrag(false);
    // A single dropped folder becomes a remembered source like a picker choice
    // (Chromium); anything else loads one-off via entry traversal. Both
    // decisions happen synchronously during dispatch.
    const adopted = addSourceFromDrop(e.dataTransfer, scanTick);
    try {
      if (adopted) {
        const { id, folder } = await adopted;
        await addSourceEntries(folder.files, id || undefined);
        setSources(await listSources());
      } else {
        setLoading({ msg: 'LOADING SONGS…' });
        const files = await filesFromDataTransfer(e.dataTransfer);
        await addSourceEntries(files);
      }
    } finally {
      setLoading(null);
    }
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

  const overlayRows = [
    { label: 'SORT', value: sort.toUpperCase() },
    { label: 'MIN LV', value: String(minLv) },
    { label: 'MAX LV', value: String(maxLv) },
    { label: 'FAVES', value: favOnly ? '★ ONLY' : 'ALL' },
    { label: 'GROUP', value: group === 'pack' ? 'BY PACK' : 'ALL' },
    { label: 'RESET', value: '↺' },
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
            MUSIC SELECT
          </span>
        </div>
        <div className="flex items-center gap-4 text-[13px] tracking-[0.08em] text-[#ececec]/50">
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
                  onClick={() => void removeSrc(s)}
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
          void addSourceEntries(files);
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
                  background: `repeating-linear-gradient(135deg, #1d3a5e 0 20px, #205a6e 20px 40px)`,
                }}
              >
                {selPack ? initials(selPack) : ''}
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
              style={{
                background: `repeating-linear-gradient(135deg, #3a1d5e 0 20px, #57206e 20px 40px)`,
              }}
            >
              {song ? initials(song.title) : ''}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          {inPacks ? (
            <>
              <div className="text-[13px] tracking-[0.24em] text-[#ececec]/45">PACK</div>
              <div className="truncate text-[34px] font-bold leading-[1.15]">{selPack ?? '—'}</div>
              <div className="mt-2 flex gap-4 text-[14px] tracking-[0.06em] text-[#ececec]/45">
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
                  style={{ color: song && favs.has(song.key) ? FAV_CLR : 'rgba(236,236,236,.25)' }}
                >
                  {song && favs.has(song.key) ? '★' : '☆'}
                </button>
                <div className="truncate text-[34px] font-bold leading-[1.15]">
                  {song?.title ?? '—'}
                </div>
              </div>
              <div className="text-[17px] text-[#ececec]/60">{song?.artist ?? ''}</div>
              <div className="mt-2 flex items-center gap-4 text-[14px] tracking-[0.06em] text-[#ececec]/45">
                <span>BPM {song?.bpm ?? '—'}</span>
                {inPack ? (
                  <button
                    onClick={closePack}
                    className="font-bold hover:text-[#ececec]"
                    style={{ color: AC }}
                    title="Back to packs (Esc)"
                  >
                    ‹ {openPack}
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
        {overlayRows.map((o, i) => {
          const on = overlay && i === osel;
          return (
            <button
              key={o.label}
              onClick={() => {
                setOsel(i);
                i === overlayRows.length - 1 ? reset() : adjust(i, 1);
              }}
              className="flex items-center gap-2 border px-[10px] py-[6px] text-[12px] tracking-[0.08em] whitespace-nowrap"
              style={{
                color: on ? '#ececec' : 'rgba(236,236,236,.55)',
                borderColor: on ? AC : 'rgba(255,255,255,.12)',
                background: on ? AC + '14' : 'transparent',
              }}
            >
              <span className="opacity-60">{o.label}</span>
              <span className="font-bold">{o.value}</span>
            </button>
          );
        })}
        <span className="flex-1" />
        {overlay && (
          <span className="text-[11px] tracking-[0.14em]" style={{ color: AC }}>
            ◀▶ MOVE · ▲▼ ADJUST · SELECT DONE
          </span>
        )}
      </div>

      {/* Column headers */}
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

      {/* Virtualized song list */}
      <div
        ref={listRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        onWheel={(e) => {
          // Scroll wheel moves the selection (#6). Accumulate for trackpads.
          wheelAcc.current += e.deltaY;
          const step = 30;
          if (Math.abs(wheelAcc.current) < step) return;
          const dir = wheelAcc.current > 0 ? 1 : -1;
          wheelAcc.current = 0;
          if (inPacks) {
            const n = Math.max(1, packList.length);
            setPackSel((prev) => Math.max(0, Math.min(n - 1, Math.min(prev, n - 1) + dir)));
          } else {
            const n = Math.max(1, shownSongs.length);
            setSel((prev) => Math.max(0, Math.min(n - 1, Math.min(prev, n - 1) + dir)));
          }
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
              height: total * ROW_H,
              transform: `translateY(${off}px)`,
              transition: 'transform .16s ease-out',
            }}
          >
            {inPacks &&
              packList.slice(first, last).map((p, k) => {
                const rowIdx = first + k;
                const on = rowIdx === packClamped;
                return (
                  <div
                    key={p.pack}
                    onClick={() => setPackSel(rowIdx)}
                    onDoubleClick={() => openPackAt(rowIdx)}
                    className="absolute inset-x-0 grid cursor-pointer grid-cols-[1fr_70px_28px] items-center gap-[18px] border-b border-white/[0.04] px-[28px] whitespace-nowrap"
                    style={{
                      top: rowIdx * ROW_H,
                      height: ROW_H,
                      fontSize: 16,
                      fontWeight: on ? 700 : 400,
                      color: on ? '#ececec' : 'rgba(236,236,236,.7)',
                      background: on ? AC + '1a' : 'transparent',
                      borderLeft: on ? `2px solid ${AC}` : '2px solid transparent',
                    }}
                  >
                    <span className="overflow-hidden text-ellipsis tracking-[0.02em]">
                      {p.pack}
                    </span>
                    <span className="justify-self-end text-[13px] opacity-45">
                      {p.count} SONG{p.count === 1 ? '' : 'S'}
                    </span>
                    <span className="justify-self-end text-[18px] opacity-40">›</span>
                  </div>
                );
              })}
            {!inPacks &&
              shownSongs.slice(first, last).map((s, k) => {
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
                        style={{ color: favs.has(s.key) ? FAV_CLR : 'rgba(236,236,236,.28)' }}
                      >
                        {favs.has(s.key) ? '★' : '☆'}
                      </button>
                      <span className="overflow-hidden text-ellipsis">{s.title}</span>
                    </span>
                    <span className="overflow-hidden text-ellipsis opacity-55">{s.artist}</span>
                    <span className="overflow-hidden text-ellipsis text-[14px] opacity-40">
                      {s.pack || '—'}
                    </span>
                    <span className="justify-self-end opacity-60">{s.bpm}</span>
                    <span className="justify-self-end text-[13px] opacity-70">
                      {best ? `${(best.percent * 100).toFixed(1)} ${best.grade}` : ''}
                    </span>
                    <span className="justify-self-end text-[13px] opacity-45">
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

      {/* Hint bar */}
      <div className="flex h-[44px] flex-none items-center gap-6 border-t border-white/[0.09] px-[28px] text-[12px] tracking-[0.14em] text-[#ececec]/45">
        <span>▲▼ SONG</span>
        <span>◀▶ DIFFICULTY</span>
        <span style={{ color: AC, animation: 'blinkStart 1.4s infinite' }}>START — CONFIRM</span>
        <button onClick={() => setOverlay((v) => !v)}>SELECT — SORT / FILTER</button>
        <span>F — FAVORITE</span>
      </div>
    </div>
  );
}
