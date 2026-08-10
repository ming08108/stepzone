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
  LeaderboardResponse,
  PlayResult,
  ReplayEvent,
  SubmitScoreRequest,
  SubmitScoreResponse,
} from './protocol';
import {
  parseChartData,
  parseChartRef,
  parsePlayResult,
  parseReplay,
  PROTOCOL_VERSION,
  type ChartData,
} from './protocol';

export interface PendingPlay {
  chart: ChartRef;
  musicRate: number;
  result: PlayResult;
  /** The chart the play ran on, so the server can re-simulate the replay. */
  chartData: ChartData;
  /** Full input log of the play; the server RE-SIMULATES it to score the play
   *  and stores it on a PB. */
  replay: ReplayEvent[];
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
    // Chart data + replay are required in v4. Older queued payloads fail the
    // current protocol shape here and are dropped rather than submitted blind.
    const chartData = parseChartData(v.chartData);
    const replay = parseReplay(v.replay);
    if (!chart || !result || !chartData || !replay) continue;
    out.push({
      chart,
      musicRate: v.musicRate,
      result,
      chartData,
      replay,
    });
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
    chartData: play.chartData,
    replay: play.replay,
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
  return res.status === 429 || res.status >= 500 ? 'retry' : 'drop';
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

let operations: Promise<void> = Promise.resolve();

async function withBrowserLock<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('notefield-score-queue', work);
  }
  return work();
}

/** Serialize read-modify-write queue operations in this tab and, where the
 * Web Locks API exists, across tabs sharing the same localStorage. */
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = operations.then(
    () => withBrowserLock(work),
    () => withBrowserLock(work),
  );
  operations = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Retry queued plays, oldest first, stopping at the first retryable failure.
 * Concurrent calls serialize so each drain sees the prior drain's writes. */
export function flushQueue(): Promise<void> {
  return exclusive(drainQueue);
}

/**
 * Submit a finished play. Tries the network right away (so the caller can
 * show rank/PB feedback) and parks the play in the queue when that fails.
 */
export function submitScore(play: PendingPlay): Promise<SubmitScoreResponse | null> {
  return exclusive(async () => {
    // Older parked plays go first so the board sees them in order.
    await drainQueue();
    const queued = loadQueue();
    if (queued.length > 0) {
      saveQueue([...queued, play]);
      return null;
    }
    const outcome = await send(play);
    if (outcome === 'retry') {
      saveQueue([play]);
      return null;
    }
    return outcome === 'drop' ? null : outcome;
  });
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
