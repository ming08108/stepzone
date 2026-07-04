/**
 * Song preview player (#5): loops a song's sample snippet (SAMPLESTART/LENGTH)
 * while it's highlighted in the menus and on the Player Options screen. Runs on
 * its own AudioContext, independent of gameplay. Debounced so scrolling the list
 * doesn't hammer the network/decoder, with a small decoded-buffer cache. Every
 * failure is silent (no preview) — it's a nicety, never blocking.
 */
import { ensureRemoteLoaded, readRemoteAudio } from '../io/remoteLibrary';
import { type LibraryEntry, readSongAudio } from '../io/songFiles';
import type { Song } from '../song/song';

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
      current.gain.gain.linearRampToValueAtTime(0, now + 0.15);
      current.src.stop(now + 0.2);
    } catch {
      /* already stopped */
    }
  }
  current = null;
}

function begin(ac: AudioContext, buf: AudioBuffer, song: Song): void {
  let start = song.sampleStartSeconds;
  if (!(start >= 0) || start > buf.duration - 1) {
    start = Math.min(buf.duration * 0.3, Math.max(0, buf.duration - 15));
  }
  let len = song.sampleLengthSeconds || 12;
  len = Math.max(3, Math.min(len, buf.duration - start));
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
  gain.gain.linearRampToValueAtTime(0.8, now + 0.25); // fade in
  current = { src, gain };
}

async function run(
  myToken: number,
  resolve: (ac: AudioContext) => Promise<{ buf: AudioBuffer; song: Song } | null>,
): Promise<void> {
  const ac = audio();
  if (!ac) return;
  void ac.resume().catch(() => {});
  const res = await resolve(ac);
  if (!res || myToken !== token) return;
  begin(ac, res.buf, res.song);
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
  const ac = audio();
  if (!ac) return;
  stopPreview();
  const myToken = ++token;
  debounce = setTimeout(() => {
    void run(myToken, async (ac2) => {
      const key = entry.remoteDir ?? entry.sourceName;
      const cached = bufCache.get(key);
      if (cached) return { buf: cached, song: entry.song };
      let e = entry;
      if (entry.remoteDir && entry.song.charts.length === 0) {
        try {
          e = { ...entry, song: await ensureRemoteLoaded(entry) };
        } catch {
          return null;
        }
      }
      const enc = e.remoteDir ? await readRemoteAudio(e) : await readSongAudio(e);
      if (!enc) return null;
      return decodeEnc(key, enc, e.song, ac2);
    });
  }, delayMs);
}

/** Preview already-decoded-in-memory encoded audio (Player Options has it loaded). */
export function previewEncoded(key: string, enc: ArrayBuffer, song: Song, delayMs = 250): void {
  const ac = audio();
  if (!ac) return;
  stopPreview();
  const myToken = ++token;
  debounce = setTimeout(() => {
    void run(myToken, (ac2) => decodeEnc(key, enc, song, ac2));
  }, delayMs);
}
