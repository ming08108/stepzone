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
const MAX_CACHE = 6;
function cache(key: string, buf: AudioBuffer): void {
  bufCache.set(key, buf);
  if (bufCache.size > MAX_CACHE) {
    const first = bufCache.keys().next().value;
    if (first) bufCache.delete(first);
  }
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

function begin(ac: AudioContext, buf: AudioBuffer, song: Song, win?: PreviewLoopWindow): void {
  const { startSeconds: start, lengthSeconds: len } = win
    ? {
        startSeconds: Math.min(Math.max(0, win.startSeconds), Math.max(0, buf.duration - 0.5)),
        lengthSeconds: Math.max(
          0.5,
          Math.min(win.lengthSeconds, buf.duration - Math.max(0, win.startSeconds)),
        ),
      }
    : previewWindow(buf.duration, song.sampleStartSeconds, song.sampleLengthSeconds);
  const src = ac.createBufferSource();
  src.buffer = buf;
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
  sync.startContextTime = when - start; // rate 1: song-second 0 <-> context time
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
function schedulePreview(delayMs: number, resolve: ResolvePreview, win?: PreviewLoopWindow): void {
  const ac = audio();
  if (!ac) return;
  stopPreview();
  const myToken = ++token;
  debounce = setTimeout(() => {
    void run(myToken, resolve, win);
  }, delayMs);
}

async function run(
  myToken: number,
  resolve: ResolvePreview,
  win?: PreviewLoopWindow,
): Promise<void> {
  try {
    const ac = audio();
    if (!ac) return;
    void ac.resume().catch(() => {});
    const res = await resolve(ac);
    if (!res || myToken !== token) return;
    begin(ac, res.buf, res.song, win);
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
    // Key on the song folder's path — simfile names alone collide across packs.
    const key = entry.files[0]?.webkitRelativePath || entry.sourceName;
    const cached = bufCache.get(key);
    if (cached) return { buf: cached, song: entry.song };
    const enc = await readSongAudio(entry);
    if (!enc) return null;
    return decodeEnc(key, enc, entry.song, ac);
  });
}

/** Preview already-decoded-in-memory encoded audio (Player Options has it loaded).
 *  `win` overrides the loop to an explicit window — the practice section. */
export function previewEncoded(
  key: string,
  enc: ArrayBuffer,
  song: Song,
  delayMs = 250,
  win?: PreviewLoopWindow,
): void {
  schedulePreview(delayMs, (ac) => decodeEnc(key, enc, song, ac), win);
}
