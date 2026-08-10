/**
 * Rooms over WebRTC — the shared vocabulary (docs/VERSUS.md).
 *
 * Topology: a STAR. The host is the hub: every guest holds one RTCDataChannel
 * to the host and nothing else; the host relays per-player streams and
 * broadcasts the shared room state (roster, song, phase). The only server
 * involvement is HTTP signaling (net/signalApi.ts) — room code + per-joiner
 * SDP offer/answer through /api/versus; after a channel opens the server is
 * out of the loop for that pair.
 *
 * A room is PERSISTENT: it outlives songs. The cycle is
 *   lobby (host picks a song) -> everyone readies a difficulty ->
 *   loading -> synchronized go -> playing -> all finished -> lobby again
 * and repeats until players leave. Judging never crosses the wire — each
 * player judges their own input on their own audio clock and shares derived
 * stats (snaps) and judged-note display events (notes), the
 * authoritative-local model from docs/ONLINE-MULTIPLAYER.md.
 *
 * Pure TypeScript: no DOM, no WebRTC objects — net/roomPeer.ts runs this over
 * fake channels in Node tests. Every parser here treats peer input as hostile
 * (malformed -> null, never throw).
 */

import type { PlayResult } from './protocol';
import { parsePlayResult } from './protocol';

/** Wire protocol revision — both ends must match (host rejects mismatches).
 *  v3: `load` carries the racer id list so a guest whose ready raced a host
 *  force-start self-excludes instead of wedging on a race it isn't part of.
 *  v4: host handoff — becomeHost / hostReady / migrate reconnect the room
 *  around a new host.
 *  v5: lobby social — the host broadcasts what it's browsing; guests suggest
 *  songs (relayed to everyone). */
export const ROOM_PROTOCOL = 5;

/** Cap for a suggested/browsed song's display strings on the wire. */
export const MAX_SONG_LABEL = 120;

/** Hub-and-spoke fan-out is per-guest work for the host — keep parties small. */
export const MAX_PLAYERS = 8;

// ---- room codes ---------------------------------------------------------------

/** Room codes are 6 pad arrows — enterable on a dance pad with no keyboard. */
export const CODE_ARROWS = ['L', 'D', 'U', 'R'] as const;
export const CODE_LENGTH = 6;

export function randomRoomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ARROWS[b % 4]).join('');
}

export function isRoomCode(v: unknown): v is string {
  return typeof v === 'string' && new RegExp(`^[LDUR]{${CODE_LENGTH}}$`).test(v);
}

// ---- song / chart identity --------------------------------------------------------

/** One chart's identity + display meta inside a song descriptor. */
export interface VersusChartMeta {
  /** chartContentHash — binds the pick to exact note/timing content. */
  chartHash: string;
  stepsType: string;
  /** Difficulty enum value (song/difficulty). */
  difficulty: number;
  meter: number;
}

/**
 * A song is identified by EVERY chart hash the host's copy has, so a guest
 * resolves their local copy by ANY hash match (never by title — titles
 * collide) and each player then picks their own difficulty (arcade style).
 */
export interface VersusSongRef {
  title: string;
  artist: string;
  charts: VersusChartMeta[];
}

export const MAX_ROOM_CHARTS = 32;

const str = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

export function parseVersusChartMeta(v: unknown): VersusChartMeta | null {
  if (!isObj(v)) return null;
  if (!str(v.chartHash, 64) || !str(v.stepsType, 64)) return null;
  if (!num(v.difficulty) || !Number.isInteger(v.difficulty)) return null;
  if (!num(v.meter) || !Number.isInteger(v.meter) || v.meter < 0 || v.meter > 100) return null;
  return {
    chartHash: v.chartHash,
    stepsType: v.stepsType,
    difficulty: v.difficulty,
    meter: v.meter,
  };
}

export function parseVersusSongRef(v: unknown): VersusSongRef | null {
  if (!isObj(v)) return null;
  if (!str(v.title, 256) || typeof v.artist !== 'string' || v.artist.length > 256) return null;
  if (!Array.isArray(v.charts) || v.charts.length === 0 || v.charts.length > MAX_ROOM_CHARTS)
    return null;
  const charts: VersusChartMeta[] = [];
  for (const c of v.charts) {
    const meta = parseVersusChartMeta(c);
    if (!meta) return null;
    charts.push(meta);
  }
  return { title: v.title, artist: v.artist, charts };
}

// ---- live play streams ------------------------------------------------------

/** Live scoreboard sample, streamed at a few Hz while playing. */
export interface VersusSnap {
  /** Monotonic per-sender sequence for ordering/dedupe. */
  seq: number;
  /** Sender's song-seconds when sampled (context only — clocks are local). */
  atSong: number;
  percent: number;
  combo: number;
  life: number;
  failed: boolean;
}

/** One judged note (index into the sender's time-sorted note list + result) —
 *  drives rival-playfield display; judging itself never crosses the wire. */
export interface VersusNote {
  i: number;
  tns: number;
}

export const MAX_NOTE_INDEX = 200_000;
/** A per-frame snap counter — a billion covers weeks of continuous play, so any
 *  value past it is a hostile jump meant to out-rank (and freeze out) every real
 *  snap under the receiver's monotonic `>` guard. 1e308 is an integer, so a
 *  bare integer check is not enough; this ceiling is what actually stops it. */
export const MAX_SNAP_SEQ = 1_000_000_000;

export function parseSnap(v: unknown): VersusSnap | null {
  if (!isObj(v)) return null;
  // seq is a bounded integer counter — reject fractional/negative AND absurdly
  // large values, either of which would break the monotonic receiver.
  if (!seqNum(v.seq) || v.seq > MAX_SNAP_SEQ) return null;
  if (!num(v.atSong) || !num(v.percent) || !num(v.combo) || !num(v.life)) return null;
  if (typeof v.failed !== 'boolean') return null;
  return {
    seq: v.seq,
    atSong: v.atSong,
    percent: Math.max(0, Math.min(1, v.percent)),
    combo: Math.max(0, Math.floor(v.combo)),
    life: Math.max(0, Math.min(1, v.life)),
    failed: v.failed,
  };
}

function parseNotes(v: unknown): VersusNote[] | null {
  if (!Array.isArray(v) || v.length > 512) return null;
  const notes: VersusNote[] = [];
  for (const n of v) {
    if (!isObj(n)) return null;
    if (!num(n.i) || !Number.isInteger(n.i) || n.i < 0 || n.i > MAX_NOTE_INDEX) return null;
    if (!num(n.tns) || !Number.isInteger(n.tns) || n.tns < 0 || n.tns > 16) return null;
    notes.push({ i: n.i, tns: n.tns });
  }
  return notes;
}

// ---- room state (host-broadcast) ---------------------------------------------

/** lobby: picking song/difficulty · loading: sessions preparing · playing. */
export type RoomPhase = 'lobby' | 'loading' | 'playing';

const ROOM_PHASES: readonly RoomPhase[] = ['lobby', 'loading', 'playing'];

/** One roster entry as the host broadcasts it (id 0 is always the host). */
export interface RosterPlayer {
  id: number;
  name: string;
  pick: VersusChartMeta | null;
  ready: boolean;
  done: boolean;
  /** Disconnected/left; kept on the roster mid-song so DNF can render. */
  left: boolean;
}

function parseRosterPlayer(v: unknown): RosterPlayer | null {
  if (!isObj(v)) return null;
  if (!num(v.id) || !Number.isInteger(v.id) || v.id < 0 || v.id > 1_000_000) return null;
  if (!str(v.name, 24)) return null;
  const pick = v.pick == null ? null : parseVersusChartMeta(v.pick);
  if (v.pick != null && !pick) return null;
  if (typeof v.ready !== 'boolean' || typeof v.done !== 'boolean' || typeof v.left !== 'boolean')
    return null;
  return { id: v.id, name: v.name, pick, ready: v.ready, done: v.done, left: v.left };
}

// ---- song transfer -------------------------------------------------------------

/** Caps for the transfer payload — anything past these is not shared. */
export const MAX_SIMFILE_CHARS = 2_000_000;
export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
/** Background art rides along when it fits: images always dwarf this, videos
 *  only sometimes — an oversized background is simply omitted, never fatal. */
export const MAX_BG_BYTES = 32 * 1024 * 1024;

/** One binary file announced by fileMeta; bytes stream in list order. */
export interface TransferBinary {
  name: string;
  kind: 'audio' | 'bg';
  bytes: number;
}

/** Ceiling on a whole transfer, so a hostile host can't force ~256 MB of guest
 *  allocation with four max-size entries (the real flow is audio + optional bg). */
export const MAX_TRANSFER_BYTES = MAX_AUDIO_BYTES + MAX_BG_BYTES;

const fileName = (n: unknown): n is string =>
  typeof n === 'string' &&
  n.length > 0 &&
  n.length <= 128 &&
  !n.includes('/') &&
  !n.includes('\\') &&
  !n.includes('..');

function parseTransferBinaries(v: unknown): TransferBinary[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 4) return null;
  const out: TransferBinary[] = [];
  let total = 0;
  for (const f of v) {
    if (!isObj(f)) return null;
    if (!fileName(f.name)) return null;
    if (f.kind !== 'audio' && f.kind !== 'bg') return null;
    const cap = f.kind === 'audio' ? MAX_AUDIO_BYTES : MAX_BG_BYTES;
    // Every real transferred file has content; 0 bytes is only ever hostile.
    if (!num(f.bytes) || !Number.isInteger(f.bytes) || f.bytes <= 0 || f.bytes > cap) return null;
    total += f.bytes;
    if (total > MAX_TRANSFER_BYTES) return null;
    out.push({ name: f.name, kind: f.kind, bytes: f.bytes });
  }
  return out;
}

// ---- data-channel messages ------------------------------------------------------

/**
 * Guest -> host. `seq` fields echo the host's song sequence so a stale action
 * (readying just as the host swaps songs) can't cross cycles.
 */
export type GuestMsg =
  | { t: 'hello'; v: number; name: string }
  | { t: 'pick'; seq: number; pick: VersusChartMeta } // advisory — lobby display
  | { t: 'ready'; seq: number; pick: VersusChartMeta } // PINS the pick (same frame)
  | { t: 'loaded'; seq: number }
  | { t: 'snap'; snap: VersusSnap }
  | { t: 'notes'; notes: VersusNote[] }
  | { t: 'finish'; seq: number; result: PlayResult }
  | { t: 'pong'; at: number }
  | { t: 'fileReq' }
  // Host handoff: the guest the old host promoted has opened its own room and
  // reports the arrow code, so the old host can send everyone there.
  | { t: 'hostReady'; code: string }
  // Lobby: a guest nudges the host toward a song (relayed to everyone).
  | { t: 'suggest'; title: string; artist: string }
  | { t: 'bye' };

/** Host -> guest. Roster is the single source of shared room state. */
export type HostMsg =
  | { t: 'welcome'; v: number; you: number; code: string }
  | { t: 'err'; reason: 'full' | 'version' }
  | { t: 'roster'; phase: RoomPhase; players: RosterPlayer[] }
  | { t: 'song'; seq: number; song: VersusSongRef | null; musicRate: number }
  | { t: 'load'; racers: number[] } // start your session IF you're a racer
  | { t: 'ping'; at: number } // per-guest RTT probe (host clock, echoed)
  | { t: 'go'; delayMs: number } // begin after delayMs (half-RTT compensated)
  | { t: 'psnap'; id: number; snap: VersusSnap } // relayed player streams
  | { t: 'pnotes'; id: number; notes: VersusNote[] }
  | { t: 'pfinish'; id: number; result: PlayResult }
  // Song transfer to THIS guest: simfile text inline; binaries follow as
  // chunked binary frames in `files` order (net/versusTransfer.ts).
  | { t: 'fileMeta'; simfileName: string; simfile: string; files: TransferBinary[] }
  | { t: 'fileDone' }
  | { t: 'fileErr'; message: string }
  // Host handoff: `becomeHost` tells the chosen guest to open its own room;
  // `migrate` tells everyone else to reconnect to that new room's code.
  | { t: 'becomeHost' }
  | { t: 'migrate'; code: string }
  // Lobby social: what the host is browsing (null title = stopped), and a
  // guest's suggestion relayed to the whole room.
  | { t: 'browsing'; title: string; artist: string }
  | { t: 'suggested'; name: string; title: string; artist: string }
  | { t: 'bye' };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const seqNum = (v: unknown): v is number => num(v) && Number.isInteger(v) && v >= 0;

/** Parse one guest frame (host side; guest input is untrusted). */
export function parseGuestMsg(raw: string): GuestMsg | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  switch (v.t) {
    case 'hello':
      return num(v.v) && str(v.name, 24) ? { t: 'hello', v: v.v, name: v.name } : null;
    case 'pick':
    case 'ready': {
      if (!seqNum(v.seq)) return null;
      const pick = parseVersusChartMeta(v.pick);
      return pick ? { t: v.t, seq: v.seq, pick } : null;
    }
    case 'loaded':
      return seqNum(v.seq) ? { t: 'loaded', seq: v.seq } : null;
    case 'snap': {
      const snap = parseSnap(v.snap);
      return snap ? { t: 'snap', snap } : null;
    }
    case 'notes': {
      const notes = parseNotes(v.notes);
      return notes ? { t: 'notes', notes } : null;
    }
    case 'finish': {
      if (!seqNum(v.seq)) return null;
      const result = parsePlayResult(v.result);
      return result ? { t: 'finish', seq: v.seq, result } : null;
    }
    case 'pong':
      return num(v.at) ? { t: 'pong', at: v.at } : null;
    case 'hostReady':
      return isRoomCode(v.code) ? { t: 'hostReady', code: v.code } : null;
    case 'suggest':
      return str(v.title, MAX_SONG_LABEL) && str(v.artist, MAX_SONG_LABEL)
        ? { t: 'suggest', title: v.title, artist: v.artist }
        : null;
    case 'fileReq':
    case 'bye':
      return { t: v.t };
    default:
      return null;
  }
}

/** Parse one host frame (guest side; still validated — hosts can be hostile too). */
export function parseHostMsg(raw: string): HostMsg | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  switch (v.t) {
    case 'welcome':
      return num(v.v) && seqNum(v.you) && isRoomCode(v.code)
        ? { t: 'welcome', v: v.v, you: v.you, code: v.code }
        : null;
    case 'err':
      return v.reason === 'full' || v.reason === 'version' ? { t: 'err', reason: v.reason } : null;
    case 'roster': {
      if (!ROOM_PHASES.includes(v.phase as RoomPhase)) return null;
      if (!Array.isArray(v.players) || v.players.length === 0 || v.players.length > MAX_PLAYERS)
        return null;
      const players: RosterPlayer[] = [];
      for (const p of v.players) {
        const parsed = parseRosterPlayer(p);
        if (!parsed) return null;
        players.push(parsed);
      }
      return { t: 'roster', phase: v.phase as RoomPhase, players };
    }
    case 'song': {
      if (!seqNum(v.seq)) return null;
      const song = v.song == null ? null : parseVersusSongRef(v.song);
      if (v.song != null && !song) return null;
      if (!num(v.musicRate) || v.musicRate < 0.5 || v.musicRate > 3) return null;
      return { t: 'song', seq: v.seq, song, musicRate: v.musicRate };
    }
    case 'load': {
      if (!Array.isArray(v.racers) || v.racers.length > MAX_PLAYERS) return null;
      if (!v.racers.every((id) => seqNum(id))) return null;
      return { t: 'load', racers: v.racers as number[] };
    }
    case 'fileDone':
    case 'bye':
    case 'becomeHost':
      return { t: v.t };
    case 'migrate':
      return isRoomCode(v.code) ? { t: 'migrate', code: v.code } : null;
    case 'browsing':
      return str(v.title, MAX_SONG_LABEL) && str(v.artist, MAX_SONG_LABEL)
        ? { t: 'browsing', title: v.title, artist: v.artist }
        : null;
    case 'suggested':
      return str(v.name, 24) && str(v.title, MAX_SONG_LABEL) && str(v.artist, MAX_SONG_LABEL)
        ? { t: 'suggested', name: v.name, title: v.title, artist: v.artist }
        : null;
    case 'ping':
      return num(v.at) ? { t: 'ping', at: v.at } : null;
    case 'go':
      return num(v.delayMs) && v.delayMs >= 0 && v.delayMs <= 10_000
        ? { t: 'go', delayMs: v.delayMs }
        : null;
    case 'psnap': {
      if (!seqNum(v.id)) return null;
      const snap = parseSnap(v.snap);
      return snap ? { t: 'psnap', id: v.id, snap } : null;
    }
    case 'pnotes': {
      if (!seqNum(v.id)) return null;
      const notes = parseNotes(v.notes);
      return notes ? { t: 'pnotes', id: v.id, notes } : null;
    }
    case 'pfinish': {
      if (!seqNum(v.id)) return null;
      const result = parsePlayResult(v.result);
      return result ? { t: 'pfinish', id: v.id, result } : null;
    }
    case 'fileMeta': {
      if (!fileName(v.simfileName)) return null;
      if (typeof v.simfile !== 'string' || v.simfile.length > MAX_SIMFILE_CHARS) return null;
      const files = parseTransferBinaries(v.files);
      return files
        ? { t: 'fileMeta', simfileName: v.simfileName, simfile: v.simfile, files }
        : null;
    }
    case 'fileErr':
      return typeof v.message === 'string' && v.message.length <= 200
        ? { t: 'fileErr', message: v.message }
        : null;
    default:
      return null;
  }
}

// ---- signaling payloads (HTTP /api/versus) ---------------------------------------

/**
 * Signaling v2 — joiner-initiated offers so ONE room accepts MANY joiners:
 * the room row is just "this code has a live host"; each joiner posts an
 * offer row and the host (polling) answers it. The host's poll doubles as a
 * heartbeat: a room is live while its host keeps polling, so a party can
 * last hours while abandoned rooms vanish in a minute.
 */

/** A room is joinable while the host polled within this window. */
export const ROOM_LIVE_MS = 60_000;
/** A pending join (offer waiting for its answer) expires after this. */
export const JOIN_TTL_MS = 2 * 60_000;
/** SDP blobs are a few KB; anything bigger is not a session description. */
export const MAX_SDP_LENGTH = 64 * 1024;

export interface SignalRoom {
  code: string;
  hostName: string;
  /** SHA-256 of the opaque credential returned only to the creating host. */
  hostTokenHash: string;
  createdAt: number;
  /** Last host poll (heartbeat) — liveness is measured from this. */
  lastSeen: number;
}

export interface SignalJoin {
  code: string;
  joinId: string;
  joinerName: string;
  offer: string; // complete (non-trickle) SDP from the JOINER
  answer: string | null; // host's SDP once it accepted
  createdAt: number;
}

export type SignalRequest =
  | { t: 'create'; hostName: string }
  | { t: 'join'; code: string; joinerName: string; offer: string }
  | { t: 'answer'; code: string; joinId: string; answer: string };

const playerName = (n: unknown): n is string =>
  typeof n === 'string' && n.length > 0 && n.length <= 24;
const sdp = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= MAX_SDP_LENGTH;
const joinId = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(s);

export function parseSignalRequest(v: unknown): SignalRequest | null {
  if (!isObj(v)) return null;
  if (v.t === 'create') {
    return playerName(v.hostName) ? { t: 'create', hostName: v.hostName } : null;
  }
  if (v.t === 'join') {
    if (!isRoomCode(v.code) || !playerName(v.joinerName) || !sdp(v.offer)) return null;
    return { t: 'join', code: v.code, joinerName: v.joinerName, offer: v.offer };
  }
  if (v.t === 'answer') {
    if (!isRoomCode(v.code) || !joinId(v.joinId) || !sdp(v.answer)) return null;
    return { t: 'answer', code: v.code, joinId: v.joinId, answer: v.answer };
  }
  return null;
}
