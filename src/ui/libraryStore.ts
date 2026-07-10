/**
 * Session-scoped store for the song library: the loaded entries, the
 * remembered folder sources, scan/load progress, and every object URL the
 * library mints (entry banner blobs, pack-art blobs).
 *
 * One module owns all of that state, for two structural reasons:
 *
 * - URL lifecycle has a single choke point. Banner and pack-art object URLs
 *   must be revoked exactly when the content owning them leaves the library.
 *   Every entries change flows through commitEntries(), which diffs against
 *   the previous array and reclaims URLs synchronously — content cannot be
 *   dropped in one place while its URLs are forgotten in another.
 *
 * - The store outlives the screen. Scans, rescans, and lazy loads are long,
 *   and the song-select screen unmounts freely (Enter starts a song mid-scan).
 *   Results land here, not in component state, so nothing is silently dropped
 *   with a React instance and no operation needs to know whether a screen is
 *   mounted; the screen just re-subscribes on its next mount.
 *
 * The view (SongSelect) reads libraryState() via useSyncExternalStore and
 * calls the exported operations; it holds no library state of its own.
 */
import { starterEntries } from '../starter';
import {
  filesFromDataTransfer,
  loadLibraryFromFiles,
  pickPackImage,
  type LibraryEntry,
} from '../io/songFiles';
import {
  addSourceFromDrop,
  addSourceFromPicker,
  ensureSourcePermission,
  grantPendingSources,
  listSources,
  loadCatalog,
  readSongFolder,
  readSource,
  removeSource as removeStoredSource,
  restoreSources,
  saveCatalog,
  setSourceEnabled,
  sourceState,
  supportsFolderPicker,
  type SongSource,
} from '../io/localFolder';
import { bpmText, deriveLevels, entryDir, entryFromCatalog } from './songSelectModel';

export interface LoadStatus {
  msg: string;
  frac?: number;
}

export interface LibraryState {
  entries: LibraryEntry[];
  /** The remembered folder sources, for the FOLDERS panel + restore banner. */
  sources: SongSource[];
  /** Scan/parse progress shown as an overlay, null when idle. */
  loading: LoadStatus | null;
  /** Bumped whenever pack art changes; read the art itself via packArtUrl(). */
  packArtVersion: number;
}

let state: LibraryState = { entries: [], sources: [], loading: null, packArtVersion: 0 };
const listeners = new Set<() => void>();

/** Current snapshot — a stable reference until the next change. */
export function libraryState(): LibraryState {
  return state;
}

export function subscribeLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setState(patch: Partial<LibraryState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

// --- Entries (and the object URLs they own) ------------------------------------

// Pack names referenced by the current entries — rebuilt on every commit so
// async pack-art walks that outlive their pack (source removed mid-walk) can
// tell that minting a URL now would leak it: the commit sweep only reclaims
// packs that are in the cache at the time entries change.
let livePackNames = new Set<string>();

/**
 * The single write path for entries. Frees object URLs owned by content that
 * leaves the library: each catalog row's lazy parse mints a banner blob URL
 * and every pack folder walk mints one for its art; without the sweep they
 * accrue for the page's life as you browse and rescan. Diffing by identity is
 * safe — a dropped entry/pack stops being rendered by the same notification,
 * and an already-decoded <img> keeps its bitmap post-revoke.
 */
function commitEntries(entries: LibraryEntry[]): void {
  const prev = state.entries;
  if (entries === prev) return;
  const live = new Set(entries);
  for (const e of prev) {
    if (!live.has(e) && e.bannerUrl) URL.revokeObjectURL(e.bannerUrl);
  }
  // Pack art whose pack is gone entirely (a source was removed or disabled).
  const packs = new Set<string>();
  for (const e of entries) if (e.pack) packs.add(e.pack);
  livePackNames = packs;
  for (const [pack, url] of packArtUrls) {
    if (packs.has(pack)) continue;
    if (url) URL.revokeObjectURL(url);
    packArtUrls.delete(pack);
  }
  setState({ entries });
}

// --- Pack art -------------------------------------------------------------------

// Pack background art: pack name -> object URL, null = known none. Session-
// scoped like the entries so revisits don't re-read pack folders.
const packArtUrls = new Map<string, string | null>();

// Packs whose folder is being walked right now — so the detail-header backdrop
// and the grid loader (or a fast A→B→A cursor) never walk the same pack twice
// or leak the loser's object URL.
const packArtPending = new Set<string>();

/** A pack's cached art URL: string, null = known none, undefined = unresolved. */
export function packArtUrl(pack: string): string | null | undefined {
  return packArtUrls.get(pack);
}

function bumpPackArt(): void {
  setState({ packArtVersion: state.packArtVersion + 1 });
}

/**
 * Stash freshly-walked pack art (full scans carry the pack-root files). A full
 * scan is fresh ground truth for the packs it found images for, so it replaces
 * (and revokes) any cached URL — this is what makes a rescan pick up a changed
 * banner file, with no ad-hoc invalidation in the rescan path. Revoking a
 * still-rendered URL is safe: an already-decoded <img> keeps its bitmap, and
 * consumers re-read on the notification. A pack whose image was deleted on
 * disk keeps its stale art (absent from packImages, so untouched) — better
 * than revoking art that may belong to a same-named pack in another source.
 */
function stashPackImages(packImages: Map<string, File>): void {
  for (const [pack, file] of packImages) {
    const old = packArtUrls.get(pack);
    if (old) URL.revokeObjectURL(old);
    packArtUrls.set(pack, URL.createObjectURL(file));
  }
  if (packImages.size > 0) bumpPackArt();
}

/**
 * Resolve one pack's banner exactly once: list its folder, cache the object
 * URL (or null for "known none"), then notify. A no-op if already cached or a
 * walk is in flight — the in-flight walk's completion notifies every consumer.
 */
export async function requestPackArt(pack: string, sourceId: string, dir: string): Promise<void> {
  if (packArtUrls.get(pack) !== undefined || packArtPending.has(pack)) return;
  packArtPending.add(pack);
  let files: File[] | null;
  try {
    files = await readSongFolder(sourceId, dir);
  } finally {
    packArtPending.delete(pack);
  }
  // A failed read (source removed or folder gone mid-walk) is not "known
  // none": leave the slot empty so a later walk — say via a same-named pack's
  // entry from a surviving source — can still resolve real art.
  if (files === null) return;
  // The library may have moved on during the walk: the pack may be gone
  // entirely (minting now would leak past the commit sweep, which already
  // ran), or a full scan may have stashed fresh art meanwhile (fresher than
  // this walk's read — leave it).
  if (!livePackNames.has(pack) || packArtUrls.get(pack) !== undefined) return;
  const pick = pickPackImage(files);
  packArtUrls.set(pack, pick ? URL.createObjectURL(pick) : null);
  bumpPackArt();
}

// --- Lazy entry loading ----------------------------------------------------------

// In-flight lazy loads keyed by the (identity-stable) catalog entry, so
// concurrent callers — the preview effect plus Enter, or a fast A→B→A
// highlight — share one parse instead of each minting a banner URL: the
// loser's merged entry would never join `entries`, putting its URL beyond the
// commit sweep's reach forever. Entries delete themselves on settle.
const entryLoads = new Map<LibraryEntry, Promise<LibraryEntry>>();

/**
 * A catalog row being opened: read its song folder (one directory listing)
 * and parse the simfile, writing the result back onto the entry in place.
 * Concurrent callers share one load (see entryLoads above).
 */
export async function ensureLoaded(entry: LibraryEntry): Promise<LibraryEntry> {
  const { sourceId, lazyDir } = entry;
  if (!lazyDir || !sourceId || entry.song.charts.length > 0) return entry;
  const inflight = entryLoads.get(entry);
  if (inflight) return inflight;
  const load = (async () => {
    const files = await readSongFolder(sourceId, lazyDir);
    if (!files || files.length === 0) return entry;
    const { entries: parsed } = await loadLibraryFromFiles(files);
    const full = parsed[0];
    if (!full) return entry;
    // The entry may have left the library mid-parse (source removed or
    // disabled): merging then would orphan the fresh banner URL — no future
    // commit could diff it out. The check-and-commit below is atomic (no
    // await between them), so the merged entry either joins `entries` or has
    // its URL reclaimed here.
    if (!state.entries.includes(entry)) {
      if (full.bannerUrl) URL.revokeObjectURL(full.bannerUrl);
      return entry;
    }
    const merged: LibraryEntry = {
      ...entry,
      song: full.song,
      files: full.files,
      bannerUrl: full.bannerUrl,
    };
    commitEntries(state.entries.map((e) => (e === entry ? merged : e)));
    return merged;
  })();
  entryLoads.set(entry, load);
  try {
    return await load;
  } finally {
    entryLoads.delete(entry);
  }
}

// --- Loading songs into the library ----------------------------------------------

const scanTick = (n: number): void => setState({ loading: { msg: `SCANNING FOLDER… ${n} FILES` } });

/**
 * Parse a folder's files into entries. Entries from a remembered source are
 * tagged with its id, replace that source's previous songs (so rescans are
 * idempotent), and are summarized into a cached catalog so the next reload
 * skips the walk+parse entirely; untagged loads (multi-folder drops, the
 * fallback input) simply append for this session. The starter pack stays.
 */
export async function addFiles(files: File[], sourceId?: string, persisted = false): Promise<void> {
  if (files.length === 0) return;
  setState({ loading: { msg: 'LOADING SONGS…' } });
  try {
    const { entries: loaded, packImages } = await loadLibraryFromFiles(files, (done, total) =>
      setState({ loading: { msg: `LOADING SONGS… ${done} / ${total}`, frac: done / total } }),
    );
    stashPackImages(packImages);
    const tagged = sourceId ? loaded.map((e) => ({ ...e, sourceId })) : loaded;
    // The walk+parse is long; re-check that the world still wants the result.
    // A persisted source removed mid-scan forfeits everything (no resurrected
    // songs, no orphan catalog); one merely disabled keeps its fresh catalog
    // for re-enable but must not re-enter the library. Discarded entries'
    // banner URLs are revoked here — they never join `entries` where the
    // commit sweep could reclaim them.
    //
    // Only `persisted` callers get the re-check: a fresh add's id may be
    // session-only (IDB unavailable or write failed — the io layer still
    // loads it this session) and so absent from the list without being
    // removed; it also isn't in the FOLDERS panel yet, so it can't be removed
    // mid-scan anyway. sourceState's 'unknown' (the list read failed) fails
    // open — keep the result rather than misread a transient error as a
    // removal.
    const srcState = sourceId && persisted ? await sourceState(sourceId) : 'enabled';
    const removed = srcState === 'removed';
    if (!removed && srcState !== 'disabled') {
      if (tagged.length) {
        commitEntries([
          ...state.entries.filter((e) => !sourceId || e.sourceId !== sourceId),
          ...tagged,
        ]);
      }
    } else {
      for (const e of tagged) if (e.bannerUrl) URL.revokeObjectURL(e.bannerUrl);
    }
    if (sourceId && !removed) {
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
    setState({ loading: null });
  }
}

/**
 * Bring one source into the library: from its cached catalog when available
 * (instant — no disk walk), else a full scan that also writes the catalog.
 */
export async function loadSource(id: string, forceScan = false): Promise<void> {
  if (!forceScan) {
    const cached = await loadCatalog(id);
    if (cached && cached.length > 0) {
      commitEntries([
        ...state.entries.filter((e) => e.sourceId !== id),
        ...cached.map((c) => entryFromCatalog(id, c)),
      ]);
      return;
    }
  }
  const folder = await readSource(id, scanTick);
  // `persisted`: readSource only succeeds for a source in the stored list,
  // so addFiles' removed/disabled re-check is meaningful here.
  if (folder) await addFiles(folder.files, id, true);
  setState({ loading: null });
}

// --- Session start ----------------------------------------------------------------

let initialized = false;

/**
 * Seed the starter pack and auto-load the remembered folders, once per
 * session. Sources the browser wants a fresh gesture for are left for
 * finishRestore (driven by the reload banner). Idempotent — later mounts of
 * the screen are served by the store's current state.
 */
export function initLibrary(): void {
  if (initialized) return;
  initialized = true;
  // The bundled starter pack — synthesized originals, so a fresh install has
  // real songs to play before any folder is picked. Loaded folders are
  // appended after these (addFiles keeps file-less entries).
  commitEntries(starterEntries());
  void (async () => {
    const { granted } = await restoreSources();
    for (const g of granted) await loadSource(g.id);
    setState({ sources: await listSources(), loading: null });
  })();
}

// --- Source management --------------------------------------------------------------

export async function refreshSources(): Promise<void> {
  setState({ sources: await listSources() });
}

/**
 * Re-grant access to the pending sources and load them (cached catalogs make
 * this near-instant). Sources still denied (dismissed prompt, no activation)
 * stay pending for another try; dead folders are dropped by the io layer.
 */
export async function finishRestore(): Promise<void> {
  const wasPending = new Set(
    state.sources.filter((s) => s.enabled && s.permission === 'prompt').map((s) => s.id),
  );
  await grantPendingSources();
  const after = await listSources();
  for (const s of after) {
    if (s.enabled && s.permission === 'granted' && wasPending.has(s.id)) {
      await loadSource(s.id);
    }
  }
  setState({ sources: after, loading: null });
}

/** Toggle a source's songs in/out of the library (enabling may prompt). */
export async function toggleSource(s: SongSource): Promise<void> {
  if (s.enabled) {
    await setSourceEnabled(s.id, false);
    commitEntries(state.entries.filter((e) => e.sourceId !== s.id));
  } else {
    await setSourceEnabled(s.id, true);
    if (await ensureSourcePermission(s.id)) await loadSource(s.id);
    setState({ loading: null });
  }
  await refreshSources();
}

/**
 * Re-walk a source whose contents changed on disk. A changed banner file is
 * picked up by stashPackImages replacing the stale URL when the scan lands —
 * nothing is dropped up front, so a failed or empty rescan (dismissed
 * permission prompt, transient error) leaves the currently-displayed art
 * intact.
 */
export async function rescanSource(s: SongSource): Promise<void> {
  await loadSource(s.id, true);
  await refreshSources();
}

/** Forget a remembered source and drop its songs. */
export async function forgetSource(s: SongSource): Promise<void> {
  await removeStoredSource(s.id);
  commitEntries(state.entries.filter((e) => e.sourceId !== s.id));
  await refreshSources();
}

/**
 * "+ ADD FOLDER" via the native picker (Chromium — the choice is remembered
 * across reloads). Returns false when the picker is unsupported so the caller
 * can fall back to its <input webkitdirectory>.
 */
export async function addFolderFromPicker(): Promise<boolean> {
  if (!supportsFolderPicker()) return false;
  const added = await addSourceFromPicker(scanTick);
  if (added) {
    await addFiles(added.folder.files, added.id);
    await refreshSources();
  }
  setState({ loading: null });
  return true;
}

/**
 * Load dropped content. A single dropped folder becomes a remembered source
 * like a picker choice (Chromium); anything else loads one-off via entry
 * traversal. Both decisions happen synchronously during dispatch (the drop's
 * DataTransfer is only readable then).
 */
export async function addDropped(dt: DataTransfer): Promise<void> {
  const adopted = addSourceFromDrop(dt, scanTick);
  try {
    if (adopted) {
      const { id, folder } = await adopted;
      await addFiles(folder.files, id || undefined);
      await refreshSources();
    } else {
      setState({ loading: { msg: 'LOADING SONGS…' } });
      await addFiles(await filesFromDataTransfer(dt));
    }
  } finally {
    setState({ loading: null });
  }
}
