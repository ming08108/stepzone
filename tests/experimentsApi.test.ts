/**
 * Experiments push/list API (handlers + memory store) exercised as Web
 * Request/Response, the way Vercel runs it. Covers: token auth, payload
 * validation + size cap, per-id rate limit, and the age->status mapping the
 * list endpoint computes. `now` is injected so status is deterministic.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createListHandler,
  createPushHandler,
  type ListHandler,
  type PushHandler,
} from '../src/net/experimentsApi';
import { MemoryExperimentsStore } from '../src/net/experimentsStore';

const PUSH_URL = 'http://test/api/experiments-push';
const LIST_URL = 'http://test/api/experiments';
const TOKEN = 'test-token-abc';

let store: MemoryExperimentsStore;
let push: PushHandler;
let list: ListHandler;
let now: number;

beforeEach(() => {
  now = 1_000_000_000;
  store = new MemoryExperimentsStore();
  push = createPushHandler(store, TOKEN, () => now);
  list = createListHandler(store, () => now);
});

const doPush = (body: unknown, token: string | null = TOKEN) =>
  push.POST(
    new Request(PUSH_URL, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const doList = () => list.GET(new Request(LIST_URL));

const sample = (over: Record<string, unknown> = {}) => ({
  id: 'vast:123',
  name: 'v4.0 strict',
  metrics: { natural: 0.42, timesteps: 1_000_000, step: 500 },
  history_natural: [0.1, 0.2, 0.42],
  ws_public: 'wss://relay.example/ws',
  box: { gpu: 'RTX 5080', dph: 0.35 },
  ...over,
});

describe('push auth', () => {
  it('rejects a missing token with 401', async () => {
    const res = await doPush(sample(), null);
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token with 401', async () => {
    const res = await doPush(sample(), 'nope');
    expect(res.status).toBe(401);
  });

  it('accepts the correct token', async () => {
    const res = await doPush(sample());
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
  });
});

describe('push validation', () => {
  it('rejects a >32KB body with 413', async () => {
    const big = JSON.stringify(sample({ name: 'x'.repeat(40 * 1024) }));
    const res = await doPush(big);
    expect(res.status).toBe(413);
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await doPush('{not json');
    expect(res.status).toBe(400);
  });

  it('rejects a missing id with 400', async () => {
    const res = await doPush(sample({ id: undefined }));
    expect(res.status).toBe(400);
  });

  it('rate-limits past 60 pushes/min per id with 429', async () => {
    for (let i = 0; i < 60; i++) {
      const res = await doPush(sample());
      expect(res.status).toBe(200);
    }
    const res = await doPush(sample());
    expect(res.status).toBe(429);
  });
});

describe('list', () => {
  it('round-trips a pushed row and computes running status', async () => {
    await doPush(sample());
    const res = await doList();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      generated_at: string;
      experiments: Array<Record<string, unknown>>;
    };
    expect(body.experiments).toHaveLength(1);
    const e = body.experiments[0];
    expect(e.id).toBe('vast:123');
    expect(e.name).toBe('v4.0 strict');
    expect(e.status).toBe('running');
    expect(e.step).toBe(500);
    expect(e.box).toBe('RTX 5080');
    expect(e.cost_per_hr).toBe(0.35);
    expect(e.ws_public).toBe('wss://relay.example/ws');
    expect(e.has_stream).toBe(true);
    expect(e.history).toEqual([0.1, 0.2, 0.42]);
  });

  it('ages rows: stale <30m, dead older, dropped past 24h', async () => {
    // Seed rows at explicit ages (upsert takes the timestamp directly).
    const t0 = now;
    await store.upsert('running', 'r', emptyPayload(), t0);
    await store.upsert('stale', 's', emptyPayload(), t0 - 10 * 60 * 1000);
    await store.upsert('dead', 'd', emptyPayload(), t0 - 60 * 60 * 1000);
    await store.upsert('gone', 'g', emptyPayload(), t0 - 25 * 60 * 60 * 1000);
    const res = await doList();
    const body = (await res.json()) as { experiments: Array<Record<string, unknown>> };
    const byId = Object.fromEntries(body.experiments.map((e) => [e.id, e.status]));
    expect(byId).toEqual({ running: 'running', stale: 'stale', dead: 'dead' });
    expect(byId.gone).toBeUndefined(); // older than 24h -> not returned
  });
});

function emptyPayload() {
  return { metrics: {}, history_natural: [], ws_public: null, box: { gpu: 'GPU', dph: 0 } };
}
