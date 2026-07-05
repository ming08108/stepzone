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
  isVideoFile,
  type LibraryEntry,
} from './songFiles';
import { getCachedVideo, putCachedVideo, videoCacheKey } from './videoCache';

// Background quality is deliberately modest — these render dimmed behind the
// note field. x264 ultrafast benchmarked ~11x realtime in the wasm core
// (~4.5x faster than realtime-deadline VP8 on the same clip).
const X264_ARGS = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p'];

/**
 * The video codec name from ffmpeg's `-i` stream banner, lowercased — e.g.
 * "Stream #0:0: Video: h264 (High) ..." → "h264". Null when no video stream
 * was reported. Pure, for tests.
 */
export function parseVideoCodec(log: string): string | null {
  const m = log.match(/Stream #[^\n]*?: Video: ([A-Za-z0-9_]+)/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Conversion plan for a probed codec. Most "legacy" files are actually H.264
 * in an AVI shell (~94% of a typical modernized library) — browsers play that
 * natively once remuxed into MP4, a lossless container swap that runs in
 * ~0.1s. Everything else (XviD/DivX/MPEG-1/2/h263) is really transcoded.
 */
export function planConversion(codec: string | null): { args: string[]; ext: 'mp4' | 'webm' } {
  if (codec === 'h264') return { args: ['-c:v', 'copy'], ext: 'mp4' };
  return { args: X264_ARGS, ext: 'mp4' };
}

export interface BgConvertStatus {
  name: string;
  /** 0..1 within the current file. */
  progress: number;
  /** Jobs left including this one (n−1 more queued behind it). */
  remaining: number;
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
// Collects ffmpeg log lines while a probe runs (see probeVideoCodec).
let logBuf: string[] | null = null;

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
      ff.on('log', ({ message }) => {
        logBuf?.push(message);
      });
      await ff.load({ coreURL: core.default, wasmURL: wasm.default });
      return ff;
    } catch (err) {
      console.warn('[bgVideo] ffmpeg.wasm failed to load — legacy backgrounds stay static:', err);
      return null;
    }
  })();
  return ffP;
}

/** Codec of the (already written) input, from a fast no-output `-i` run. */
async function probeVideoCodec(ff: FFmpeg, inName: string): Promise<string | null> {
  logBuf = [];
  try {
    await ff.exec(['-hide_banner', '-i', inName]); // exits non-zero: no output requested
  } catch {
    /* expected */
  }
  const text = logBuf.join('\n');
  logBuf = null;
  return parseVideoCodec(text);
}

async function convert(
  ff: FFmpeg,
  file: File,
): Promise<{ data: Uint8Array; ext: 'mp4' | 'webm' } | null> {
  const dot = file.name.lastIndexOf('.');
  const inName = `in${dot >= 0 ? file.name.slice(dot).toLowerCase() : ''}`;
  let outName = '';
  try {
    await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    const plan = planConversion(await probeVideoCodec(ff, inName));
    outName = `out.${plan.ext}`;
    const code = await ff.exec(['-i', inName, ...plan.args, '-an', '-y', outName]);
    if (code !== 0) {
      console.warn(`[bgVideo] conversion of "${file.name}" exited with code ${code}`);
      return null;
    }
    const data = await ff.readFile(outName);
    return data instanceof Uint8Array && data.byteLength > 0 ? { data, ext: plan.ext } : null;
  } catch (err) {
    console.warn(`[bgVideo] conversion of "${file.name}" failed:`, err);
    return null;
  } finally {
    void ff.deleteFile(inName).catch(() => {});
    if (outName) void ff.deleteFile(outName).catch(() => {});
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
      notify({ name: file.name, progress: 0, remaining: queued.size });
      const out = await convert(ff, file);
      if (out) await putCachedVideo(key, out.data, out.ext);
    } catch {
      /* cosmetic by contract */
    } finally {
      queued.delete(key);
      notify(null);
    }
  });
}

/**
 * The background to play for an entry: a natively playable VIDEO, else the
 * cached conversion of a legacy movie, else the static image (with a
 * conversion queued in the background so the movie is there next time).
 */
export async function resolveBackground(entry: LibraryEntry): Promise<File | null> {
  const playable = findBackgroundFile(entry);
  if (playable && isVideoFile(playable.name)) return playable;
  const legacy = findConvertibleBackground(entry);
  if (!legacy) return playable; // static image or nothing — no movie to convert
  const key = videoCacheKey(entry.sourceId, relPath(legacy), legacy.size);
  const cached = await getCachedVideo(key);
  if (cached) return cached;
  queueConvert(key, legacy);
  return playable; // static image while the movie converts
}
