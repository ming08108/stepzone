import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import exampleSsc from '../dev/example.ssc?raw';
import { parseSimfile } from '../parse/loader';
import {
  filesFromDataTransfer,
  findBackgroundFile,
  loadLibraryFromFiles,
  readSongAudio,
  songBpmRange,
  type LibraryEntry,
} from '../io/songFiles';
import {
  ensureRemoteLoaded,
  fetchRemoteBackground,
  loadRemoteLibrary,
  readRemoteAudio,
} from '../io/remoteLibrary';
import { loadFavorites, saveFavorites, songKey } from '../app/favorites';
import { chartKey, loadScores, totalStats } from '../app/scores';
import { difficultyToString } from '../song/difficulty';
import type { PlayRequest } from './playRequest';
import { useMenuNav } from './useMenuNav';

const CHART_BTN =
  'rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-left hover:border-accent hover:bg-accent/10';

function exampleEntry(): LibraryEntry {
  return {
    song: parseSimfile(exampleSsc, 'example.ssc'),
    files: [],
    sourceName: 'example.ssc',
    bannerUrl: null,
  };
}

type SortKey = 'title' | 'bpm';

export function SongSelect({
  onPlay,
  onInspect,
  onOptions,
}: {
  onPlay: (r: PlayRequest) => void;
  onInspect: () => void;
  onOptions: () => void;
}) {
  const [entries, setEntries] = useState<LibraryEntry[]>(() => [exampleEntry()]);
  const [favs, setFavs] = useState<Set<string>>(() => loadFavorites());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [scores] = useState(() => loadScores());
  const [stats] = useState(() => totalStats());
  const [catalogUrl, setCatalogUrl] = useState(
    () => localStorage.getItem('notefield.catalogUrl') ?? '',
  );
  const folderRef = useRef<HTMLInputElement>(null);
  useMenuNav();

  // Filters.
  const [search, setSearch] = useState('');
  const [stepsType, setStepsType] = useState('all');
  const [minMeter, setMinMeter] = useState(1);
  const [maxMeter, setMaxMeter] = useState(20);
  const [favOnly, setFavOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>('title');

  useEffect(() => {
    if (folderRef.current) folderRef.current.webkitdirectory = true;
  }, []);

  // Revoke object-URL banners when the library is replaced / unmounts.
  // (Remote banners are plain URLs — nothing to revoke.)
  useEffect(() => {
    return () => {
      for (const e of entries)
        if (e.bannerUrl?.startsWith('blob:')) URL.revokeObjectURL(e.bannerUrl);
    };
  }, [entries]);

  // Open a song row, lazily loading a remote song's charts on first open.
  const openSong = async (entry: LibraryEntry, key: string) => {
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (entry.remoteDir && entry.song.charts.length === 0) {
      setLoadingKey(key);
      try {
        const full = await ensureRemoteLoaded(entry);
        setEntries((prev) => prev.map((e) => (e === entry ? { ...e, song: full } : e)));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingKey(null);
      }
    }
  };

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const { entries: loaded, warnings } = await loadLibraryFromFiles(files);
      setEntries([exampleEntry(), ...loaded]);
      if (loaded.length === 0) setError(warnings[0] ?? 'No songs found.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDrop = async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDrag(false);
    await handleFiles(await filesFromDataTransfer(e.dataTransfer));
  };

  const loadServer = async (url = catalogUrl) => {
    const u = url.trim();
    if (!u) return;
    setError(null);
    setBusy(true);
    try {
      const { entries: remote, warnings } = await loadRemoteLibrary(u);
      localStorage.setItem('notefield.catalogUrl', u);
      setEntries((prev) => [...prev.filter((e) => !e.remoteDir), ...remote]);
      if (remote.length === 0) setError(warnings[0] ?? 'No songs found in catalog.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Auto-load the last server catalog (files come from the local cache if seen).
  useEffect(() => {
    const saved = localStorage.getItem('notefield.catalogUrl');
    if (saved) void loadServer(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFav = (key: string) => {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveFavorites(next);
      return next;
    });
  };

  const play = async (entry: LibraryEntry, chartIndex: number) => {
    let e = entry;
    if (entry.remoteDir && entry.song.charts.length === 0) {
      e = { ...entry, song: await ensureRemoteLoaded(entry) };
    }
    const chart = e.song.charts[chartIndex];
    if (!chart) return;
    const audio = e.remoteDir ? await readRemoteAudio(e) : await readSongAudio(e);
    const backgroundFile = e.remoteDir ? await fetchRemoteBackground(e) : findBackgroundFile(e);
    onPlay({ song: e.song, chart, encodedAudio: audio, backgroundFile });
  };

  const stepsTypes = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) for (const c of e.song.charts) set.add(c.stepsType);
    return ['all', ...[...set].sort()];
  }, [entries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = entries.filter((e) => {
      const key = songKey(e.song.title, e.song.artist);
      if (favOnly && !favs.has(key)) return false;
      if (q && !`${e.song.title} ${e.song.artist}`.toLowerCase().includes(q)) return false;
      const charts = e.song.charts.filter(
        (c) =>
          (stepsType === 'all' || c.stepsType === stepsType) &&
          c.meter >= minMeter &&
          c.meter <= maxMeter,
      );
      return charts.length > 0 || (e.files.length === 0 && !favOnly && !q); // keep example visible
    });
    rows.sort((a, b) => {
      if (sort === 'bpm') return songBpmRange(a.song).min - songBpmRange(b.song).min;
      return (a.song.title || '').localeCompare(b.song.title || '');
    });
    return rows;
  }, [entries, search, stepsType, minMeter, maxMeter, favOnly, favs, sort]);

  return (
    <div className="mx-auto max-w-[1000px] px-6 pb-16 pt-8">
      <header className="mb-5 flex items-center justify-between">
        <div className="text-2xl font-extrabold">
          <span className="brand">notefield</span> <span className="pill">song select</span>
          {stats.plays > 0 && (
            <span className="ml-2 text-xs font-normal text-muted">{stats.plays} plays</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onOptions}
            className="rounded-lg border border-line px-4 py-2 text-muted hover:border-accent hover:text-ink"
          >
            ⚙ Options
          </button>
          <button
            onClick={onInspect}
            className="rounded-lg border border-line px-4 py-2 text-muted hover:border-accent hover:text-ink"
          >
            Inspect
          </button>
        </div>
      </header>

      {/* Loader */}
      <section
        className={`card mb-4 border-2 border-dashed transition-colors ${
          drag ? 'border-accent bg-accent/5' : 'border-line'
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="cursor-pointer rounded-xl bg-accent px-6 py-2 text-base font-bold text-night hover:brightness-110"
            onClick={() => folderRef.current?.click()}
          >
            Choose folder…
          </button>
          <span className="text-sm text-muted">
            or drop a song folder / pack here ({entries.length - 1} loaded)
          </span>
          {busy && <span className="text-muted">Loading…</span>}
          {error && <span className="text-[#ff6b6b]">{error}</span>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="url"
            placeholder="https://…/catalog.json  (load a song server)"
            value={catalogUrl}
            onChange={(e) => setCatalogUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void loadServer();
            }}
            className="min-w-[240px] flex-1 rounded-lg border border-line bg-white/[0.03] px-3 py-1.5 text-sm"
          />
          <button
            onClick={() => void loadServer()}
            className="rounded-lg border border-line px-4 py-1.5 text-sm text-muted hover:border-accent hover:text-ink"
          >
            Load from server
          </button>
        </div>
        <input
          ref={folderRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(Array.from(e.target.files ?? []))}
        />
      </section>

      {/* Filters */}
      <section className="card mb-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <input
            type="search"
            placeholder="Search title / artist…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-[200px] flex-1 rounded-lg border border-line bg-white/[0.03] px-3 py-1.5"
          />
          <select
            value={stepsType}
            onChange={(e) => setStepsType(e.target.value)}
            className="rounded-lg border border-line bg-white/[0.03] px-2 py-1.5"
          >
            {stepsTypes.map((t) => (
              <option key={t} value={t}>
                {t === 'all' ? 'All types' : t}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-muted">
            meter
            <input
              type="number"
              min={1}
              max={20}
              value={minMeter}
              onChange={(e) => setMinMeter(Number(e.target.value) || 1)}
              className="w-14 rounded border border-line bg-white/[0.03] px-2 py-1"
            />
            –
            <input
              type="number"
              min={1}
              max={20}
              value={maxMeter}
              onChange={(e) => setMaxMeter(Number(e.target.value) || 20)}
              className="w-14 rounded border border-line bg-white/[0.03] px-2 py-1"
            />
          </label>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-lg border border-line bg-white/[0.03] px-2 py-1.5"
          >
            <option value="title">Sort: Title</option>
            <option value="bpm">Sort: BPM</option>
          </select>
          <label className="flex items-center gap-1 text-muted">
            <input
              type="checkbox"
              checked={favOnly}
              onChange={(e) => setFavOnly(e.target.checked)}
            />
            ★ only
          </label>
        </div>
      </section>

      {/* Table */}
      <section className="card p-0">
        {filtered.length === 0 && <div className="p-6 text-center text-muted">No songs match.</div>}
        {filtered.map((entry) => {
          const key = songKey(entry.song.title, entry.song.artist);
          const bpm = songBpmRange(entry.song);
          const isFav = favs.has(key);
          const isOpen = expanded === key;
          const meters = [...new Set(entry.song.charts.map((c) => c.meter))].sort((a, b) => a - b);
          return (
            <div
              key={key}
              className="border-b border-line transition-colors last:border-0 hover:bg-white/[0.02]"
            >
              <div className="flex items-center gap-3 px-4 py-2.5">
                <button
                  onClick={() => toggleFav(key)}
                  title="favorite"
                  className={`text-lg ${isFav ? 'text-[#ffd24d]' : 'text-muted hover:text-ink'}`}
                >
                  {isFav ? '★' : '☆'}
                </button>
                <button
                  onClick={() => void openSong(entry, key)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  {entry.bannerUrl && (
                    <img
                      src={entry.bannerUrl}
                      alt=""
                      loading="lazy"
                      className="h-8 w-20 rounded object-cover"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      {entry.song.title || entry.sourceName}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {entry.song.artist || '—'}
                    </span>
                  </span>
                  <span className="w-24 text-right text-sm tabular-nums text-muted">
                    {bpm.max > 0
                      ? bpm.min === bpm.max
                        ? `${Math.round(bpm.min)}`
                        : `${Math.round(bpm.min)}–${Math.round(bpm.max)}`
                      : '—'}{' '}
                    BPM
                  </span>
                  <span className="hidden w-40 text-right text-xs text-muted sm:block">
                    {meters.join(' · ')}
                  </span>
                </button>
              </div>
              {isOpen && entry.song.charts.length === 0 && (
                <div className="px-4 pb-3 text-sm text-muted">
                  {loadingKey === key ? 'Loading charts…' : 'No charts.'}
                </div>
              )}
              {isOpen && entry.song.charts.length > 0 && (
                <div className="grid grid-cols-2 gap-2 px-4 pb-3 sm:grid-cols-3 md:grid-cols-4">
                  {entry.song.charts
                    .map((c, i) => ({ c, i }))
                    .sort((a, b) => a.c.difficulty - b.c.difficulty || a.c.meter - b.c.meter)
                    .map(({ c, i }) => {
                      const best = scores[chartKey(entry.song, c)];
                      return (
                        <button key={i} className={CHART_BTN} onClick={() => void play(entry, i)}>
                          <div className="text-xs text-muted">{c.stepsType}</div>
                          <div className="font-semibold">
                            {difficultyToString(c.difficulty)}{' '}
                            <span className="text-accent">{c.meter}</span>
                          </div>
                          {best && (
                            <div className="text-xs text-[#ffd94b]">
                              {best.grade} · {(best.percent * 100).toFixed(1)}%
                            </div>
                          )}
                        </button>
                      );
                    })}
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
