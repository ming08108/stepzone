/**
 * STEPLINE song select — a build of the design handoff, made fluid: a
 * full-viewport layout (fixed-height bars + a flexing list) that fills any
 * aspect ratio, Space Grotesk, a selected-song detail header with a
 * difficulty-chip stack, a filter strip, sortable columns, and a
 * keyboard-navigated centered list (virtualized for large libraries).
 */
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { starterEntries } from '../starter';
import {
  filesFromDataTransfer,
  findBackgroundFile,
  loadLibraryFromFiles,
  readSongAudio,
  songBpmRange,
  type LibraryEntry,
} from '../io/songFiles';
import {
  grantStoredFolder,
  pickSongFolder,
  restoreSongFolder,
  supportsFolderPicker,
} from '../io/localFolder';
import { difficultyToString } from '../song/difficulty';
import type { Song } from '../song/song';
import { previewSong, stopPreview } from '../audio/songPreview';
import type { PlayRequest } from './playRequest';
import { useGamepadKeys } from './useGamepadKeys';

const AC = '#ff5d47';
const DIFF_NAMES = ['BEGINNER', 'EASY', 'MEDIUM', 'HARD', 'EXPERT'];
const DIFF_CLR = ['#37d5ff', '#ffcf3d', '#ff5c5c', '#59f07f', '#c86bff'];
const SORTS = ['title', 'artist', 'pack', 'bpm', 'level'] as const;
type Sort = (typeof SORTS)[number];

const ROW_H = 44;

// The loaded library, kept across remounts like the filters below: returning
// from a song reuses it instead of re-reading the folder and re-deriving every
// row (parsed simfiles on the entries survive too). Session-scoped — a full
// page reload restores the library from the remembered folder on disk.
let libraryCache: LibraryEntry[] | null = null;

// Filter/selection state kept across remounts (e.g. after returning from a song)
// so the list doesn't reset. Session-scoped (resets on full reload).
const savedFilters = {
  sort: 'title' as Sort,
  search: '',
  minLv: 1,
  maxLv: 20,
  sel: 0,
  diff: 2,
};

interface SongVM {
  entry: LibraryEntry;
  title: string;
  artist: string;
  pack: string;
  bpm: string;
  bpmSort: number;
  levels: Array<number | null>;
}

function slotOf(name: string): number {
  const i = ['Beginner', 'Easy', 'Medium', 'Hard', 'Challenge'].indexOf(name);
  return i >= 0 ? i : 4; // Edit → Expert
}

function deriveLevels(song: Song): Array<number | null> {
  const lv: Array<number | null> = [null, null, null, null, null];
  const singles = song.charts.filter((c) => c.stepsType === 'dance-single');
  const use = singles.length ? singles : song.charts;
  for (const c of use) {
    const s = slotOf(difficultyToString(c.difficulty));
    if (lv[s] == null || c.meter > (lv[s] as number)) lv[s] = c.meter;
  }
  return lv;
}

function bpmText(entry: LibraryEntry): { text: string; sort: number } {
  const r = songBpmRange(entry.song);
  if (r.max <= 0) return { text: '—', sort: 0 };
  const lo = Math.round(r.min);
  const hi = Math.round(r.max);
  return { text: lo === hi ? String(hi) : `${lo}–${hi}`, sort: hi };
}

function initials(title: string): string {
  return title
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}

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
  const [busy, setBusy] = useState(false);
  // Name of a remembered song folder awaiting a click to re-grant access.
  const [restoreName, setRestoreName] = useState<string | null>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const [sel, setSel] = useState(savedFilters.sel);
  const [diff, setDiff] = useState(savedFilters.diff);
  const [sort, setSort] = useState<Sort>(savedFilters.sort);
  const [search, setSearch] = useState(savedFilters.search);
  const [minLv, setMinLv] = useState(savedFilters.minLv);
  const [maxLv, setMaxLv] = useState(savedFilters.maxLv);
  const [overlay, setOverlay] = useState(false);
  const [osel, setOsel] = useState(0);
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
  // song folder), leaving the screen must not lose it.
  useEffect(() => {
    if (entries.some((e) => e.files.length > 0)) libraryCache = entries;
  }, [entries]);

  // Parse a picked/restored/dropped folder into entries. A folder selection is
  // the library: it replaces previously loaded songs (so restore and re-pick
  // are idempotent) but leaves the built-in example alone.
  const addLocalFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    try {
      const { entries: loaded } = await loadLibraryFromFiles(files);
      if (loaded.length) {
        setEntries((prev) => [...prev.filter((e) => e.files.length === 0), ...loaded]);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  // Auto-load the remembered song folder, once per session (on a remount the
  // cache serves the list instantly). A remembered folder the browser won't
  // silently re-open surfaces as a click-to-restore banner instead.
  useEffect(() => {
    if (libraryCache) return;
    let cancelled = false;
    // The bundled starter pack — synthesized originals, so a fresh install has
    // real songs to play before any folder is picked. A loaded folder is
    // appended after these (addLocalFiles keeps file-less entries).
    setEntries(starterEntries());
    void (async () => {
      const local = await restoreSongFolder();
      if (cancelled || !local) return;
      if ('needsGesture' in local) setRestoreName(local.name);
      else await addLocalFiles(local.files);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "FOLDER" button: native directory picker where supported (Chromium — the
  // choice is remembered across reloads), <input webkitdirectory> elsewhere.
  const chooseFolder = async () => {
    if (supportsFolderPicker()) {
      const picked = await pickSongFolder();
      if (picked) await addLocalFiles(picked.files);
    } else {
      folderRef.current?.click();
    }
  };

  // Restore banner click: re-grant access to the remembered folder and load it.
  const finishRestore = async () => {
    setRestoreName(null);
    const granted = await grantStoredFolder();
    if (granted) await addLocalFiles(granted.files);
  };

  useEffect(() => {
    if (folderRef.current) folderRef.current.webkitdirectory = true;
  }, []);

  const songs = useMemo<SongVM[]>(
    () =>
      entries.map((e) => {
        const b = bpmText(e);
        return {
          entry: e,
          title: e.song.title || e.sourceName,
          artist: e.song.artist,
          pack: e.pack ?? '',
          bpm: b.text,
          bpmSort: b.sort,
          levels: deriveLevels(e.song),
        };
      }),
    [entries],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = songs.filter(
      (s) =>
        (!q ||
          s.title.toLowerCase().includes(q) ||
          s.artist.toLowerCase().includes(q) ||
          s.pack.toLowerCase().includes(q)) &&
        s.levels.some((lv) => lv != null && lv >= minLv && lv <= maxLv),
    );
    const key: (s: SongVM) => string | number =
      sort === 'artist'
        ? (s) => s.artist.toLowerCase()
        : sort === 'pack'
          ? // Group by pack (pack-less entries last), titles A–Z inside a pack.
            // (\uffff sorts packless after every pack; \u0000 separates the keys)
            (s) => `${s.pack ? s.pack.toLowerCase() : '\uffff'}\u0000${s.title.toLowerCase()}`
          : sort === 'bpm'
            ? (s) => s.bpmSort
            : sort === 'level'
              ? (s) => s.levels[diff] ?? 99
              : (s) => s.title.toLowerCase();
    return rows.slice().sort((x, y) => {
      const a = key(x);
      const b = key(y);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }, [songs, search, minLv, maxLv, sort, diff]);

  const selClamped = Math.min(sel, Math.max(0, filtered.length - 1));
  const song = filtered[selClamped];

  // Remember filters/selection so returning from a song restores the list (#2).
  useEffect(() => {
    savedFilters.sort = sort;
    savedFilters.search = search;
    savedFilters.minLv = minLv;
    savedFilters.maxLv = maxLv;
    savedFilters.sel = selClamped;
    savedFilters.diff = diff;
  });

  // Loop the highlighted song's sample snippet (#5); stop when leaving.
  useEffect(() => {
    if (song?.entry) previewSong(song.entry);
  }, [song?.entry]);
  useEffect(() => () => stopPreview(), []);

  const start = useCallback(async () => {
    const s = filtered[Math.min(sel, Math.max(0, filtered.length - 1))];
    if (!s || s.levels[diff] == null) return;
    const entry = s.entry;
    const singles = entry.song.charts.filter((c) => c.stepsType === 'dance-single');
    const use = singles.length ? singles : entry.song.charts;
    const chart =
      use.find(
        (c) => slotOf(difficultyToString(c.difficulty)) === diff && c.meter === s.levels[diff],
      ) ?? use.find((c) => slotOf(difficultyToString(c.difficulty)) === diff);
    if (!chart) return;
    const audio = await readSongAudio(entry);
    const bg = findBackgroundFile(entry);
    onPlay({ song: entry.song, chart, encodedAudio: audio, backgroundFile: bg });
  }, [filtered, sel, diff, onPlay]);

  const reset = () => {
    setSort('title');
    setSearch('');
    setMinLv(1);
    setMaxLv(20);
  };
  const adjust = (i: number, dir: number) => {
    if (i === 0) setSort(SORTS[(SORTS.indexOf(sort) + dir + SORTS.length) % SORTS.length]);
    else if (i === 1) setMinLv((v) => Math.min(maxLv, Math.max(1, v + dir)));
    else if (i === 2) setMaxLv((v) => Math.max(minLv, Math.min(20, v + dir)));
  };

  // Keyboard navigation (arcade model).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Shift'];
      if (!keys.includes(e.key)) return;
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      if (overlay) {
        if (e.key === 'Escape' || e.key === 'Shift') {
          e.preventDefault();
          setOverlay(false);
          return;
        }
        if (typing && e.key !== 'Enter') return;
        e.preventDefault();
        if (e.key === 'ArrowLeft') setOsel((v) => Math.max(0, v - 1));
        else if (e.key === 'ArrowRight') setOsel((v) => Math.min(3, v + 1));
        else if (e.key === 'ArrowUp') adjust(osel, 1);
        else if (e.key === 'ArrowDown') adjust(osel, -1);
        else if (e.key === 'Enter') osel === 3 ? reset() : setOverlay(false);
      } else {
        if (typing) return;
        e.preventDefault();
        const n = Math.max(1, filtered.length);
        if (e.key === 'ArrowUp') setSel((selClamped - 1 + n) % n);
        else if (e.key === 'ArrowDown') setSel((selClamped + 1) % n);
        else if (e.key === 'ArrowLeft') setDiff((v) => Math.max(0, v - 1));
        else if (e.key === 'ArrowRight') setDiff((v) => Math.min(4, v + 1));
        else if (e.key === 'Enter') void start();
        else if (e.key === 'Escape' || e.key === 'Shift') {
          setOverlay(true);
          setOsel(0);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, osel, filtered.length, selClamped, start, sort, minLv, maxLv]);

  const onDrop = async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDrag(false);
    setBusy(true);
    try {
      const { entries: loaded } = await loadLibraryFromFiles(
        await filesFromDataTransfer(e.dataTransfer),
      );
      if (loaded.length) setEntries((prev) => [...prev, ...loaded]);
    } finally {
      setBusy(false);
    }
  };

  // Virtualized window: center the selection, clamp at the ends.
  const total = filtered.length;
  const off = Math.max(
    Math.min(viewH - total * ROW_H, 0),
    Math.min(0, viewH / 2 - (selClamped + 0.5) * ROW_H),
  );
  const first = Math.max(0, Math.floor(-off / ROW_H) - 4);
  const last = Math.min(total, Math.ceil((-off + viewH) / ROW_H) + 4);
  const topFade = off < 0;
  const botFade = off + total * ROW_H > viewH;

  const chips = DIFF_NAMES.map((name, i) => {
    const lv = song?.levels[i];
    const on = i === diff;
    const has = lv != null;
    return { name, lv: has ? lv : '—', clr: DIFF_CLR[i], on, has };
  });

  const overlayRows = [
    { label: 'SORT', value: sort.toUpperCase() },
    { label: 'MIN LV', value: String(minLv) },
    { label: 'MAX LV', value: String(maxLv) },
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
          <span>{filtered.length} SONGS</span>
          <button
            onClick={() => void chooseFolder()}
            className="border border-white/[0.14] px-[10px] py-[4px] hover:border-[#ff5d47] hover:text-[#ececec]"
            title="Load a song folder from this computer"
          >
            + FOLDER
          </button>
          <button onClick={onOptions} className="hover:text-[#ececec]" title="Options">
            ⚙
          </button>
        </div>
      </div>

      {/* Remembered-folder restore (browsers require a click to re-grant access) */}
      {restoreName && (
        <button
          onClick={() => void finishRestore()}
          className="flex h-[40px] flex-none items-center justify-center gap-2 border-b border-white/[0.09] text-[12px] tracking-[0.14em]"
          style={{ color: AC, background: AC + '14' }}
        >
          RELOAD SONG LIBRARY “{restoreName.toUpperCase()}” — CLICK TO ALLOW FOLDER ACCESS
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
          void addLocalFiles(files);
        }}
      />

      {/* Detail panel */}
      <div className="flex h-[176px] flex-none items-center gap-6 border-b border-white/[0.09] px-[28px]">
        <div className="relative h-[144px] w-[256px] flex-none overflow-hidden outline outline-1 outline-white/[0.14]">
          {song?.entry.bannerUrl ? (
            <img
              src={song.entry.bannerUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
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
          <div className="truncate text-[34px] font-bold leading-[1.15]">{song?.title ?? '—'}</div>
          <div className="text-[17px] text-[#ececec]/60">{song?.artist ?? ''}</div>
          <div className="mt-2 flex gap-4 text-[14px] tracking-[0.06em] text-[#ececec]/45">
            <span>BPM {song?.bpm ?? '—'}</span>
            <span>{song?.pack ?? ''}</span>
            <span className="font-bold" style={{ color: AC }}>
              {DIFF_NAMES[diff]} {song?.levels[diff] ?? '—'}
            </span>
          </div>
        </div>
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
                i === 3 ? reset() : adjust(i, 1);
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
        {busy && <span className="text-[12px] text-[#ececec]/50">Loading…</span>}
      </div>

      {/* Column headers */}
      <div className="grid h-[28px] flex-none grid-cols-[1.25fr_1fr_0.75fr_90px_76px] items-center gap-[18px] border-b border-white/[0.06] px-[28px]">
        {(
          [
            ['TITLE', 'title', false],
            ['ARTIST', 'artist', false],
            ['PACK', 'pack', false],
            ['BPM', 'bpm', true],
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
          const n = Math.max(1, filtered.length);
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
              height: total * ROW_H,
              transform: `translateY(${off}px)`,
              transition: 'transform .16s ease-out',
            }}
          >
            {filtered.slice(first, last).map((s, k) => {
              const i = first + k;
              const on = i === selClamped;
              const lv = s.levels[diff];
              return (
                <div
                  key={i}
                  onClick={() => setSel(i)}
                  onDoubleClick={() => {
                    setSel(i);
                    void start();
                  }}
                  className="absolute inset-x-0 grid cursor-pointer grid-cols-[1.25fr_1fr_0.75fr_90px_76px] items-center gap-[18px] border-b border-white/[0.04] px-[28px] whitespace-nowrap"
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
                  <span className="overflow-hidden text-ellipsis">{s.title}</span>
                  <span className="overflow-hidden text-ellipsis opacity-55">{s.artist}</span>
                  <span className="overflow-hidden text-ellipsis text-[14px] opacity-40">
                    {s.pack || '—'}
                  </span>
                  <span className="justify-self-end opacity-60">{s.bpm}</span>
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
      </div>

      {/* Hint bar */}
      <div className="flex h-[44px] flex-none items-center gap-6 border-t border-white/[0.09] px-[28px] text-[12px] tracking-[0.14em] text-[#ececec]/45">
        <span>▲▼ SONG</span>
        <span>◀▶ DIFFICULTY</span>
        <span style={{ color: AC, animation: 'blinkStart 1.4s infinite' }}>START — CONFIRM</span>
        <button onClick={() => setOverlay((v) => !v)}>SELECT — SORT / FILTER</button>
      </div>
    </div>
  );
}
