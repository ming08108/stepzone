/**
 * Pick a local song folder (a song, a pack, or a whole Songs directory) with
 * the File System Access API, and remember it across reloads: the directory
 * handle is persisted in IndexedDB, so next launch the library reloads straight
 * from disk — no song server needed. Browsers gate re-reading a stored handle
 * behind a user-gesture permission grant, so restore is two-step: probe
 * silently (`restoreSongFolder`), then finish from a click (`grantStoredFolder`).
 * Browsers without the API (Firefox/Safari) fall back to the caller's
 * `<input webkitdirectory>` — no persistence there.
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
]);
const MAX_DEPTH = 6; // Songs/Pack/Song is 3; headroom for nested collections

export interface LocalFolder {
  files: File[];
  name: string;
}

export function supportsFolderPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

// --- IndexedDB persistence of the directory handle ---------------------------

const DB_NAME = 'notefield-fs';
const STORE = 'handles';
const KEY = 'songFolder';

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

async function storeHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await idbRequest('readwrite', (s) => s.put(handle, KEY));
}

async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  return (await idbRequest('readonly', (s) => s.get(KEY))) ?? null;
}

/** Drop the remembered folder (it moved, or the user picked a bad one). */
export async function forgetStoredFolder(): Promise<void> {
  try {
    await idbRequest('readwrite', (s) => s.delete(KEY));
  } catch {
    // nothing stored / IDB unavailable — already forgotten
  }
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
      } else if (depth < MAX_DEPTH) {
        await collectFiles(
          handle as FileSystemDirectoryHandle,
          `${path}${handle.name}/`,
          out,
          depth + 1,
        );
      }
    } catch {
      // unreadable entry (permissions, broken link) — skip it, keep the rest
    }
  }
}

async function readFolder(handle: FileSystemDirectoryHandle): Promise<LocalFolder> {
  const files: File[] = [];
  await collectFiles(handle, `${handle.name}/`, files, 1);
  return { files, name: handle.name };
}

// --- Public flows -------------------------------------------------------------

/**
 * Show the browser folder picker, remember the choice, and return its files.
 * Null when the user cancels. Call from a click handler.
 */
export async function pickSongFolder(): Promise<LocalFolder | null> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({ id: 'songs', mode: 'read' });
  } catch {
    return null; // canceled (AbortError) or blocked
  }
  try {
    await storeHandle(handle);
  } catch {
    // IDB unavailable (private mode) — the pick still works for this session
  }
  return readFolder(handle);
}

/**
 * Try to reload the remembered folder at startup. Resolves to the files when
 * the browser still trusts the handle, `{ needsGesture }` when a click must
 * re-grant access first, or null when nothing usable is stored.
 */
export async function restoreSongFolder(): Promise<
  LocalFolder | { needsGesture: true; name: string } | null
> {
  let handle: FileSystemDirectoryHandle | null;
  try {
    handle = await loadHandle();
  } catch {
    return null;
  }
  if (!handle) return null;
  try {
    if ((await handle.queryPermission({ mode: 'read' })) === 'granted') {
      return await readFolder(handle);
    }
    return { needsGesture: true, name: handle.name };
  } catch {
    // handle no longer resolvable (folder deleted/moved) — forget it
    await forgetStoredFolder();
    return null;
  }
}

/**
 * Finish a restore that needed a gesture: request permission and read the
 * folder. Call from a click handler. Null when denied or the folder is gone
 * (the stale handle is forgotten so the prompt doesn't reappear).
 */
export async function grantStoredFolder(): Promise<LocalFolder | null> {
  let handle: FileSystemDirectoryHandle | null;
  try {
    handle = await loadHandle();
  } catch {
    return null;
  }
  if (!handle) return null;
  try {
    if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') return null;
    return await readFolder(handle);
  } catch {
    await forgetStoredFolder();
    return null;
  }
}
