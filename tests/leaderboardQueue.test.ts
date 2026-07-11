/**
 * Client submit queue (net/leaderboard): deliver-now when the API is
 * reachable, park-and-retry when it is not, drop what the server will never
 * accept. fetch and localStorage are stubbed — no network, no browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchLeaderboard,
  flushQueue,
  submitScore,
  type PendingPlay,
} from '../src/net/leaderboard';
import { validSubmit } from './netProtocol.test';

const QUEUE_KEY = 'notefield.net.submitQueue.v1';

let store: Map<string, string>;

beforeEach(() => {
  store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  vi.unstubAllGlobals();
});

function queued(): unknown[] {
  const raw = store.get(QUEUE_KEY);
  return raw ? (JSON.parse(raw) as unknown[]) : [];
}

function play(percent = 0.9): PendingPlay {
  const { chart, musicRate, result, input, chartData, replay } = validSubmit();
  return { chart, musicRate, result: { ...result, percent }, input, chartData, replay };
}

const okBody = { ok: true, rank: 1, isPersonalBest: true };
const respond = (status: number, body: unknown) =>
  vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
const offline = () =>
  vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.reject(new TypeError('network down')),
  );

describe('submitScore', () => {
  it('delivers immediately when the API is reachable', async () => {
    const fetchMock = respond(200, okBody);
    vi.stubGlobal('fetch', fetchMock);
    expect(await submitScore(play())).toEqual(okBody);
    expect(queued()).toHaveLength(0);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.protocol).toBe(3);
    expect(typeof body.playerId).toBe('string');
    expect(body.result.percent).toBe(0.9);
    expect(body.input.device).toBe('pad');
    expect(Array.isArray(body.replay)).toBe(true);
    // v3 ships the chart so the server can re-simulate the replay.
    expect(typeof body.chartData.noteData).toBe('string');
    expect(Array.isArray(body.chartData.timing.bpms)).toBe(true);
  });

  it('parks the play when offline and flushQueue delivers it later', async () => {
    vi.stubGlobal('fetch', offline());
    expect(await submitScore(play())).toBeNull();
    expect(queued()).toHaveLength(1);

    const fetchMock = respond(200, okBody);
    vi.stubGlobal('fetch', fetchMock);
    await flushQueue();
    expect(queued()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops plays the server permanently rejects (4xx)', async () => {
    vi.stubGlobal('fetch', respond(400, { ok: false, code: 'bad_request', message: 'nope' }));
    expect(await submitScore(play())).toBeNull();
    expect(queued()).toHaveLength(0);
  });

  it('retries plays after transient server errors (5xx)', async () => {
    vi.stubGlobal('fetch', respond(500, { ok: false, code: 'oops', message: 'down' }));
    expect(await submitScore(play())).toBeNull();
    expect(queued()).toHaveLength(1);
  });

  it('drops an older queued play with no chartData (pre-v3 evidence)', async () => {
    // A play parked before v3 carries no chartData; the server would re-simulate
    // against nothing, so loadQueue must drop it rather than submit it blind.
    const stale = { ...play() } as Record<string, unknown>;
    delete stale.chartData;
    const fresh = play(0.42);
    store.set(QUEUE_KEY, JSON.stringify([stale, fresh]));

    const fetchMock = respond(200, okBody);
    vi.stubGlobal('fetch', fetchMock);
    await flushQueue();

    // Only the well-formed play was delivered; the stale one never went out.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.result.percent).toBe(0.42);
    expect(queued()).toHaveLength(0);
  });

  it('queues behind older parked plays and caps the queue at the newest 50', async () => {
    vi.stubGlobal('fetch', offline());
    for (let i = 0; i < 55; i++) await submitScore(play(i / 100));
    const q = queued() as { result: { percent: number } }[];
    expect(q).toHaveLength(50);
    // The oldest plays fell off the front; the newest survived.
    expect(q[q.length - 1].result.percent).toBeCloseTo(0.54);
  });
});

describe('fetchLeaderboard', () => {
  it('returns the board and encodes the query', async () => {
    const body = { rows: [], total: 0 };
    const fetchMock = respond(200, body);
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchLeaderboard('ha#sh', 1.5, 10)).toEqual(body);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/scores?chartHash=ha%23sh&rate=1.5&limit=10');
  });

  it('returns null on HTTP errors and network failures', async () => {
    vi.stubGlobal('fetch', respond(500, {}));
    expect(await fetchLeaderboard('x', 1)).toBeNull();
    vi.stubGlobal('fetch', offline());
    expect(await fetchLeaderboard('x', 1)).toBeNull();
  });
});
