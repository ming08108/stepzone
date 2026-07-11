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

import type { ChartRef, PlayResult } from './protocol';
import { parseChartRef, parsePlayResult } from './protocol';

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

export type PeerMsg =
  | { t: 'hello'; name: string }
  | { t: 'ready' }
  | { t: 'load' } // host -> joiner: both ready, prepare your session
  | { t: 'loaded' }
  | { t: 'ping'; at: number } // host RTT probe (echoed timestamps, host clock)
  | { t: 'pong'; at: number }
  | { t: 'go'; delayMs: number } // begin after delayMs (half-RTT compensated)
  | { t: 'snap'; snap: VersusSnap }
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
    case 'ready':
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
  chart: ChartRef;
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
      chart: ChartRef;
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
    const chart = parseChartRef(v.chart);
    if (!chart || !name(v.hostName) || !sdp(v.offer)) return null;
    if (!num(v.musicRate) || v.musicRate < 0.5 || v.musicRate > 3) return null;
    return { t: 'create', hostName: v.hostName, chart, musicRate: v.musicRate, offer: v.offer };
  }
  if (v.t === 'answer') {
    if (!isRoomCode(v.code) || !name(v.joinerName) || !sdp(v.answer)) return null;
    return { t: 'answer', code: v.code, joinerName: v.joinerName, answer: v.answer };
  }
  return null;
}
