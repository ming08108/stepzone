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
import {
  FIXTURE_CHART_HASH,
  fixtureReplay,
  perfectReplay,
  sampleReplay,
  spreadReplay,
  validSubmit,
} from './netProtocol.test';

const URL_BASE = 'http://test/api/scores';
/** The board the fixture chart hashes to; every submission re-simulates against
 *  it. Replaces the old hand-picked 'abc123' now that the hash must be real. */
const HASH = FIXTURE_CHART_HASH;
/** All 16 note indices of the fixture stream. */
const ALL = [...Array(16).keys()];

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

/**
 * Build a submission. The server RE-SIMULATES the replay and ranks on what it
 * produces, so the score is set by `replay` (defaulting to a perfect run =
 * 100%), NOT by the claimed `result`. Pass a partial replay to rank a player
 * below a perfect one. `percent`/`maxCombo` only shape the (ignored) claimed
 * result — kept so the malformed-body checks still have knobs.
 */
function play(over: {
  playerId?: string;
  secret?: string;
  playerName?: string;
  percent?: number;
  maxCombo?: number;
  musicRate?: number;
  replay?: ReplayEvent[];
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
    replay: over.replay ?? base.replay,
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

  it('ranks players by re-simulated percent and reports the submitters rank', async () => {
    // A perfect replay (100%) outranks a partial one — the CLAIMED percents are
    // ignored; the server ranks on what each replay actually scores.
    await post(handlers, play({ playerId: 'a', replay: perfectReplay() }));
    const res = await post(handlers, play({ playerId: 'b', replay: spreadReplay(8) }));
    expect(await res.json()).toEqual({ ok: true, rank: 2, isPersonalBest: true });
  });

  it('merges a worse play into the stored best (maxCombo folds independently)', async () => {
    // Play 1: high percent, broken combo (one note missed -> 0.9375, combo 8).
    await post(
      handlers,
      play({ playerId: 'a', replay: fixtureReplay(ALL.filter((i) => i !== 8)) }),
    );
    // Play 2: lower percent, but a full combo (all 16 hit late as W3 -> combo 16).
    const res = await post(handlers, play({ playerId: 'a', replay: fixtureReplay(ALL, 0.05) }));
    expect(await res.json()).toEqual({ ok: true, rank: 1, isPersonalBest: false });
    const rows = (await board(handlers, HASH)).rows;
    expect(rows).toHaveLength(1);
    // The best percent stays with play 1; the max combo folds in from play 2.
    expect(rows[0].percent).toBeCloseTo(0.9375, 6);
    expect(rows[0].maxCombo).toBe(16);
  });

  it('rejects a claimed playerId with the wrong secret', async () => {
    await post(handlers, play({ playerId: 'a', secret: 'right' }));
    const res = await post(handlers, play({ playerId: 'a', secret: 'wrong' }));
    expect(res.status).toBe(403);
    const rows = (await board(handlers, HASH)).rows;
    expect(rows).toHaveLength(1);
  });

  it('updates the display name on later submissions', async () => {
    await post(handlers, play({ playerId: 'a', playerName: 'OLD' }));
    await post(handlers, play({ playerId: 'a', playerName: 'NEW', percent: 0.1 }));
    expect((await board(handlers, HASH)).rows[0].playerName).toBe('NEW');
  });

  it('rejects malformed bodies', async () => {
    expect((await post(handlers, 'not json{{')).status).toBe(400);
    expect((await post(handlers, { nope: true })).status).toBe(400);
    expect((await post(handlers, { ...play({}), musicRate: 99 })).status).toBe(400);
  });
});

describe('POST /api/scores — anti-cheat', () => {
  it('does not treat client controller metadata as trusted evidence', async () => {
    const claimed = { ...validSubmit(), input: { device: 'keyboard', padId: 'made-up' } };
    expect((await post(handlers, claimed)).status).toBe(200);
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

  it('rate-limits repeated submissions by player credential', async () => {
    for (let i = 0; i < 12; i++) {
      expect((await post(handlers, play({ playerId: 'rate-test' }))).status).toBe(200);
    }
    expect((await post(handlers, play({ playerId: 'rate-test' }))).status).toBe(429);
  });

  it('rejects a stunted replay that cannot back the claimed play', async () => {
    // 50 presses crammed into < 5 s while the claim reports 95 judged taps —
    // too short to be a real play of a full chart. Rejected before re-sim.
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
    expect((await board(handlers, HASH, 1)).rows.map((r) => r.playerId)).toEqual(['a']);
    expect((await board(handlers, HASH, 1.5)).rows.map((r) => r.playerId)).toEqual(['b']);
  });

  it('shares ranks on ties and orders earlier achievers first', async () => {
    await post(handlers, play({ playerId: 'a', replay: perfectReplay() }));
    await post(handlers, play({ playerId: 'b', replay: perfectReplay() }));
    await post(handlers, play({ playerId: 'c', replay: spreadReplay(8) }));
    const rows = (await board(handlers, HASH)).rows;
    expect(rows.map((r) => [r.playerId, r.rank])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 3],
    ]);
  });

  it('caps rows at the limit but reports the full total', async () => {
    for (let i = 0; i < 5; i++) {
      // Distinct re-simulated percents (0.6875 .. 0.9375), p4 the highest.
      await post(handlers, play({ playerId: `p${i}`, replay: spreadReplay(11 + i) }));
    }
    const res = await handlers.GET(new Request(`${URL_BASE}?chartHash=${HASH}&rate=1&limit=2`));
    const body = (await res.json()) as LeaderboardResponse;
    expect(body.rows).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(body.rows[0].playerId).toBe('p4');
  });
});
