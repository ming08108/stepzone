/**
 * The room store — module-scoped owner of the multiplayer lifecycle (the
 * signaling channels, every RTCDataChannel, and the RoomHost/RoomGuest
 * controller), same pattern as libraryStore: a room is GLOBAL state that
 * survives every screen transition (SongSelect → PLAYER OPTIONS → Play →
 * results → back) and StrictMode double-mounts, so components only subscribe
 * and call the exported operations — nothing here is created or torn down in
 * a React effect.
 *
 * Rooms are persistent (docs/VERSUS.md): hostRoom()/joinRoomByCode() bring a
 * party up with no song attached; the host announces a song each time they
 * land on PLAYER OPTIONS (announceSong), guests auto-follow it — resolving
 * their local copy by chart hash, or pulling the files P2P from the host —
 * and the App routes them by the follow state. leaveRoom() is the only exit.
 */
import { findAudioFile, findBackgroundFile, findSimfile, type LibraryEntry } from '../io/songFiles';
import { resolveBackground } from '../io/bgVideo';
import { readSongAudio } from '../io/songFiles';
import { getIdentity } from '../net/identity';
import { RoomGuest, RoomHost, type RoomPeer } from '../net/roomPeer';
import { sendBinaryChunks, TransferSink } from '../net/versusTransfer';
import {
  createRoomChannel,
  joinRoomChannel,
  type HostedRoomChannel,
  type VersusConnection,
} from '../net/versusSignal';
import {
  MAX_AUDIO_BYTES,
  MAX_BG_BYTES,
  MAX_SIMFILE_CHARS,
  type TransferBinary,
  type VersusSongRef,
} from '../net/versus';
import type { Song } from '../song/song';
import type { PlayRequest, RoomPlayInfo } from './playRequest';
import { addFiles, ensureLoaded, libraryState } from './libraryStore';
import { chartForPick, findSongByAnyHash, pickOf } from './versusResolve';

/** What a guest's auto-follow of the host's song pick is currently doing. */
export type FollowState =
  | { k: 'none' }
  | { k: 'resolving'; message: string }
  | { k: 'ready'; req: PlayRequest }
  | { k: 'error'; message: string };

export type RoomUiState =
  | { k: 'idle' }
  | { k: 'busy'; message: string }
  | { k: 'error'; message: string }
  | { k: 'in-room'; room: RoomPeer; follow: FollowState };

let room: RoomPeer | null = null;
let hosted: HostedRoomChannel | null = null;
/** Host: guest id -> its connection (binary file streaming needs the channel). */
const connections = new Map<number, VersusConnection>();
let guestConnection: VersusConnection | null = null;
/** Host: the current song's library entry — the file source for transfers. */
let hostEntry: LibraryEntry | null = null;
/** Host: what announceSong last broadcast (dedupe re-announces). */
let announced: { key: string; rate: number } | null = null;
/** Host: the announce that couldn't apply yet (a racer was still mid-song
 *  when the host picked — setSong only works in the lobby). Replayed by the
 *  update hook the moment the room cycles back. */
let wantSong: { ref: VersusSongRef; key: string; rate: number } | null = null;
/** Guest: reassembles the in-flight incoming transfer. */
let sink: TransferSink | null = null;
let follow: FollowState = { k: 'none' };
/** Guards stale async follow resolutions (a newer song broadcast wins). */
let followToken = 0;

let state: RoomUiState = { k: 'idle' };
const listeners = new Set<() => void>();

function notify(): void {
  // Fresh snapshot object each change — useSyncExternalStore re-renders on
  // reference identity, and the room controller mutates in place.
  state = room ? { k: 'in-room', room, follow } : state;
  for (const cb of [...listeners]) cb();
}

function setState(next: RoomUiState): void {
  state = next;
  for (const cb of [...listeners]) cb();
}

export function roomState(): RoomUiState {
  return state;
}

export function subscribeRoom(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The live room controller, or null. */
export function currentRoom(): RoomPeer | null {
  return room && !room.ended ? room : null;
}

/** Tear down whatever exists and return to idle. Safe in any state. */
export function leaveRoom(): void {
  hosted?.close();
  hosted = null;
  if (room) {
    // Detach BEFORE leaving: the channel's async close event must not fire
    // onClosed and paint a "CONNECTION LOST" error over a deliberate exit.
    room.onClosed = undefined;
    room.onUpdate = undefined;
    room.onSong = undefined;
    room.leave();
  }
  room = null;
  wantSong = null;
  for (const conn of connections.values()) conn.close();
  connections.clear();
  guestConnection?.close();
  guestConnection = null;
  hostEntry = null;
  announced = null;
  sink = null;
  follow = { k: 'none' };
  followToken++;
  setState({ k: 'idle' });
}

/** Clear an error banner back to idle (no-op elsewhere). */
export function dismissRoomError(): void {
  if (state.k === 'error') setState({ k: 'idle' });
}

// ---- hosting -----------------------------------------------------------------------

/** Open a room (no song needed — pick one whenever). Resolves once hosting. */
export async function hostRoom(): Promise<void> {
  if (state.k === 'busy' || currentRoom()) return;
  setState({ k: 'busy', message: 'CREATING ROOM…' });
  const channel = await createRoomChannel(getIdentity().name);
  if (!channel) {
    setState({ k: 'error', message: 'MULTIPLAYER UNAVAILABLE (SERVER OFFLINE?)' });
    return;
  }
  const host = new RoomHost(channel.code, { name: getIdentity().name });
  hosted = channel;
  room = host;
  host.onUpdate = () => {
    // A cycle ending may unblock a song the host picked while it ran.
    applyWantSong();
    notify();
  };
  host.onFileReq = (guestId) => void serveSongTransfer(host, guestId);
  channel.onPeer = (conn) => {
    const id = host.attachGuest({
      send: (d) => conn.channel.send(d),
      close: () => conn.close(),
    });
    connections.set(id, conn);
    conn.channel.addEventListener('message', (e) => {
      if (typeof e.data === 'string') host.handleGuestMessage(id, e.data);
    });
    conn.channel.addEventListener('close', () => {
      host.handleGuestClose(id);
      connections.delete(id);
    });
  };
  channel.onDead = () => {
    // Signaling lost the room (server restart) — the party lives on over the
    // open channels, but the code can't admit anyone new.
    notify();
  };
  setState({ k: 'in-room', room: host, follow });
}

/**
 * Host, on PLAYER OPTIONS: this song (and rate) is what the room plays next.
 * Re-announcing the same song+rate is a no-op so a StrictMode re-run or an
 * unrelated re-render can't wipe everyone's readiness.
 */
export function announceSong(song: Song, musicRate: number, entry?: LibraryEntry): void {
  const r = currentRoom();
  if (!r || !r.isHost || !(r instanceof RoomHost)) return;
  const ref: VersusSongRef = {
    title: song.displayFullTitle || 'Untitled',
    artist: song.artist,
    charts: song.charts.map((c) => pickOf(song, c)),
  };
  const key = ref.charts.map((c) => c.chartHash).join(',');
  // Re-announcing the same song is a no-op ONLY while the cycle is fresh —
  // after a race (results on the roster) the same song means "again!", which
  // must start a new cycle. StrictMode re-runs land in the fresh case.
  const raced = r.players.some((p) => p.done || p.result !== null);
  if (!raced && announced && announced.key === key && announced.rate === musicRate) return;
  announced = { key, rate: musicRate };
  hostEntry = entry ?? null;
  // setSong only applies in the lobby; if a straggler is still mid-song the
  // want is remembered and replayed by the update hook when the cycle ends.
  wantSong = { ref, key, rate: musicRate };
  r.setSong(ref, musicRate);
}

/** Replay a pending host announce once the room is back in its lobby. */
function applyWantSong(): void {
  const r = currentRoom();
  if (!r || !r.isHost || !(r instanceof RoomHost) || !wantSong) return;
  if (r.phase !== 'lobby') return;
  const currentKey = r.song?.charts.map((c) => c.chartHash).join(',');
  if (currentKey === wantSong.key && r.musicRate === wantSong.rate) return; // applied
  r.setSong(wantSong.ref, wantSong.rate);
}

/** Host backed out of PLAYER OPTIONS — no song on the table. */
export function clearAnnouncedSong(): void {
  const r = currentRoom();
  if (!r || !(r instanceof RoomHost)) return;
  announced = null;
  hostEntry = null;
  wantSong = null;
  r.clearSong();
}

/** Host side of the song transfer: original simfile + audio (+ background
 *  art when it fits the cap), streamed to the asking guest's channel. */
async function serveSongTransfer(host: RoomHost, guestId: number): Promise<void> {
  const entry = hostEntry;
  const conn = connections.get(guestId);
  const simFile = entry ? findSimfile(entry.files) : undefined;
  const audioFile = entry ? findAudioFile(entry.files, entry.song) : undefined;
  if (!entry || !simFile || !audioFile || !conn) {
    host.sendFileErr(guestId, 'HOST CANNOT SHARE THIS SONG');
    return;
  }
  try {
    const [simfile, audio] = await Promise.all([simFile.text(), audioFile.arrayBuffer()]);
    if (simfile.length > MAX_SIMFILE_CHARS || audio.byteLength > MAX_AUDIO_BYTES) {
      host.sendFileErr(guestId, 'SONG TOO LARGE TO SHARE');
      return;
    }
    // Background art rides along when it fits; oversized is omitted, not fatal.
    const bgFile = findBackgroundFile(entry);
    const bg = bgFile && bgFile.size <= MAX_BG_BYTES ? await bgFile.arrayBuffer() : null;
    const files: TransferBinary[] = [
      { name: audioFile.name, kind: 'audio', bytes: audio.byteLength },
    ];
    if (bg && bgFile) files.push({ name: bgFile.name, kind: 'bg', bytes: bg.byteLength });
    host.sendFileMeta(guestId, { simfileName: simFile.name, simfile, files });
    await sendBinaryChunks(conn.channel, audio);
    if (bg) await sendBinaryChunks(conn.channel, bg);
    host.sendFileDone(guestId);
  } catch {
    host.sendFileErr(guestId, 'TRANSFER FAILED ON THE HOST');
  }
}

// ---- joining -----------------------------------------------------------------------

/** Join a room by arrow code. Resolves true once in the room. */
export async function joinRoomByCode(code: string): Promise<boolean> {
  if (currentRoom()) return false;
  setState({ k: 'busy', message: 'CONNECTING…' });
  const conn = await joinRoomChannel(code, getIdentity().name);
  if (!conn) {
    setState({ k: 'error', message: 'COULD NOT CONNECT (ROOM GONE, OR NAT BLOCKED)' });
    return false;
  }
  const guest = new RoomGuest(
    { send: (d) => conn.channel.send(d), close: () => conn.close() },
    { name: getIdentity().name },
  );
  guestConnection = conn;
  room = guest;
  conn.channel.binaryType = 'arraybuffer';
  conn.channel.addEventListener('message', (e) => {
    if (typeof e.data === 'string') guest.handleMessage(e.data);
    else if (e.data instanceof ArrayBuffer) sink?.push(e.data);
  });
  conn.channel.addEventListener('close', () => guest.handleClose());
  guest.onUpdate = notify;
  guest.onSong = (song) => void followSong(guest, song);
  guest.onClosed = (reason) => {
    const message =
      reason === 'host-left'
        ? 'THE HOST CLOSED THE ROOM'
        : reason === 'full'
          ? 'ROOM IS FULL'
          : reason === 'version'
            ? 'VERSION MISMATCH — RELOAD FOR THE LATEST BUILD'
            : 'CONNECTION LOST';
    leaveRoom();
    setState({ k: 'error', message });
  };
  setState({ k: 'in-room', room: guest, follow });
  return true;
}

// ---- guest song follow ----------------------------------------------------------------

function setFollow(next: FollowState): void {
  follow = next;
  notify();
}

/** The host picked (or cleared) a song — resolve our copy and stage a play
 *  request for the App to route. Local by any chart hash first; otherwise the
 *  files come P2P from the host and land through the normal library path. */
async function followSong(guest: RoomGuest, songRef: VersusSongRef | null): Promise<void> {
  const token = ++followToken;
  if (!songRef) {
    setFollow({ k: 'none' });
    return;
  }
  setFollow({ k: 'resolving', message: 'FINDING YOUR COPY…' });
  let local = findSongByAnyHash(libraryState().entries, songRef.charts);
  if (!local) {
    const got = await requestSongTransfer(guest, (received, total) =>
      setFollow({
        k: 'resolving',
        message: `GETTING THE SONG FROM THE HOST… ${total > 0 ? Math.round((received / total) * 100) : 0}%`,
      }),
    );
    if (token !== followToken) return; // a newer broadcast superseded us
    if (!got) {
      setFollow({ k: 'error', message: 'SONG TRANSFER FAILED (HOST CANNOT SHARE IT)' });
      return;
    }
    const dir = `Room Received/${songRef.title.replace(/[/\\]/g, '-')}`;
    const at = (name: string, content: BlobPart) => {
      const f = new File([content], name);
      Object.defineProperty(f, 'webkitRelativePath', { value: `${dir}/${name}` });
      return f;
    };
    const received = [at(got.simfileName, got.simfile)];
    for (let i = 0; i < got.files.length; i++) received.push(at(got.files[i].name, got.bytes(i)));
    await addFiles(received);
    if (token !== followToken) return;
    local = findSongByAnyHash(libraryState().entries, songRef.charts);
    if (!local) {
      setFollow({ k: 'error', message: 'TRANSFERRED SONG DID NOT MATCH (DIFFERENT REVISION?)' });
      return;
    }
  }
  setFollow({ k: 'resolving', message: 'LOADING SONG…' });
  try {
    const entry = await ensureLoaded(local.entry);
    const audio = await readSongAudio(entry);
    const bg = await resolveBackground(entry);
    if (token !== followToken) return;
    setFollow({
      k: 'ready',
      req: { song: entry.song, chart: local.chart, encodedAudio: audio, backgroundFile: bg, entry },
    });
  } catch {
    if (token === followToken) setFollow({ k: 'error', message: 'SONG FAILED TO LOAD' });
  }
}

/** Ask the connected host for the song files and reassemble them.
 *  Resolves null on refusal/timeout/disconnect. */
interface ReceivedSong {
  simfileName: string;
  simfile: string;
  files: TransferBinary[];
  bytes: (i: number) => Uint8Array<ArrayBuffer>;
}

function requestSongTransfer(
  guest: RoomGuest,
  onProgress: (received: number, total: number) => void,
): Promise<ReceivedSong | null> {
  return new Promise((resolve) => {
    let meta: { simfileName: string; simfile: string; files: TransferBinary[] } | null = null;
    let settled = false;
    const finish = (result: ReceivedSong | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      guest.onFileMeta = undefined;
      guest.onFileDone = undefined;
      guest.onFileErr = undefined;
      sink = null;
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 180_000);
    guest.onFileMeta = (m) => {
      meta = m;
      sink = new TransferSink(m.files, onProgress);
    };
    // Ordered channel: 'done' arrives after every chunk, so the sink is
    // complete (or the transfer went wrong and null is the honest answer).
    guest.onFileDone = () => {
      const s = sink;
      if (meta && s?.complete) {
        finish({ ...meta, bytes: (i) => s.bytes(i) });
      } else {
        finish(null);
      }
    };
    guest.onFileErr = () => finish(null);
    guest.requestFile();
  });
}

/** The App consumed the staged follow request (guest is on PLAYER OPTIONS). */
export function consumeFollow(): PlayRequest | null {
  if (follow.k !== 'ready') return null;
  const req = follow.req;
  setFollow({ k: 'none' });
  return req;
}

export function dismissFollowError(): void {
  if (follow.k === 'error') setFollow({ k: 'none' });
}

// ---- play handoff --------------------------------------------------------------------

/** Everyone readied — describe the race for Play. The rivals' picks resolve
 *  against the LOCAL song copy (null when that revision isn't local). */
export function takeRoomForPlay(song: Song): RoomPlayInfo | null {
  const r = currentRoom();
  if (!r || !r.song) return null;
  const opponents = r.players
    .filter((p) => p.id !== r.selfId && !p.left && p.ready && p.pick)
    .map((p) => ({
      id: p.id,
      name: p.name,
      pick: p.pick!,
      chart: chartForPick(song, p.pick!),
    }));
  if (opponents.length === 0) return null;
  return { room: r, musicRate: r.musicRate, isHost: r.isHost, opponents };
}
