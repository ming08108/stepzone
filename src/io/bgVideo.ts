/**
 * Legacy background videos (.avi/.mpg — DivX/XviD/MPEG-1/2) can't be decoded
 * by any browser, so they're transcoded ONCE to VP8/WebM with a lazy-loaded
 * ffmpeg.wasm and cached in OPFS (io/videoCache.ts); playback is then a plain
 * native <video>, costing gameplay nothing. The decoder (~10 MB gzipped) is
 * fetched only when a convertible background is actually encountered.
 *
 * `resolveBackground` is the one entry point: it prefers a natively playable
 * file, then the cached conversion, and otherwise queues a conversion in the
 * background and returns null — that play just gets a static background, the
 * next one gets the video. Conversions run one at a time in ffmpeg's worker;
 * every failure path is cosmetic (no video), never an error the player sees.
 */

import type { FFmpeg } from '@ffmpeg/ffmpeg';
import {
  findBackgroundFile,
  findConvertibleBackground,
  type LibraryEntry,
} from './songFiles';
import { getCachedVideo, putCachedVideo, videoCacheKey } from './videoCache';

// Background quality is deliberately modest: these render dimmed behind the
// note field, and realtime-deadline VP8 keeps a 90s clip's conversion short.
const FFMPEG_ARGS = ['-c:v', 'libvpx', '-b:v', '900k', '-deadline', 'realtime', '-cpu-used', '5'];

export interface BgConvertStatus {
  name: string;
  /** 0..1 within the current file. */
  progress: number;
}

const subs = new Set<(s: BgConvertStatus | null) => void>();
let current: BgConvertStatus | null = null;

function notify(s: BgConvertStatus | null): void {
  current = s;
  for (const cb of subs) cb(s);
}

/** Observe conversion activity (for a passive UI badge). Returns unsubscribe. */
export function subscribeBgConvert(cb: (s: BgConvertStatus | null) => void): () => void {
  subs.add(cb);
  cb(current);
  return () => {
    subs.delete(cb);
  };
}

// One ffmpeg instance, loaded on first need and reused; null = load failed
// (offline before first fetch, unsupported browser) — retried next session.
let ffP: Promise<FFmpeg | null> | null = null;

function ensureFfmpeg(): Promise<FFmpeg | null> {
  ffP ??= (async () => {
    try {
      const [{ FFmpeg }, core, wasm] = await Promise.all([
        import('@ffmpeg/ffmpeg'),
        import('@ffmpeg/core?url'),
        import('@ffmpeg/core/wasm?url'),
      ]);
      const ff = new FFmpeg();
      ff.on('progress', ({ progress }) => {
        if (current) notify({ ...current, progress: Math.max(0, Math.min(1, progress)) });
      });
      await ff.load({ coreURL: core.default, wasmURL: wasm.default });
      return ff;
    } catch {
      return null;
    }
  })();
  return ffP;
}

async function convert(ff: FFmpeg, file: File): Promise<Uint8Array | null> {
  const dot = file.name.lastIndexOf('.');
  const inName = `in${dot >= 0 ? file.name.slice(dot).toLowerCase() : ''}`;
  const outName = 'out.webm';
  try {
    await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    const code = await ff.exec(['-i', inName, ...FFMPEG_ARGS, '-an', '-y', outName]);
    if (code !== 0) return null;
    const data = await ff.readFile(outName);
    return data instanceof Uint8Array && data.byteLength > 0 ? data : null;
  } catch {
    return null;
  } finally {
    void ff.deleteFile(inName).catch(() => {});
    void ff.deleteFile(outName).catch(() => {});
  }
}

function relPath(f: File): string {
  return f.webkitRelativePath && f.webkitRelativePath.length > 0 ? f.webkitRelativePath : f.name;
}

// Serialized conversion queue — ffmpeg.wasm runs one command at a time, and
// background conversion should never compete with itself for CPU.
const queued = new Set<string>();
let chain: Promise<void> = Promise.resolve();

function queueConvert(key: string, file: File): void {
  if (queued.has(key)) return;
  queued.add(key);
  chain = chain.then(async () => {
    try {
      if (await getCachedVideo(key)) return; // raced: another play converted it
      const ff = await ensureFfmpeg();
      if (!ff) return;
      notify({ name: file.name, progress: 0 });
      const out = await convert(ff, file);
      if (out) await putCachedVideo(key, out);
    } catch {
      /* cosmetic by contract */
    } finally {
      queued.delete(key);
      notify(null);
    }
  });
}

/**
 * The background to play for an entry: a natively playable file, else the
 * cached conversion of a legacy video, else null (with a conversion queued in
 * the background so the video is there next time).
 */
export async function resolveBackground(entry: LibraryEntry): Promise<File | null> {
  const playable = findBackgroundFile(entry);
  if (playable) return playable;
  const legacy = findConvertibleBackground(entry);
  if (!legacy) return null;
  const key = videoCacheKey(entry.sourceId, relPath(legacy), legacy.size);
  const cached = await getCachedVideo(key);
  if (cached) return cached;
  queueConvert(key, legacy);
  return null;
}
