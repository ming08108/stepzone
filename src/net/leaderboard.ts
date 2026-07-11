/**
 * Client side of the scores API: submit finished plays and fetch boards.
 *
 * Submission is fire-and-forget with an offline queue (todo-style
 * queue-and-retry from docs/ONLINE-MULTIPLAYER.md M1): a play that can't be
 * delivered (no network, no deployment, server down) is parked in
 * localStorage and retried on the next submit or app start. The queue stores
 * only the play (chart + rate + result) — identity is attached at send time,
 * so a rename applies to still-queued plays and the secret is never persisted
 * twice.
 */

import { isRecord, loadJson, saveJson } from '../app/storage';
import { getIdentity } from './identity';
import type {
  ChartRef,
  GhostFrame,
  LeaderboardResponse,
  PlayResult,
  ReplayEvent,
  SubmitInput,
  SubmitScoreRequest,
  SubmitScoreResponse,
} from './protocol';
import {
  parseChartRef,
  parseGhost,
  parsePlayResult,
  parseReplay,
  parseSubmitInput,
  PROTOCOL_VERSION,
} from './protocol';

export interface PendingPlay {
  chart: ChartRef;
  musicRate: number;
  result: PlayResult;
  /** Device the play ran on — a pad (keyboard plays are never queued). */
  input: SubmitInput;
  /** Full input log of the play; the server checks + stores it on a PB. */
  replay: ReplayEvent[];
  /** Scoreboard timeline for race-the-ghost; kept server-side on a PB. */
  ghost?: GhostFrame[];
}

const QUEUE_KEY = 'notefield.net.submitQueue.v1';
const MAX_QUEUED = 50;
const API_URL = '/api/scores';

function loadQueue(): PendingPlay[] {
  const parsed = loadJson<unknown>(QUEUE_KEY);
  if (!Array.isArray(parsed)) return [];
  const out: PendingPlay[] = [];
  for (const v of parsed) {
    if (!isRecord(v) || typeof v.musicRate !== 'number') continue;
    const chart = parseChartRef(v.chart);
    const result = parsePlayResult(v.result);
    // input + replay are required in v2 — a queued v1 play (no input/replay)
    // fails here and is dropped rather than submitted without its evidence.
    const input = parseSubmitInput(v.input);
    const replay = parseReplay(v.replay);
    if (!chart || !result || !input || !replay) continue;
    // A corrupt parked ghost drops the ghost, not the play.
    const ghost = v.ghost !== undefined ? parseGhost(v.ghost) : null;
    out.push({ chart, musicRate: v.musicRate, result, input, replay, ...(ghost ? { ghost } : {}) });
  }
  return out;
}

function saveQueue(queue: PendingPlay[]): void {
  saveJson(QUEUE_KEY, queue.slice(-MAX_QUEUED)); // keep the newest plays
}

function toRequest(play: PendingPlay): SubmitScoreRequest {
  const id = getIdentity();
  return {
    protocol: PROTOCOL_VERSION,
    playerId: id.playerId,
    secret: id.secret,
    playerName: id.name,
    chart: play.chart,
    musicRate: play.musicRate,
    result: {
      ...play.result,
      percent: Math.max(0, Math.min(1, play.result.percent)),
    },
    input: play.input,
    replay: play.replay,
    ...(play.ghost && play.ghost.length > 0 ? { ghost: play.ghost } : {}),
  };
}

/**
 * Deliver one play. Returns the server's response, or null if it was rejected
 * (dropped) or undeliverable (queued for retry). 4xx means the server will
 * never accept this play — drop it; network errors and 5xx mean try later.
 */
async function send(play: PendingPlay): Promise<SubmitScoreResponse | 'drop' | 'retry'> {
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toRequest(play)),
    });
  } catch {
    return 'retry';
  }
  if (res.ok) {
    try {
      const body = (await res.json()) as SubmitScoreResponse;
      return body.ok ? body : 'drop';
    } catch {
      return 'drop';
    }
  }
  return res.status >= 500 ? 'retry' : 'drop';
}

async function drainQueue(): Promise<void> {
  let queue = loadQueue();
  while (queue.length > 0) {
    const outcome = await send(queue[0]);
    if (outcome === 'retry') break;
    queue = queue.slice(1);
    saveQueue(queue);
  }
}

let flushing: Promise<void> | null = null;

/** Retry queued plays, oldest first, stopping at the first retryable failure.
 *  Concurrent calls share one drain; the guard resets in a .finally() so a
 *  synchronously-completing drain can't null it before it is even assigned. */
export function flushQueue(): Promise<void> {
  flushing ??= drainQueue().finally(() => {
    flushing = null;
  });
  return flushing;
}

/**
 * Submit a finished play. Tries the network right away (so the caller can
 * show rank/PB feedback) and parks the play in the queue when that fails.
 */
export async function submitScore(play: PendingPlay): Promise<SubmitScoreResponse | null> {
  // Older parked plays go first so the board sees them in order.
  await flushQueue();
  const queued = loadQueue();
  if (queued.length > 0) {
    // Still blocked — park this one behind the rest.
    saveQueue([...queued, play]);
    return null;
  }
  const outcome = await send(play);
  if (outcome === 'retry') {
    saveQueue([play]);
    return null;
  }
  return outcome === 'drop' ? null : outcome;
}

/** The stored ghost of one player's best on a board; null when absent/offline. */
export async function fetchGhost(
  chartHash: string,
  musicRate: number,
  playerId: string,
): Promise<GhostFrame[] | null> {
  try {
    const url =
      `${API_URL}?chartHash=${encodeURIComponent(chartHash)}` +
      `&rate=${musicRate}&ghostOf=${encodeURIComponent(playerId)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { ghost?: unknown };
    return parseGhost(body.ghost);
  } catch {
    return null;
  }
}

/** The stored replay of one player's best on a board; null when absent/offline. */
export async function fetchReplay(
  chartHash: string,
  musicRate: number,
  playerId: string,
): Promise<ReplayEvent[] | null> {
  try {
    const url =
      `${API_URL}?chartHash=${encodeURIComponent(chartHash)}` +
      `&rate=${musicRate}&replayOf=${encodeURIComponent(playerId)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { replay?: unknown };
    return parseReplay(body.replay);
  } catch {
    return null;
  }
}

/** Top rows for one board; null when offline/undeployed (callers hide the panel). */
export async function fetchLeaderboard(
  chartHash: string,
  musicRate: number,
  limit = 20,
): Promise<LeaderboardResponse | null> {
  try {
    const url = `${API_URL}?chartHash=${encodeURIComponent(chartHash)}&rate=${musicRate}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as LeaderboardResponse;
    return Array.isArray(body.rows) ? body : null;
  } catch {
    return null;
  }
}
