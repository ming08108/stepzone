/**
 * The versus session store — module-scoped owner of the P2P lifecycle
 * (HostedRoom, RTCDataChannel connection, VersusMatch), same pattern as
 * libraryStore: the session must survive screen transitions (SongSelect →
 * PLAYER OPTIONS → Play) and StrictMode double-mounts, so components only
 * subscribe and call the exported operations — nothing here is created or
 * torn down in a React effect.
 *
 * Lifecycle: hostVersus()/joinVersus() build the room + channel + match;
 * takeVersusForPlay() hands the live session to gameplay; abandonVersus()
 * tears down whatever exists (explicit user action or App's play-exit hook).
 */
import { findAudioFile, findSimfile, type LibraryEntry } from '../io/songFiles';
import { getIdentity } from '../net/identity';
import { MAX_AUDIO_BYTES, MAX_SIMFILE_CHARS, type VersusSongRef } from '../net/versus';
import { VersusMatch } from '../net/versusMatch';
import { ChunkSink, sendAudioChunks } from '../net/versusTransfer';
import {
  createRoom,
  joinRoom,
  type HostedRoom,
  type RoomInfo,
  type VersusConnection,
} from '../net/versusSignal';
import type { Song } from '../song/song';
import type { VersusInfo } from './playRequest';
import { chartForPick, pickOf } from './versusResolve';

export interface VersusSession {
  match: VersusMatch;
  connection: VersusConnection;
  isHost: boolean;
  /** Room-locked music rate (host's setting at creation time). */
  musicRate: number;
  song: VersusSongRef;
  /** The host keeps showing its room code in the lobby dock. */
  code: string | null;
}

export type VersusPhase =
  | { k: 'idle' }
  | { k: 'busy'; message: string }
  | { k: 'hosting'; code: string; song: VersusSongRef }
  | { k: 'connected'; session: VersusSession }
  | { k: 'error'; message: string };

let phase: VersusPhase = { k: 'idle' };
let hosted: HostedRoom | null = null;
let live: VersusSession | null = null;
/** True between takeVersusForPlay() and the post-play abandonVersus(). */
let handedOff = false;
/** The host's library entry (simfile + audio files) for serving transfers. */
let hostEntry: LibraryEntry | null = null;
/** Reassembles an in-flight incoming audio transfer (joiner side). */
let binarySink: ChunkSink | null = null;
const listeners = new Set<() => void>();

function setPhase(next: VersusPhase): void {
  phase = next;
  for (const cb of [...listeners]) cb();
}

export function versusState(): VersusPhase {
  return phase;
}

export function subscribeVersus(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Tear down whatever exists and return to idle. Safe to call in any state. */
export function abandonVersus(): void {
  hosted?.cancel();
  hosted = null;
  hostEntry = null;
  binarySink = null;
  if (live) {
    live.match.leave(); // sends bye + closes the channel
    live.connection.close();
    live = null;
  }
  handedOff = false;
  setPhase({ k: 'idle' });
}

function startMatch(
  connection: VersusConnection,
  isHost: boolean,
  song: VersusSongRef,
  musicRate: number,
  code: string | null,
): void {
  const match = new VersusMatch(
    {
      send: (d) => connection.channel.send(d),
      close: () => connection.close(),
    },
    { isHost, name: getIdentity().name },
  );
  // JSON frames drive the match; binary frames are audio-transfer chunks.
  connection.channel.binaryType = 'arraybuffer';
  connection.channel.addEventListener('message', (e) => {
    if (typeof e.data === 'string') match.handleMessage(e.data);
    else if (e.data instanceof ArrayBuffer) binarySink?.push(e.data);
  });
  connection.channel.addEventListener('close', () => match.handleClose());
  // The host serves song transfers from its library entry (joiner without
  // the song asks over the channel; no server ever touches the files).
  if (isHost) {
    match.onFileReq = () => void serveSongTransfer(match, connection);
  }
  match.onUpdate = () => {
    // A rival vanishing before the handoff ends the lobby; after the handoff
    // Play owns the presentation (DNF bar / standings).
    if (match.phase === 'done' && !handedOff) {
      abandonVersus();
      setPhase({ k: 'error', message: 'RIVAL LEFT' });
      return;
    }
    // Fresh snapshot object each update — useSyncExternalStore re-renders on
    // reference change, and the match mutates in place.
    if (live) setPhase({ k: 'connected', session: live });
  };
  live = { match, connection, isHost, musicRate, song, code };
  hosted = null; // the room served its purpose once the channel is up
  setPhase({ k: 'connected', session: live });
}

/** Host side of the song transfer: original simfile text + audio bytes. */
async function serveSongTransfer(match: VersusMatch, connection: VersusConnection): Promise<void> {
  const entry = hostEntry;
  const simFile = entry ? findSimfile(entry.files) : undefined;
  const audioFile = entry ? findAudioFile(entry.files, entry.song) : undefined;
  if (!entry || !simFile || !audioFile) {
    match.sendFileErr('HOST CANNOT SHARE THIS SONG');
    return;
  }
  try {
    const [simfile, audio] = await Promise.all([simFile.text(), audioFile.arrayBuffer()]);
    if (simfile.length > MAX_SIMFILE_CHARS || audio.byteLength > MAX_AUDIO_BYTES) {
      match.sendFileErr('SONG TOO LARGE TO SHARE');
      return;
    }
    match.sendFileMeta({
      simfileName: simFile.name,
      simfile,
      audioName: audioFile.name,
      audioBytes: audio.byteLength,
    });
    await sendAudioChunks(connection.channel, audio);
    match.sendFileDone();
  } catch {
    match.sendFileErr('TRANSFER FAILED ON THE HOST');
  }
}

export interface TransferredSong {
  simfileName: string;
  simfile: string;
  audioName: string;
  audio: Uint8Array<ArrayBuffer>;
}

/** Joiner side: ask the connected host for the song and reassemble it.
 *  Resolves null on refusal/timeout/disconnect. */
export function requestSongTransfer(
  onProgress: (fraction: number) => void,
): Promise<TransferredSong | null> {
  if (phase.k !== 'connected' || !live) return Promise.resolve(null);
  const match = live.match;
  return new Promise((resolve) => {
    let meta: Parameters<NonNullable<VersusMatch['onFileMeta']>>[0] | null = null;
    let settled = false;
    const finish = (result: TransferredSong | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      match.onFileMeta = undefined;
      match.onFileDone = undefined;
      match.onFileErr = undefined;
      binarySink = null;
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 120_000);
    match.onFileMeta = (m) => {
      meta = m;
      binarySink = new ChunkSink(m.audioBytes, (received) =>
        onProgress(m.audioBytes > 0 ? received / m.audioBytes : 1),
      );
    };
    // Ordered channel: 'done' arrives after every chunk, so the sink is
    // complete (or the transfer went wrong and null is the honest answer).
    match.onFileDone = () => {
      if (meta && binarySink?.complete) {
        finish({
          simfileName: meta.simfileName,
          simfile: meta.simfile,
          audioName: meta.audioName,
          audio: binarySink.bytes(),
        });
      } else {
        finish(null);
      }
    };
    match.onFileErr = () => finish(null);
    match.requestFile();
  });
}

/** Host, from PLAYER OPTIONS: advertise the whole song and wait for a rival.
 *  The entry (when known) lets the host serve the song to a rival who lacks
 *  it — original simfile + audio bytes, straight over the data channel. */
export async function hostVersus(
  song: Song,
  musicRate: number,
  entry?: LibraryEntry,
): Promise<void> {
  if (phase.k !== 'idle' && phase.k !== 'error') return;
  hostEntry = entry ?? null;
  setPhase({ k: 'busy', message: 'CREATING ROOM…' });
  const songRef: VersusSongRef = {
    title: song.displayFullTitle || 'Untitled',
    artist: song.artist,
    charts: song.charts.map((c) => pickOf(song, c)),
  };
  const room = await createRoom(getIdentity().name, songRef, musicRate);
  if (!room) {
    setPhase({ k: 'error', message: 'VERSUS UNAVAILABLE (SERVER OFFLINE?)' });
    return;
  }
  hosted = room;
  setPhase({ k: 'hosting', code: room.code, song: songRef });
  try {
    const connection = await room.waitForPeer();
    startMatch(connection, true, songRef, musicRate, room.code);
  } catch {
    // Read through the accessor — TS can't see setPhase mutations from here.
    if (versusState().k === 'hosting') {
      abandonVersus();
      setPhase({ k: 'error', message: 'CONNECTION FAILED' });
    }
  }
}

/** Joiner: connect to a fetched room (the caller resolved the song first). */
export async function joinVersus(code: string, room: RoomInfo): Promise<boolean> {
  if (phase.k === 'connected' || phase.k === 'hosting') return false;
  setPhase({ k: 'busy', message: `CONNECTING TO ${room.hostName}…` });
  const connection = await joinRoom(code, getIdentity().name, room);
  if (!connection) {
    setPhase({ k: 'error', message: 'COULD NOT CONNECT (ROOM TAKEN, OR NAT BLOCKED)' });
    return false;
  }
  startMatch(connection, false, room.song, room.musicRate, null);
  return true;
}

/** Both players readied — hand the live session to Play. The rival's pick is
 *  pinned by their ready frame; their chart resolves against the LOCAL song
 *  copy (null when the exact revision isn't local — consumers degrade). */
export function takeVersusForPlay(song: Song): VersusInfo | null {
  if (phase.k !== 'connected' || !live) return null;
  const opponentPick = live.match.opponent.pick;
  if (!opponentPick) return null;
  handedOff = true;
  return {
    match: live.match,
    connection: live.connection,
    opponentName: live.match.opponent.name ?? 'RIVAL',
    musicRate: live.musicRate,
    isHost: live.isHost,
    opponentPick,
    opponentChart: chartForPick(song, opponentPick),
  };
}
