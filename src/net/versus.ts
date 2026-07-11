/**
 * Live versus over WebRTC — the shared vocabulary (docs/VERSUS.md).
 *
 * Topology: the server only does HTTP signaling (net/signalApi.ts) — room
 * code + SDP offer/answer through /api/versus. The match itself runs
 * peer-to-peer on an RTCDataChannel; every message here travels on that
 * channel, never through the server. The HOST is the coordinator: it decides
 * when both sides load and when the match starts (half-RTT-compensated 'go'),
 * per the authoritative-local model (docs/ONLINE-MULTIPLAYER.md) — each side
 * still judges only its own input and shares derived stats.
 *
 * Pure TypeScript: no DOM, no WebRTC objects — versusMatch.ts runs this over
 * fake channels in Node tests.
 */

import type { PlayResult } from './protocol';
import { parsePlayResult } from './protocol';

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

/** Display form: L/D/U/R -> ←↓↑→ */
export function codeToArrows(code: string): string {
  const glyph: Record<string, string> = { L: '←', D: '↓', U: '↑', R: '→' };
  return [...code].map((c) => glyph[c] ?? c).join(' ');
}

// ---- song / chart identity --------------------------------------------------------

/** One chart's identity + display meta inside a room's song descriptor. */
export interface VersusChartMeta {
  /** chartContentHash — binds the pick to exact note/timing content. */
  chartHash: string;
  stepsType: string;
  /** Difficulty enum value (song/difficulty). */
  difficulty: number;
  meter: number;
}

/**
 * A room identifies a SONG, not one chart: every chart hash the host's copy
 * has, so a joiner can resolve their local copy by ANY hash match and each
 * player then picks their own difficulty (arcade style).
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

// ---- data-channel messages ------------------------------------------------------

/** Live scoreboard sample, sent both ways at a few Hz while playing. */
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
 *  drives the rival-playfield display; judging itself never crosses the wire. */
export interface VersusNote {
  i: number;
  tns: number;
}

export const MAX_NOTE_INDEX = 200_000;

export type PeerMsg =
  | { t: 'hello'; name: string }
  | { t: 'pick'; pick: VersusChartMeta } // advisory — lobby display while browsing
  | { t: 'ready'; pick: VersusChartMeta } // readying PINS the pick (same frame — no race)
  | { t: 'load' } // host -> joiner: both ready, prepare your session
  | { t: 'loaded' }
  | { t: 'ping'; at: number } // host RTT probe (echoed timestamps, host clock)
  | { t: 'pong'; at: number }
  | { t: 'go'; delayMs: number } // begin after delayMs (half-RTT compensated)
  | { t: 'snap'; snap: VersusSnap }
  | { t: 'notes'; notes: VersusNote[] } // judged since the last batch (display only)
  | { t: 'finish'; result: PlayResult }
  | { t: 'bye' };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseSnap(v: unknown): VersusSnap | null {
  if (!isObj(v)) return null;
  if (!num(v.seq) || !num(v.atSong) || !num(v.percent) || !num(v.combo) || !num(v.life))
    return null;
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

/** Parse one channel frame; unknown/malformed -> null (peer input is untrusted). */
export function parsePeerMsg(raw: string): PeerMsg | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  switch (v.t) {
    case 'hello':
      return typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 24
        ? { t: 'hello', name: v.name }
        : null;
    case 'pick':
    case 'ready': {
      const pick = parseVersusChartMeta(v.pick);
      return pick ? { t: v.t, pick } : null;
    }
    case 'load':
    case 'loaded':
    case 'bye':
      return { t: v.t };
    case 'ping':
    case 'pong':
      return num(v.at) ? { t: v.t, at: v.at } : null;
    case 'go':
      return num(v.delayMs) && v.delayMs >= 0 && v.delayMs <= 10_000
        ? { t: 'go', delayMs: v.delayMs }
        : null;
    case 'snap': {
      const snap = parseSnap(v.snap);
      return snap ? { t: 'snap', snap } : null;
    }
    case 'notes': {
      if (!Array.isArray(v.notes) || v.notes.length > 512) return null;
      const notes: VersusNote[] = [];
      for (const n of v.notes) {
        if (!isObj(n)) return null;
        if (!num(n.i) || !Number.isInteger(n.i) || n.i < 0 || n.i > MAX_NOTE_INDEX) return null;
        if (!num(n.tns) || !Number.isInteger(n.tns) || n.tns < 0 || n.tns > 16) return null;
        notes.push({ i: n.i, tns: n.tns });
      }
      return { t: 'notes', notes };
    }
    case 'finish': {
      const result = parsePlayResult(v.result);
      return result ? { t: 'finish', result } : null;
    }
    default:
      return null;
  }
}

// ---- signaling payloads (HTTP /api/versus) ---------------------------------------

/** A room row while the handshake is in flight; expires quickly. */
export interface SignalRoom {
  code: string;
  hostName: string;
  song: VersusSongRef;
  musicRate: number;
  offer: string; // complete (non-trickle) SDP
  answer: string | null;
  joinerName: string | null;
  createdAt: number;
}

export const ROOM_TTL_MS = 10 * 60_000;
/** SDP blobs are a few KB; anything bigger is not a session description. */
export const MAX_SDP_LENGTH = 64 * 1024;

export type SignalRequest =
  | {
      t: 'create';
      hostName: string;
      song: VersusSongRef;
      musicRate: number;
      offer: string;
    }
  | { t: 'answer'; code: string; joinerName: string; answer: string };

export function parseSignalRequest(v: unknown): SignalRequest | null {
  if (!isObj(v)) return null;
  const name = (n: unknown): n is string => typeof n === 'string' && n.length > 0 && n.length <= 24;
  const sdp = (s: unknown): s is string =>
    typeof s === 'string' && s.length > 0 && s.length <= MAX_SDP_LENGTH;
  if (v.t === 'create') {
    const song = parseVersusSongRef(v.song);
    if (!song || !name(v.hostName) || !sdp(v.offer)) return null;
    if (!num(v.musicRate) || v.musicRate < 0.5 || v.musicRate > 3) return null;
    return { t: 'create', hostName: v.hostName, song, musicRate: v.musicRate, offer: v.offer };
  }
  if (v.t === 'answer') {
    if (!isRoomCode(v.code) || !name(v.joinerName) || !sdp(v.answer)) return null;
    return { t: 'answer', code: v.code, joinerName: v.joinerName, answer: v.answer };
  }
  return null;
}
