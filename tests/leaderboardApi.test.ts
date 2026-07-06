/**
 * The serverless leaderboard functions (api/scores.mjs, api/scores/[hash].mjs)
 * — the Vercel deployment — driven against an in-memory fake of the Upstash
 * Redis REST protocol, so the exact pipeline commands the functions send are
 * what's tested. The response contract must match the standalone server's
 * (tests/leaderboardServer.test.ts): the game client can't tell them apart.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain-JS serverless functions (no type declarations)
import submitHandler from '../api/scores.mjs';
// @ts-expect-error plain-JS serverless functions (no type declarations)
import fetchHandler from '../api/scores/[hash].mjs';

const HASH = '00aa11bb22cc33dd';

// --- In-memory Upstash: enough of the command set for these functions -------

const zsets = new Map<string, Map<string, number>>();
const hashes = new Map<string, Map<string, string>>();

function run(cmd: string[]): unknown {
  const [op, key, ...args] = cmd;
  switch (op) {
    case 'ECHO':
      return key;
    case 'ZADD': {
      // Only the exact form the functions use: ZADD key GT CH score member
      const [gt, ch, score, member] = args;
      if (gt !== 'GT' || ch !== 'CH') throw new Error(`unexpected ZADD form: ${args}`);
      let z = zsets.get(key);
      if (!z) zsets.set(key, (z = new Map()));
      const prev = z.get(member);
      if (prev === undefined || Number(score) > prev) {
        z.set(member, Number(score));
        return 1;
      }
      return 0;
    }
    case 'ZCARD':
      return zsets.get(key)?.size ?? 0;
    case 'ZREVRANK': {
      const ranked = [...(zsets.get(key) ?? new Map())].sort((a, b) => b[1] - a[1]);
      const i = ranked.findIndex(([m]) => m === args[0]);
      return i >= 0 ? i : null;
    }
    case 'ZRANGE': {
      const [start, stop, rev, withscores] = args;
      if (rev !== 'REV' || withscores !== 'WITHSCORES') throw new Error('unexpected ZRANGE form');
      const ranked = [...(zsets.get(key) ?? new Map())].sort((a, b) => b[1] - a[1]);
      return ranked.slice(Number(start), Number(stop) + 1).flatMap(([m, s]) => [m, String(s)]);
    }
    case 'HSET': {
      let h = hashes.get(key);
      if (!h) hashes.set(key, (h = new Map()));
      h.set(args[0], args[1]);
      return 1;
    }
    case 'HINCRBY': {
      let h = hashes.get(key);
      if (!h) hashes.set(key, (h = new Map()));
      const next = Number(h.get(args[0]) ?? 0) + Number(args[1]);
      h.set(args[0], String(next));
      return next;
    }
    case 'HMGET':
      return args.map((f) => hashes.get(key)?.get(f) ?? null);
    default:
      throw new Error(`fake redis: unhandled ${op}`);
  }
}

const realFetch = globalThis.fetch;

// --- Minimal Vercel req/res doubles ------------------------------------------

function call(handler: (req: unknown, res: unknown) => Promise<unknown>, req: object) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const res = {
      headers: {} as Record<string, string>,
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
      status(code: number) {
        return {
          json: (body: unknown) => resolve({ status: code, body }),
          end: () => resolve({ status: code, body: null }),
        };
      },
    };
    void handler(req, res);
  });
}

beforeAll(() => {
  process.env.KV_REST_API_URL = 'https://fake-upstash.test';
  process.env.KV_REST_API_TOKEN = 'token';
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).startsWith('https://fake-upstash.test')) {
      throw new Error('unexpected fetch target');
    }
    const commands = JSON.parse(String(init?.body)) as string[][];
    return new Response(JSON.stringify(commands.map((c) => ({ result: run(c) }))));
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
});

const post = (body: unknown) => call(submitHandler, { method: 'POST', body });
const get = (hash: string, player?: string) =>
  call(fetchHandler, { method: 'GET', query: { hash, player } });

describe('serverless leaderboard functions', () => {
  it('accepts a first score and ranks it #1', async () => {
    const { status, body } = await post({
      chartHash: HASH,
      player: 'ALICE',
      percent: 0.9,
      grade: 'AA',
      maxCombo: 50,
    });
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.rank).toBe(1);
    expect(body.entries[0]).toMatchObject({
      rank: 1,
      player: 'ALICE',
      percent: 0.9,
      grade: 'AA',
      plays: 1,
    });
  });

  it('ranks players across submissions', async () => {
    const { body } = await post({
      chartHash: HASH,
      player: 'BOB',
      percent: 0.95,
      grade: 'AAA',
      maxCombo: 80,
    });
    expect(body.rank).toBe(1);
    expect(body.entries.map((e: { player: string }) => e.player)).toEqual(['BOB', 'ALICE']);
  });

  it('a worse run keeps the best score but counts the play', async () => {
    const { body } = await post({
      chartHash: HASH,
      player: 'ALICE',
      percent: 0.4,
      grade: 'C',
      maxCombo: 10,
    });
    const alice = body.entries.find((e: { player: string }) => e.player === 'ALICE');
    expect(alice).toMatchObject({ percent: 0.9, grade: 'AA', plays: 2 });
    expect(body.rank).toBe(2);
  });

  it('GET returns the board with the asking player ranked', async () => {
    const { status, body } = await get(HASH, 'ALICE');
    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 2, rank: 2 });
  });

  it('GET on an unplayed chart returns an empty board', async () => {
    const { body } = await get('ffffffffffffffff');
    expect(body).toMatchObject({ total: 0, rank: null, entries: [] });
  });

  it('rejects malformed input', async () => {
    expect(
      (await post({ chartHash: 'nope', player: 'A', percent: 0.5, grade: 'B', maxCombo: 1 }))
        .status,
    ).toBe(400);
    expect((await get('not-a-hash')).status).toBe(400);
  });

  it('answers 503 when no storage is configured', async () => {
    const url = process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_URL;
    expect(
      (await post({ chartHash: HASH, player: 'A', percent: 0.5, grade: 'B', maxCombo: 1 })).status,
    ).toBe(503);
    process.env.KV_REST_API_URL = url;
  });
});
