/**
 * The leaderboard server (server/leaderboard.mjs): submission merging, ranking,
 * validation, and the view shape the client (src/app/leaderboard.ts) consumes.
 * Runs the real HTTP server on an ephemeral port, in-memory (no data file).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain-JS server module (no type declarations)
import { createLeaderboard } from '../server/leaderboard.mjs';

const HASH = 'ab12cd34ef56ab78';

let server: { listen: Function; close: Function; ready: Promise<void> };
let base = '';

beforeAll(async () => {
  server = createLeaderboard({ dataFile: null });
  await server.ready;
  await new Promise<void>((res) => server.listen(0, res));
  const addr = (server as unknown as { address(): { port: number } }).address();
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((res) => server.close(() => res())));

const post = (body: unknown) =>
  fetch(`${base}/api/scores`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('leaderboard server', () => {
  it('accepts a first score and ranks it #1', async () => {
    const res = await post({
      chartHash: HASH,
      player: 'ALICE',
      percent: 0.9,
      grade: 'AA',
      maxCombo: 50,
    });
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.total).toBe(1);
    expect(view.rank).toBe(1);
    expect(view.entries[0]).toMatchObject({ rank: 1, player: 'ALICE', percent: 0.9, plays: 1 });
  });

  it('ranks a higher score above, reports the submitter rank', async () => {
    const res = await post({
      chartHash: HASH,
      player: 'BOB',
      percent: 0.95,
      grade: 'AAA',
      maxCombo: 80,
    });
    const view = await res.json();
    expect(view.total).toBe(2);
    expect(view.rank).toBe(1);
    expect(view.entries.map((e: { player: string }) => e.player)).toEqual(['BOB', 'ALICE']);
  });

  it('merges per player: keeps the best percent, counts plays', async () => {
    const res = await post({
      chartHash: HASH,
      player: 'ALICE',
      percent: 0.5,
      grade: 'C',
      maxCombo: 90,
    });
    const view = await res.json();
    const alice = view.entries.find((e: { player: string }) => e.player === 'ALICE');
    expect(alice.percent).toBe(0.9); // worse run doesn't lower the best
    expect(alice.grade).toBe('AA');
    expect(alice.maxCombo).toBe(90); // maxCombo merges as a max independently
    expect(alice.plays).toBe(2);
    expect(view.rank).toBe(2); // ALICE's view of her own rank
  });

  it('GET returns the board with the asking player marked', async () => {
    const res = await fetch(`${base}/api/scores/${HASH}?player=ALICE`);
    const view = await res.json();
    expect(view.total).toBe(2);
    expect(view.rank).toBe(2);
  });

  it('GET on an unplayed chart returns an empty board', async () => {
    const view = await (await fetch(`${base}/api/scores/ffffffffffffffff`)).json();
    expect(view).toMatchObject({ total: 0, rank: null, entries: [] });
  });

  it('rejects malformed submissions', async () => {
    expect(
      (await post({ chartHash: 'nope', player: 'A', percent: 0.5, grade: 'B', maxCombo: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await post({ chartHash: HASH, player: '', percent: 0.5, grade: 'B', maxCombo: 1 })).status,
    ).toBe(400);
    expect(
      (await post({ chartHash: HASH, player: 'A', percent: 7, grade: 'B', maxCombo: 1 })).status,
    ).toBe(400);
    expect(
      (await post({ chartHash: HASH, player: 'A', percent: 0.5, grade: 'B', maxCombo: -2 })).status,
    ).toBe(400);
  });

  it('unknown routes 404', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });
});
