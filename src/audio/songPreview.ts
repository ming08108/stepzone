/**
 * Song preview player (#5): loops a song's sample snippet (SAMPLESTART/LENGTH)
 * while it's highlighted in the menus and on the Player Options screen. Runs on
 * its own AudioContext, independent of gameplay — but exposes its audible
 * position through the SAME clock mapping gameplay uses (SyncMap anchored via
 * anchorSyncFromOutput, see audio/clock.ts), so UI synced to
 * previewPositionSeconds() can never drift from the music. Debounced so
 * scrolling the list doesn't hammer the disk/decoder, with a small
 * decoded-buffer cache. Every failure is silent (no preview) — it's a nicety,
 * never blocking.
 */
import { type LibraryEntry, readSongAudio } from '../io/songFiles';
import type { Song } from '../song/song';
import { anchorSyncFromOutput } from './clock';
import { previewWindow } from './previewWindow';
import { SyncMap } from './syncMap';

// Fade/stop envelope (seconds) and target loudness for the preview loop.
const FADE_IN_SECONDS = 0.25;
const FADE_OUT_SECONDS = 0.15;
const STOP_LAG_SECONDS = 0.2; // stop the source just after the fade-out lands
const PREVIEW_GAIN = 0.8;

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      ctx = Ctor ? new Ctor() : null;
    }
    return ctx;
  } catch {
    return null;
  }
}

const bufCache = new Map<string, AudioBuffer>();
const MAX_CACHE = 12; // current + a few scroll steps of prefetched neighbors
function cache(key: string, buf: AudioBuffer): void {
  bufCache.set(key, buf);
  if (bufCache.size > MAX_CACHE) {
    const first = bufCache.keys().next().value;
    if (first) bufCache.delete(first);
  }
}

/** Cache key for a library entry (song folder path — names collide across packs). */
function entryKey(entry: LibraryEntry): string {
  return entry.files[0]?.webkitRelativePath || entry.sourceName;
}

/** Is this entry's audio already decoded (a preview would start instantly)? */
export function previewCached(entry: LibraryEntry): boolean {
  return bufCache.has(entryKey(entry));
}

const inflight = new Set<string>();

/**
 * Warm the preview cache for a song without playing it — the song-select
 * cursor's neighbors, so scrolling onto them starts their sample immediately.
 * Never touches the currently playing/debounced preview; silent on failure.
 */
export function prefetchSong(entry: LibraryEntry): void {
  const ac = audio();
  if (!ac) return;
  const key = entryKey(entry);
  if (bufCache.has(key) || inflight.has(key)) return;
  inflight.add(key);
  void (async () => {
    try {
      const enc = await readSongAudio(entry);
      if (!enc || bufCache.has(key)) return;
      cache(key, await ac.decodeAudioData(enc.slice(0)));
    } catch {
      // silent by contract (see header) — no prefetch, preview decodes later
    } finally {
      inflight.delete(key);
    }
  })();
}

let token = 0; // bumped to cancel any in-flight / scheduled preview
let current: {
  src: AudioBufferSourceNode;
  gain: GainNode;
  /** The gameplay clock mapping (audio/syncMap.ts): song-second 0 anchored to
   *  the scheduled start, re-anchored per read from getOutputTimestamp — the
   *  SAME sync path as WebAudioClock, so the preview sits on the audible axis
   *  with no drift and no output-latency lead. */
  sync: SyncMap;
  startOffset: number;
  loopLen: number;
} | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;

/**
 * The song position (seconds into the audio file) the playing preview loop is
 * *audibly* at right now, or null when nothing is playing. UI playheads and
 * the synced note-field preview poll this per frame.
 */
export function previewPositionSeconds(): number | null {
  if (!current || !ctx) return null;
  anchorSyncFromOutput(ctx, current.sync);
  // The un-looped timeline since the scheduled start, folded into the loop.
  const rel = current.sync.songSecondsAtPerf(performance.now()) - current.startOffset;
  if (rel <= 0) return current.startOffset; // start lead: nothing audible yet
  return current.startOffset + (rel % current.loopLen);
}

export function stopPreview(): void {
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  token++;
  const ac = ctx;
  if (current && ac) {
    try {
      const now = ac.currentTime;
      current.gain.gain.cancelScheduledValues(now);
      current.gain.gain.setValueAtTime(current.gain.gain.value, now);
      current.gain.gain.linearRampToValueAtTime(0, now + FADE_OUT_SECONDS);
      current.src.stop(now + STOP_LAG_SECONDS);
    } catch {
      /* already stopped */
    }
  }
  current = null;
}

/** Explicit loop window (seconds into the audio), e.g. a practice section. */
export interface PreviewLoopWindow {
  startSeconds: number;
  lengthSeconds: number;
}

function begin(
  ac: AudioContext,
  buf: AudioBuffer,
  song: Song,
  win?: PreviewLoopWindow,
  rate = 1,
): void {
  // The simfile's sample window, unless an explicit window (the practice
  // section) overrides it — clamped inside the buffer.
  let { startSeconds: start, lengthSeconds: len } = previewWindow(
    buf.duration,
    song.sampleStartSeconds,
    song.sampleLengthSeconds,
  );
  if (win) {
    start = Math.min(Math.max(0, win.startSeconds), Math.max(0, buf.duration - 0.5));
    len = Math.max(0.5, Math.min(win.lengthSeconds, buf.duration - start));
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  src.loop = true;
  src.loopStart = start;
  src.loopEnd = start + len;
  const gain = ac.createGain();
  gain.gain.value = 0;
  src.connect(gain).connect(ac.destination);
  // Schedule at an explicit context time (like WebAudioClock.start) so the
  // mapping is exact: song-second `start` plays at context time `when`.
  const when = ac.currentTime + 0.05;
  try {
    src.start(when, start);
  } catch {
    return;
  }
  const sync = new SyncMap();
  sync.playbackRate = rate;
  sync.startContextTime = when - start / rate; // song-second 0 <-> context time
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(PREVIEW_GAIN, when + FADE_IN_SECONDS); // fade in
  current = { src, gain, sync, startOffset: start, loopLen: len };
}

type ResolvePreview = (ac: AudioContext) => Promise<{ buf: AudioBuffer; song: Song } | null>;

/**
 * The shared debounce/cancel dance both entry points use: stop whatever is
 * playing or pending, claim a fresh token, and run `resolve` after `delayMs`
 * unless a newer request supersedes it in the meantime.
 */
function schedulePreview(
  delayMs: number,
  resolve: ResolvePreview,
  win?: PreviewLoopWindow,
  rate = 1,
): void {
  const ac = audio();
  if (!ac) return;
  stopPreview();
  const myToken = ++token;
  debounce = setTimeout(() => {
    void run(myToken, resolve, win, rate);
  }, delayMs);
}

async function run(
  myToken: number,
  resolve: ResolvePreview,
  win?: PreviewLoopWindow,
  rate = 1,
): Promise<void> {
  try {
    const ac = audio();
    if (!ac) return;
    void ac.resume().catch(() => {});
    const res = await resolve(ac);
    if (!res || myToken !== token) return;
    begin(ac, res.buf, res.song, win, rate);
  } catch {
    // Silent by contract (see header): read/decode failures just mean
    // no preview, never an unhandled rejection.
  }
}

async function decodeEnc(
  key: string,
  enc: ArrayBuffer,
  song: Song,
  ac: AudioContext,
): Promise<{ buf: AudioBuffer; song: Song } | null> {
  const cached = bufCache.get(key);
  if (cached) return { buf: cached, song };
  let buf: AudioBuffer;
  try {
    buf = await ac.decodeAudioData(enc.slice(0)); // copy: keep enc intact for gameplay
  } catch {
    return null;
  }
  cache(key, buf);
  return { buf, song };
}

/** Preview a library entry after a short settle delay (song-select hover). */
export function previewSong(entry: LibraryEntry, delayMs = 450): void {
  schedulePreview(delayMs, async (ac) => {
    const key = entryKey(entry);
    const cached = bufCache.get(key);
    if (cached) return { buf: cached, song: entry.song };
    const enc = await readSongAudio(entry);
    if (!enc) return null;
    return decodeEnc(key, enc, entry.song, ac);
  });
}

/** Preview already-decoded-in-memory encoded audio (Player Options has it loaded).
 *  `win` overrides the loop to an explicit window — the practice section —
 *  and `rate` plays it at the chosen MUSIC RATE, like gameplay will. */
export function previewEncoded(
  key: string,
  enc: ArrayBuffer,
  song: Song,
  delayMs = 250,
  win?: PreviewLoopWindow,
  rate = 1,
): void {
  schedulePreview(delayMs, (ac) => decodeEnc(key, enc, song, ac), win, rate);
}
