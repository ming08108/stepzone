/**
 * Song preview player (#5): loops a song's sample snippet (SAMPLESTART/LENGTH)
 * while it's highlighted in the menus and on the Player Options screen. Runs on
 * its own AudioContext, independent of gameplay. Debounced so scrolling the list
 * doesn't hammer the disk/decoder, with a small decoded-buffer cache. Every
 * failure is silent (no preview) — it's a nicety, never blocking.
 */
import { type LibraryEntry, readSongAudio } from '../io/songFiles';
import type { Song } from '../song/song';
import { previewWindow } from './previewWindow';

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
let current: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;

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

function begin(ac: AudioContext, buf: AudioBuffer, song: Song): void {
  const { startSeconds: start, lengthSeconds: len } = previewWindow(
    buf.duration,
    song.sampleStartSeconds,
    song.sampleLengthSeconds,
  );
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.loopStart = start;
  src.loopEnd = start + len;
  const gain = ac.createGain();
  gain.gain.value = 0;
  src.connect(gain).connect(ac.destination);
  try {
    src.start(0, start);
  } catch {
    return;
  }
  const now = ac.currentTime;
  gain.gain.linearRampToValueAtTime(PREVIEW_GAIN, now + FADE_IN_SECONDS); // fade in
  current = { src, gain };
}

type ResolvePreview = (ac: AudioContext) => Promise<{ buf: AudioBuffer; song: Song } | null>;

/**
 * The shared debounce/cancel dance both entry points use: stop whatever is
 * playing or pending, claim a fresh token, and run `resolve` after `delayMs`
 * unless a newer request supersedes it in the meantime.
 */
function schedulePreview(delayMs: number, resolve: ResolvePreview): void {
  const ac = audio();
  if (!ac) return;
  stopPreview();
  const myToken = ++token;
  debounce = setTimeout(() => {
    void run(myToken, resolve);
  }, delayMs);
}

async function run(myToken: number, resolve: ResolvePreview): Promise<void> {
  try {
    const ac = audio();
    if (!ac) return;
    void ac.resume().catch(() => {});
    const res = await resolve(ac);
    if (!res || myToken !== token) return;
    begin(ac, res.buf, res.song);
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

/** Preview already-decoded-in-memory encoded audio (Player Options has it loaded). */
export function previewEncoded(key: string, enc: ArrayBuffer, song: Song, delayMs = 250): void {
  schedulePreview(delayMs, (ac) => decodeEnc(key, enc, song, ac));
}
