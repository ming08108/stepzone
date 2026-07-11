/**
 * The scores API end to end (handlers + memory store), exercised exactly the
 * way Vercel invokes it: Web Requests in, Web Responses out. The Postgres
 * store shares the merge/rank policy (mergeStoredBest/compareBests) with the
 * memory store, so these tests pin the semantics for both.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createHandlers, type ScoresHandlers } from '../src/net/scoresApi';
import { MemoryScoreStore } from '../src/net/scoreStore';
import type { LeaderboardResponse, ReplayEvent, SubmitScoreRequest } from '../src/net/protocol';
import { sampleReplay, validSubmit } from './netProtocol.test';

const URL_BASE = 'http://test/api/scores';

function post(handlers: ScoresHandlers, body: unknown): Promise<Response> {
  return handlers.POST(
    new Request(URL_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

async function board(
  handlers: ScoresHandlers,
  chartHash: string,
  rate = 1,
): Promise<LeaderboardResponse> {
  const res = await handlers.GET(new Request(`${URL_BASE}?chartHash=${chartHash}&rate=${rate}`));
  expect(res.status).toBe(200);
  return (await res.json()) as LeaderboardResponse;
}

function play(over: {
  playerId?: string;
  secret?: string;
  playerName?: string;
  percent?: number;
  maxCombo?: number;
  musicRate?: number;
}): SubmitScoreRequest {
  const base = validSubmit();
  return {
    ...base,
    playerId: over.playerId ?? base.playerId,
    secret: over.secret ?? over.playerId ?? base.secret,
    playerName: over.playerName ?? base.playerName,
    musicRate: over.musicRate ?? base.musicRate,
    result: {
      ...base.result,
      percent: over.percent ?? base.result.percent,
      maxCombo: over.maxCombo ?? base.result.maxCombo,
    },
  };
}

let handlers: ScoresHandlers;
let now: number;

beforeEach(() => {
  now = 1_000;
  handlers = createHandlers(new MemoryScoreStore(), () => now++);
});

describe('POST /api/scores', () => {
  it('accepts a first play as rank 1 personal best', async () => {
    const res = await post(handlers, play({ playerId: 'a', percent: 0.9 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, rank: 1, isPersonalBest: true });
  });

  it('ranks players by percent and reports the submitters rank', async () => {
    await post(handlers, play({ playerId: 'a', percent: 0.9 }));
    const res = await post(handlers, play({ playerId: 'b', percent: 0.8 }));
    expect(await res.json()).toEqual({ ok: true, rank: 2, isPersonalBest: true });
  });

  it('merges a worse play into the stored best (maxCombo folds independently)', async () => {
    await post(handlers, play({ playerId: 'a', percent: 0.9, maxCombo: 50 }));
    const res = await post(handlers, play({ playerId: 'a', percent: 0.7, maxCombo: 80 }));
    expect(await res.json()).toEqual({ ok: true, rank: 1, isPersonalBest: false });
    const rows = (await board(handlers, 'abc123')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].percent).toBe(0.9);
    expect(rows[0].maxCombo).toBe(80);
  });

  it('rejects a claimed playerId with the wrong secret', async () => {
    await post(handlers, play({ playerId: 'a', secret: 'right' }));
    const res = await post(handlers, play({ playerId: 'a', secret: 'wrong' }));
    expect(res.status).toBe(403);
    const rows = (await board(handlers, 'abc123')).rows;
    expect(rows).toHaveLength(1);
  });

  it('updates the display name on later submissions', async () => {
    await post(handlers, play({ playerId: 'a', playerName: 'OLD' }));
    await post(handlers, play({ playerId: 'a', playerName: 'NEW', percent: 0.1 }));
    expect((await board(handlers, 'abc123')).rows[0].playerName).toBe('NEW');
  });

  it('rejects malformed bodies', async () => {
    expect((await post(handlers, 'not json{{')).status).toBe(400);
    expect((await post(handlers, { nope: true })).status).toBe(400);
    expect((await post(handlers, { ...play({}), musicRate: 99 })).status).toBe(400);
  });
});

describe('POST /api/scores — anti-cheat', () => {
  it('rejects a keyboard device and a missing input', async () => {
    const kb = { ...validSubmit(), input: { device: 'keyboard', padId: 'kb', padKnown: false } };
    expect((await post(handlers, kb)).status).toBe(400);
    const noInput = { ...validSubmit() } as Record<string, unknown>;
    delete noInput.input;
    expect((await post(handlers, noInput)).status).toBe(400);
  });

  it('rejects a malformed / missing replay', async () => {
    const bad: ReplayEvent[] = [
      { t: 1, track: 0, up: false },
      { t: 0, track: 0, up: false }, // time goes backwards
    ];
    expect((await post(handlers, { ...validSubmit(), replay: bad })).status).toBe(400);
    const noReplay = { ...validSubmit() } as Record<string, unknown>;
    delete noReplay.replay;
    expect((await post(handlers, noReplay)).status).toBe(400);
  });

  it('rejects a v1 submission outright', async () => {
    expect((await post(handlers, { ...validSubmit(), protocol: 1 })).status).toBe(400);
  });

  it('rejects a replay with fewer presses than the combo', async () => {
    // maxCombo 100 (allowed by the 100 judged taps), but only 50 presses logged.
    const sub = { ...validSubmit(), replay: sampleReplay(50) };
    expect((await post(handlers, sub)).status).toBe(400);
  });

  it('rejects a replay collapsed into an implausibly short span', async () => {
    // 100 presses (covers the combo) but crammed into < 5 s with 95 judged taps.
    const crammed: ReplayEvent[] = Array.from({ length: 100 }, (_, i) => ({
      t: Math.round(i * 0.001 * 1e4) / 1e4,
      track: i % 4,
      up: false,
    }));
    expect((await post(handlers, { ...validSubmit(), replay: crammed })).status).toBe(400);
  });

  it('stores the replay on a personal best and serves it via replayOf', async () => {
    const res = await post(handlers, play({ playerId: 'a', percent: 0.9 }));
    expect(res.status).toBe(200);
    expect((await board(handlers, 'abc123')).rows[0].hasReplay).toBe(true);

    const got = await handlers.GET(new Request(`${URL_BASE}?chartHash=abc123&rate=1&replayOf=a`));
    expect(got.status).toBe(200);
    const body = (await got.json()) as { replay: ReplayEvent[] };
    expect(body.replay).toEqual(validSubmit().replay);
  });

  it('404s a replay request for a player with none stored', async () => {
    const res = await handlers.GET(new Request(`${URL_BASE}?chartHash=abc123&rate=1&replayOf=z`));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/scores', () => {
  it('requires chartHash and a sane rate', async () => {
    expect((await handlers.GET(new Request(URL_BASE))).status).toBe(400);
    expect((await handlers.GET(new Request(`${URL_BASE}?chartHash=x&rate=9`))).status).toBe(400);
  });

  it('returns an empty board for an unknown chart', async () => {
    expect(await board(handlers, 'nothing')).toEqual({ rows: [], total: 0 });
  });

  it('partitions boards by music rate', async () => {
    await post(handlers, play({ playerId: 'a', musicRate: 1 }));
    await post(handlers, play({ playerId: 'b', musicRate: 1.5 }));
    expect((await board(handlers, 'abc123', 1)).rows.map((r) => r.playerId)).toEqual(['a']);
    expect((await board(handlers, 'abc123', 1.5)).rows.map((r) => r.playerId)).toEqual(['b']);
  });

  it('shares ranks on ties and orders earlier achievers first', async () => {
    await post(handlers, play({ playerId: 'a', percent: 0.9 }));
    await post(handlers, play({ playerId: 'b', percent: 0.9 }));
    await post(handlers, play({ playerId: 'c', percent: 0.5 }));
    const rows = (await board(handlers, 'abc123')).rows;
    expect(rows.map((r) => [r.playerId, r.rank])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 3],
    ]);
  });

  it('stores a ghost with a personal best and serves it via ghostOf', async () => {
    const ghost = [{ atSong: 0, percent: 0.1, combo: 3, life: 0.9 }];
    await post(handlers, { ...play({ playerId: 'a', percent: 0.9 }), ghost });
    expect((await board(handlers, 'abc123')).rows[0].hasGhost).toBe(true);

    const res = await handlers.GET(new Request(`${URL_BASE}?chartHash=abc123&rate=1&ghostOf=a`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ghost });
  });

  it('a worse play keeps the best ghost; a better ghostless play clears it', async () => {
    const ghost = [{ atSong: 0, percent: 0.1, combo: 3, life: 0.9 }];
    await post(handlers, { ...play({ playerId: 'a', percent: 0.9 }), ghost });
    await post(handlers, play({ playerId: 'a', percent: 0.5 }));
    expect((await board(handlers, 'abc123')).rows[0].hasGhost).toBe(true);

    await post(handlers, play({ playerId: 'a', percent: 0.95 }));
    expect((await board(handlers, 'abc123')).rows[0].hasGhost).toBe(false);
    const res = await handlers.GET(new Request(`${URL_BASE}?chartHash=abc123&rate=1&ghostOf=a`));
    expect(res.status).toBe(404);
  });

  it('404s a ghost request for a player with no stored ghost', async () => {
    await post(handlers, play({ playerId: 'a' }));
    const res = await handlers.GET(new Request(`${URL_BASE}?chartHash=abc123&rate=1&ghostOf=a`));
    expect(res.status).toBe(404);
  });

  it('caps rows at the limit but reports the full total', async () => {
    for (let i = 0; i < 5; i++) {
      await post(handlers, play({ playerId: `p${i}`, percent: 0.5 + i / 100 }));
    }
    const res = await handlers.GET(new Request(`${URL_BASE}?chartHash=abc123&rate=1&limit=2`));
    const body = (await res.json()) as LeaderboardResponse;
    expect(body.rows).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(body.rows[0].playerId).toBe('p4');
  });
});
