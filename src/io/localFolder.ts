/**
 * The song library's local folder sources. Each source is a real directory
 * (a song, a pack, or a whole Songs tree) referenced by a File System Access
 * handle persisted in IndexedDB, so libraries survive reloads with no server.
 * Sources are added from the picker (`addSourceFromPicker`) or by dropping a
 * single folder (`addSourceFromDrop`), can be disabled or removed without
 * touching the disk, and are deduplicated by identity (`isSameEntry`).
 *
 * Browsers gate re-reading a stored handle behind a user-gesture permission
 * grant, so startup is two-step: `restoreSources` silently names what is still
 * trusted and what needs a gesture, then `grantPendingSources` finishes from a
 * click/keypress; choosing "Allow on every visit" in Chromium's prompt makes
 * later restores fully silent. Browsers without the API (Firefox/Safari) fall
 * back to the caller's `<input webkitdirectory>` — no persistence there.
 *
 * Scans are cached: each source stores a catalog of its songs' display
 * metadata (`saveCatalog`/`loadCatalog`), so reloads render the library
 * instantly without walking the tree; a song's real files are read on demand
 * (`readSongFolder`) when it's highlighted or played. A rescan (re-walk +
 * re-parse) refreshes the catalog when the folder changed on disk.
 */

// Only files a library can use are collected — simfiles up front, media lazily.
const KEEP_EXT = new Set([
  '.sm',
  '.ssc',
  '.sma',
  '.ogg',
  '.oga',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.flac',
  '.opus',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.mp4',
  '.webm',
  '.ogv',
  '.m4v',
  // Legacy background videos — unplayable natively, converted by io/bgVideo.ts.
  '.avi',
  '.mpg',
  '.mpeg',
]);
const MAX_DEPTH = 6; // Songs/Pack/Song is 3; headroom for nested collections

export interface LocalFolder {
  files: File[];
  name: string;
}

/** Progress callback while a folder is walked: files found so far. */
export type ScanProgress = (filesFound: number) => void;

/** A remembered folder as shown in the UI (no live handle exposed). */
export interface SongSource {
  id: string;
  name: string;
  enabled: boolean;
  /** 'granted' reads silently; 'prompt' needs a user-gesture re-grant. */
  permission: 'granted' | 'prompt';
}

export function supportsFolderPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

// --- IndexedDB persistence of the source list ---------------------------------

const DB_NAME = 'notefield-fs';
const STORE = 'handles';
const LIST_KEY = 'songFolders';
const LEGACY_KEY = 'songFolder'; // pre-multi-source single handle
const CATALOG_PREFIX = 'catalog:'; // + source id → SourceCatalog

interface StoredSource {
  id: string;
  enabled: boolean;
  handle: FileSystemDirectoryHandle;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function idbRequest<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDb();
  try {
    return await new Promise<T>((res, rej) => {
      const r = op(db.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  } finally {
    db.close();
  }
}

async function sameEntry(a: FileSystemHandle, b: FileSystemHandle): Promise<boolean> {
  try {
    return await a.isSameEntry(b);
  } catch {
    return false;
  }
}

let legacyMigrated = false;

/** Load the stored sources, folding in the pre-multi-source single handle. */
async function loadList(): Promise<StoredSource[]> {
  const list =
    ((await idbRequest('readonly', (s) => s.get(LIST_KEY))) as StoredSource[] | undefined) ?? [];
  if (!legacyMigrated) {
    legacyMigrated = true;
    const legacy = (await idbRequest('readonly', (s) => s.get(LEGACY_KEY))) as
      FileSystemDirectoryHandle | undefined;
    if (legacy) {
      let dup = false;
      for (const s of list) if (await sameEntry(legacy, s.handle)) dup = true;
      if (!dup) list.push({ id: newId(), enabled: true, handle: legacy });
      await idbRequest('readwrite', (s) => s.put(list, LIST_KEY));
      await idbRequest('readwrite', (s) => s.delete(LEGACY_KEY));
    }
  }
  return list;
}

async function saveList(list: StoredSource[]): Promise<void> {
  await idbRequest('readwrite', (s) => s.put(list, LIST_KEY));
  // Ask the browser not to evict the database holding the handles under
  // storage pressure. Silent in Chromium; failure just means default eviction.
  try {
    void navigator.storage?.persist?.();
  } catch {
    // StorageManager unavailable — nothing to pin
  }
}

/** Remember a handle, deduplicating against (and re-enabling) known sources. */
async function addHandle(handle: FileSystemDirectoryHandle): Promise<string> {
  let list: StoredSource[] = [];
  try {
    list = await loadList();
  } catch {
    // IDB unavailable (private mode) — the folder still loads this session
    return newId();
  }
  for (const s of list) {
    if (await sameEntry(s.handle, handle)) {
      if (!s.enabled) {
        s.enabled = true;
        try {
          await saveList(list);
        } catch {
          /* keep going — enabling is best-effort */
        }
      }
      return s.id;
    }
  }
  const id = newId();
  try {
    await saveList([...list, { id, enabled: true, handle }]);
  } catch {
    /* IDB write failed — session-only source */
  }
  return id;
}

// --- Directory walk -----------------------------------------------------------

/**
 * Flatten a directory handle into Files carrying `webkitRelativePath` (rooted
 * at the picked folder's name, like an `<input webkitdirectory>` selection) so
 * `loadLibraryFromFiles` groups songs and packs identically for both paths.
 */
async function collectFiles(
  dir: FileSystemDirectoryHandle,
  path: string,
  out: File[],
  depth: number,
  onScan?: ScanProgress,
): Promise<void> {
  for await (const handle of dir.values()) {
    // Skip hidden/system folders (.git, __MACOSX) — never song content.
    if (handle.name.startsWith('.') || handle.name === '__MACOSX') continue;
    try {
      if (handle.kind === 'file') {
        const dot = handle.name.lastIndexOf('.');
        if (dot < 0 || !KEEP_EXT.has(handle.name.slice(dot).toLowerCase())) continue;
        const file = await (handle as FileSystemFileHandle).getFile();
        try {
          Object.defineProperty(file, 'webkitRelativePath', {
            value: `${path}${file.name}`,
          });
        } catch {
          // read-only in some browsers; grouping falls back to the file name
        }
        out.push(file);
        if (onScan && out.length % 20 === 0) onScan(out.length);
      } else if (depth < MAX_DEPTH) {
        await collectFiles(
          handle as FileSystemDirectoryHandle,
          `${path}${handle.name}/`,
          out,
          depth + 1,
          onScan,
        );
      }
    } catch {
      // unreadable entry (permissions, broken link) — skip it, keep the rest
    }
  }
}

async function readFolder(
  handle: FileSystemDirectoryHandle,
  onScan?: ScanProgress,
): Promise<LocalFolder> {
  const files: File[] = [];
  await collectFiles(handle, `${handle.name}/`, files, 1, onScan);
  return { files, name: handle.name };
}

// --- Public flows -------------------------------------------------------------

export interface LoadedSource {
  id: string;
  folder: LocalFolder;
}

/** The remembered sources, for the management UI. */
export async function listSources(): Promise<SongSource[]> {
  let list: StoredSource[] = [];
  try {
    list = await loadList();
  } catch {
    return [];
  }
  return Promise.all(
    list.map(async (s) => ({
      id: s.id,
      name: s.handle.name,
      enabled: s.enabled,
      permission: await s.handle
        .queryPermission({ mode: 'read' })
        .then((p): 'granted' | 'prompt' => (p === 'granted' ? 'granted' : 'prompt'))
        .catch((): 'prompt' => 'prompt'),
    })),
  );
}

export async function removeSource(id: string): Promise<void> {
  try {
    const list = await loadList();
    await saveList(list.filter((s) => s.id !== id));
    await idbRequest('readwrite', (s) => s.delete(CATALOG_PREFIX + id));
  } catch {
    /* nothing stored / IDB unavailable */
  }
}

// --- Cached catalogs (skip the walk + parse on reload) --------------------------

/** One song's display metadata, enough to render a library row without I/O. */
export interface CatalogSong {
  /** Song folder path as a webkitRelativePath dir (rooted at the source name). */
  dir: string;
  title: string;
  artist: string;
  pack?: string;
  /** Display BPM, e.g. "148" or "120–160". */
  bpm?: string;
  /** dance-single meters by slot [Beginner…Expert]; null = no chart. */
  levels?: Array<number | null>;
}

interface SourceCatalog {
  /** v2: titles are display-full titles (title + subtitle); v1 rows collide. */
  v: 2;
  scannedAt: number;
  songs: CatalogSong[];
}

export async function saveCatalog(id: string, songs: CatalogSong[]): Promise<void> {
  try {
    const cat: SourceCatalog = { v: 2, scannedAt: Date.now(), songs };
    await idbRequest('readwrite', (s) => s.put(cat, CATALOG_PREFIX + id));
  } catch {
    /* IDB unavailable — next reload rescans */
  }
}

export async function loadCatalog(id: string): Promise<CatalogSong[] | null> {
  try {
    const cat = (await idbRequest('readonly', (s) => s.get(CATALOG_PREFIX + id))) as
      SourceCatalog | undefined;
    return cat && cat.v === 2 && Array.isArray(cat.songs) ? cat.songs : null;
  } catch {
    return null;
  }
}

/**
 * Read one song folder's files on demand (a catalog row being opened): resolve
 * `dir` under its source handle — one small directory listing instead of a
 * full library walk. Null when the source or folder is gone; the caller can
 * offer a rescan.
 */
export async function readSongFolder(sourceId: string, dir: string): Promise<File[] | null> {
  let list: StoredSource[] = [];
  try {
    list = await loadList();
  } catch {
    return null;
  }
  const s = list.find((x) => x.id === sourceId);
  if (!s) return null;
  try {
    // First segment is the source root's own name — traversal starts below it.
    const segs = dir.split('/').filter(Boolean).slice(1);
    let d = s.handle;
    for (const seg of segs) d = await d.getDirectoryHandle(seg);
    const files: File[] = [];
    for await (const h of d.values()) {
      if (h.kind !== 'file') continue;
      // Skip hidden/AppleDouble junk (._foo.png etc.) — same as the full walk.
      // These shadow real files (banners, simfiles) and aren't valid content.
      if (h.name.startsWith('.')) continue;
      const dot = h.name.lastIndexOf('.');
      if (dot < 0 || !KEEP_EXT.has(h.name.slice(dot).toLowerCase())) continue;
      const f = await (h as FileSystemFileHandle).getFile();
      try {
        Object.defineProperty(f, 'webkitRelativePath', { value: `${dir}/${f.name}` });
      } catch {
        /* read-only — grouping falls back to the file name */
      }
      files.push(f);
    }
    return files;
  } catch {
    return null;
  }
}

/**
 * Make sure a source is readable, prompting if allowed (call from a gesture
 * when its permission is 'prompt'). A truly dead folder is dropped.
 */
export async function ensureSourcePermission(id: string): Promise<boolean> {
  let list: StoredSource[] = [];
  try {
    list = await loadList();
  } catch {
    return false;
  }
  const s = list.find((x) => x.id === id);
  if (!s) return false;
  try {
    if ((await s.handle.queryPermission({ mode: 'read' })) === 'granted') return true;
    return (await s.handle.requestPermission({ mode: 'read' })) === 'granted';
  } catch (err) {
    if ((err as DOMException)?.name === 'NotFoundError') await removeSource(id);
    return false;
  }
}

export async function setSourceEnabled(id: string, enabled: boolean): Promise<void> {
  try {
    const list = await loadList();
    const s = list.find((x) => x.id === id);
    if (s && s.enabled !== enabled) {
      s.enabled = enabled;
      await saveList(list);
    }
  } catch {
    /* nothing stored / IDB unavailable */
  }
}

/**
 * Show the browser folder picker, remember the choice as a source, and return
 * its files. Null when the user cancels. Call from a click handler.
 */
export async function addSourceFromPicker(onScan?: ScanProgress): Promise<LoadedSource | null> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({ id: 'songs', mode: 'read' });
  } catch {
    return null; // canceled (AbortError) or blocked
  }
  const id = await addHandle(handle);
  return { id, folder: await readFolder(handle, onScan) };
}

/**
 * Adopt a folder dropped onto the page: when the drop is exactly one directory
 * and the browser exposes drop handles (Chromium), read it through the same
 * handle path as the picker so it's remembered as a source. Returns null —
 * decided synchronously, so callers can still use the legacy entry-traversal
 * path on the same DataTransfer — for multi-item drops, loose files, or
 * browsers without handle support. Must be called during drop dispatch,
 * before any await.
 */
export function addSourceFromDrop(
  dt: DataTransfer,
  onScan?: ScanProgress,
): Promise<LoadedSource> | null {
  const items = Array.from(dt.items ?? []).filter((it) => it.kind === 'file');
  if (items.length !== 1 || !('getAsFileSystemHandle' in items[0])) return null;
  const entry = items[0].webkitGetAsEntry();
  if (!entry?.isDirectory) return null;
  const pending = items[0].getAsFileSystemHandle(); // request before the event goes inert
  return (async () => {
    const handle = await pending;
    if (!handle || handle.kind !== 'directory') return { id: '', folder: { files: [], name: '' } };
    const dir = handle as FileSystemDirectoryHandle;
    const id = await addHandle(dir);
    return { id, folder: await readFolder(dir, onScan) };
  })();
}

/**
 * Read one source's folder, requesting permission if needed (call from a
 * gesture when the source is 'prompt'). Null when denied or missing; a truly
 * dead folder (deleted/moved) is dropped from the list.
 */
export async function readSource(id: string, onScan?: ScanProgress): Promise<LocalFolder | null> {
  let list: StoredSource[] = [];
  try {
    list = await loadList();
  } catch {
    return null;
  }
  const s = list.find((x) => x.id === id);
  if (!s) return null;
  try {
    const state = await s.handle.queryPermission({ mode: 'read' });
    if (state !== 'granted' && (await s.handle.requestPermission({ mode: 'read' })) !== 'granted')
      return null;
    return await readFolder(s.handle, onScan);
  } catch (err) {
    // Forget the source only when the folder is truly gone — a transient
    // failure (e.g. no user activation) must not cost the user their library.
    if ((err as DOMException)?.name === 'NotFoundError') await removeSource(id);
    return null;
  }
}

/**
 * Startup pass: name every enabled source the browser still trusts (ready to
 * load from its cached catalog or a scan) and the ones that need a
 * user-gesture re-grant (`grantPendingSources`). No folder is walked here.
 * Sources whose folders are gone are dropped from the list.
 */
export async function restoreSources(): Promise<{
  granted: Array<{ id: string; name: string }>;
  pendingNames: string[];
}> {
  return sweepSources(false);
}

/**
 * Finish a restore that needed a gesture: request permission for each pending
 * source. Call from a click/keydown handler. Sources still denied stay in
 * `pendingNames` for another attempt.
 */
export async function grantPendingSources(): Promise<{
  granted: Array<{ id: string; name: string }>;
  pendingNames: string[];
}> {
  return sweepSources(true);
}

async function sweepSources(mayPrompt: boolean): Promise<{
  granted: Array<{ id: string; name: string }>;
  pendingNames: string[];
}> {
  let list: StoredSource[] = [];
  try {
    list = await loadList();
  } catch {
    return { granted: [], pendingNames: [] };
  }
  const granted: Array<{ id: string; name: string }> = [];
  const pendingNames: string[] = [];
  const dead: string[] = [];
  for (const s of list) {
    if (!s.enabled) continue;
    try {
      let state = await s.handle.queryPermission({ mode: 'read' });
      if (state !== 'granted' && mayPrompt) {
        state = await s.handle.requestPermission({ mode: 'read' });
      }
      if (state === 'granted') granted.push({ id: s.id, name: s.handle.name });
      else pendingNames.push(s.handle.name);
    } catch (err) {
      if ((err as DOMException)?.name === 'NotFoundError') dead.push(s.id);
      else pendingNames.push(s.handle.name);
    }
  }
  for (const id of dead) await removeSource(id);
  return { granted, pendingNames };
}
