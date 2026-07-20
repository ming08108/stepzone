/**
 * Experiments push/list API (handlers + memory store) exercised as Web
 * Request/Response, the way Vercel runs it. Covers: token auth, payload
 * validation + size cap, per-id rate limit, and the age->status mapping the
 * list endpoint computes. `now` is injected so status is deterministic.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createHistoryHandler,
  createListHandler,
  createPushHandler,
  type HistoryHandler,
  type ListHandler,
  type PushHandler,
} from '../src/net/experimentsApi';
import { MemoryExperimentsStore } from '../src/net/experimentsStore';

const PUSH_URL = 'http://test/api/experiments-push';
const LIST_URL = 'http://test/api/experiments';
const HISTORY_URL = 'http://test/api/experiments-history';
const TOKEN = 'test-token-abc';

let store: MemoryExperimentsStore;
let push: PushHandler;
let list: ListHandler;
let history: HistoryHandler;
let now: number;

beforeEach(() => {
  now = 1_000_000_000;
  store = new MemoryExperimentsStore();
  push = createPushHandler(store, TOKEN, () => now);
  list = createListHandler(store, () => now);
  history = createHistoryHandler(store);
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
const doHistory = (qs: string) => history.GET(new Request(`${HISTORY_URL}?${qs}`));

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
    await store.upsert('running', 'r', emptyPayload(), null, t0);
    await store.upsert('stale', 's', emptyPayload(), null, t0 - 10 * 60 * 1000);
    await store.upsert('dead', 'd', emptyPayload(), null, t0 - 60 * 60 * 1000);
    await store.upsert('gone', 'g', emptyPayload(), null, t0 - 25 * 60 * 60 * 1000);
    const res = await doList();
    const body = (await res.json()) as { experiments: Array<Record<string, unknown>> };
    const byId = Object.fromEntries(body.experiments.map((e) => [e.id, e.status]));
    expect(byId).toEqual({ running: 'running', stale: 'stale', dead: 'dead' });
    expect(byId.gone).toBeUndefined(); // older than 24h -> not returned
  });

  it('carries a status_reason string', async () => {
    await doPush(sample());
    const body = (await (await doList()).json()) as { experiments: Array<Record<string, unknown>> };
    expect(typeof body.experiments[0].status_reason).toBe('string');
  });
});

describe('heartbeat-derived status', () => {
  const hbSample = (hb: Record<string, unknown>, step = 500) =>
    sample({ metrics: { natural: 0.4, step }, hb });

  it('dead-trainer: fresh push but trainer not alive', async () => {
    await doPush(hbSample({ trainer_alive: false, tb_last_write: now / 1000, step: 500 }));
    const body = (await (await doList()).json()) as { experiments: Array<Record<string, unknown>> };
    expect(body.experiments[0].status).toBe('dead-trainer');
  });

  it('starting: trainer up but no step yet', async () => {
    await doPush(sample({ metrics: {}, hb: { trainer_alive: true, step: null } }));
    const body = (await (await doList()).json()) as { experiments: Array<Record<string, unknown>> };
    expect(body.experiments[0].status).toBe('starting');
  });

  it('stalled: trainer up but TB frozen >10m', async () => {
    await doPush(hbSample({ trainer_alive: true, tb_last_write: now / 1000 - 15 * 60, step: 500 }));
    const body = (await (await doList()).json()) as { experiments: Array<Record<string, unknown>> };
    expect(body.experiments[0].status).toBe('stalled');
  });

  it('running: trainer up and TB fresh', async () => {
    await doPush(hbSample({ trainer_alive: true, tb_last_write: now / 1000, step: 500 }));
    const body = (await (await doList()).json()) as { experiments: Array<Record<string, unknown>> };
    expect(body.experiments[0].status).toBe('running');
  });

  it('legacy pusher (no hb) still reports running by age', async () => {
    await doPush(sample()); // sample() has no hb
    const body = (await (await doList()).json()) as { experiments: Array<Record<string, unknown>> };
    expect(body.experiments[0].status).toBe('running');
  });

  it('stalled via server-side step freeze when tb_last_write absent', async () => {
    // First push seeds step 500; step_changed_at = now.
    await doPush(sample({ metrics: { step: 500 }, hb: { trainer_alive: true, step: 500 } }));
    // 12 min later, same step, no tb_last_write -> frozen by server tracking.
    now += 12 * 60 * 1000;
    await doPush(sample({ metrics: { step: 500 }, hb: { trainer_alive: true, step: 500 } }));
    const body = (await (await doList()).json()) as { experiments: Array<Record<string, unknown>> };
    expect(body.experiments[0].status).toBe('stalled');
  });
});

describe('history samples', () => {
  it('appends a sample per step change and buckets on read', async () => {
    for (let i = 0; i < 5; i++) {
      now += 60_000;
      await doPush(sample({ metrics: { natural: 0.4 + i * 0.01, step: 500 + i * 100 } }));
    }
    // Re-push the same step: must NOT add a duplicate sample.
    await doPush(sample({ metrics: { natural: 0.99, step: 900 } }));
    const res = await doHistory('id=vast:123&max_points=100');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { series: Record<string, Array<{ step: number }>> };
    expect(body.series['vast:123']).toHaveLength(5);
    expect(body.series['vast:123'][0].step).toBe(500);
    expect(body.series['vast:123'][4].step).toBe(900);
  });

  it('400s without an id', async () => {
    expect((await doHistory('')).status).toBe(400);
  });

  it('buckets by step window when ?bucket= given', async () => {
    for (let i = 0; i < 10; i++) {
      now += 60_000;
      await doPush(sample({ metrics: { natural: 0.5, step: i * 100 } }));
    }
    const res = await doHistory('id=vast:123&bucket=500');
    const body = (await res.json()) as { series: Record<string, Array<{ step: number }>> };
    // steps 0..900 in windows of 500 -> two buckets.
    expect(body.series['vast:123']).toHaveLength(2);
  });
});

function emptyPayload() {
  return { metrics: {}, history_natural: [], ws_public: null, box: { gpu: 'GPU', dph: 0 } };
}
