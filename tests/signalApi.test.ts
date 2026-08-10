/**
 * Versus signaling API (handlers + memory store) exercised as Web
 * Request/Response, the way Vercel and the dev middleware both run it.
 *
 * v2 is joiner-initiated: create a room, a joiner posts an offer, the host
 * polls (which heartbeats the room) and answers, the joiner polls for that
 * answer. `now` is injected so expiry is deterministic.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createSignalHandlers, type SignalHandlers } from '../src/net/signalApi';
import { MemorySignalStore } from '../src/net/signalStore';
import { isRoomCode, ROOM_LIVE_MS } from '../src/net/versus';

const URL_BASE = 'http://test/api/versus';

let handlers: SignalHandlers;
let now: number;

beforeEach(() => {
  now = 1_000_000;
  handlers = createSignalHandlers(new MemorySignalStore(), () => now);
});

const post = (body: unknown, hostToken?: string) =>
  handlers.POST(
    new Request(URL_BASE, {
      method: 'POST',
      headers: hostToken ? { authorization: `Bearer ${hostToken}` } : undefined,
      body: JSON.stringify(body),
    }),
  );

const get = (query: string, hostToken?: string) =>
  handlers.GET(
    new Request(`${URL_BASE}?${query}`, {
      headers: hostToken ? { authorization: `Bearer ${hostToken}` } : undefined,
    }),
  );

interface RoomCredentials {
  code: string;
  hostToken: string;
}

async function createRoom(hostName = 'HOST'): Promise<RoomCredentials> {
  const res = await post({ t: 'create', hostName });
  expect(res.status).toBe(200);
  const { code, hostToken } = (await res.json()) as RoomCredentials;
  expect(isRoomCode(code)).toBe(true);
  expect(hostToken).toMatch(/^[a-f0-9]{64}$/);
  return { code, hostToken };
}

async function join(code: string, joinerName: string, offer: string): Promise<string> {
  const res = await post({ t: 'join', code, joinerName, offer });
  expect(res.status).toBe(200);
  const { joinId } = (await res.json()) as { joinId: string };
  expect(typeof joinId).toBe('string');
  return joinId;
}

describe('versus signaling', () => {
  it('runs the create -> join -> host-poll -> answer -> joiner-poll happy path', async () => {
    const { code, hostToken } = await createRoom();

    // Room lookup before joining.
    const lookup = await get(`code=${code}`);
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({ hostName: 'HOST' });

    const joinId = await join(code, 'RIVAL', 'v=0 fake-offer');

    // Host poll sees the pending join (offer, no answer yet).
    const hostPoll = await get(`code=${code}&role=host`, hostToken);
    expect(hostPoll.status).toBe(200);
    expect(await hostPoll.json()).toEqual({
      joins: [{ joinId, joinerName: 'RIVAL', offer: 'v=0 fake-offer' }],
    });

    // Joiner poll — still null until the host answers.
    const beforeAnswer = await get(`code=${code}&joinId=${joinId}`);
    expect(await beforeAnswer.json()).toEqual({ answer: null });

    // Host answers.
    const answered = await post(
      { t: 'answer', code, joinId, answer: 'v=0 fake-answer' },
      hostToken,
    );
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ ok: true });

    // Joiner poll now sees the answer.
    const afterAnswer = await get(`code=${code}&joinId=${joinId}`);
    expect(await afterAnswer.json()).toEqual({ answer: 'v=0 fake-answer' });

    // Answered join no longer shows up in the host's pending list.
    const afterHostPoll = await get(`code=${code}&role=host`, hostToken);
    expect(await afterHostPoll.json()).toEqual({ joins: [] });
  });

  it('serves many joiners for one room, oldest first', async () => {
    const { code, hostToken } = await createRoom();
    const a = await join(code, 'A', 'offer-a');
    now += 5;
    const b = await join(code, 'B', 'offer-b');

    const hostPoll = await get(`code=${code}&role=host`, hostToken);
    const { joins } = (await hostPoll.json()) as { joins: { joinId: string }[] };
    expect(joins.map((j) => j.joinId)).toEqual([a, b]);
  });

  it('requires the room secret for host polls and answers', async () => {
    const { code, hostToken } = await createRoom();
    const joinId = await join(code, 'RIVAL', 'offer');

    expect((await get(`code=${code}&role=host`)).status).toBe(401);
    expect((await get(`code=${code}&role=host`, '0'.repeat(64))).status).toBe(403);
    expect((await post({ t: 'answer', code, joinId, answer: 'answer' })).status).toBe(401);
    expect(
      (await post({ t: 'answer', code, joinId, answer: 'answer' }, '0'.repeat(64))).status,
    ).toBe(403);

    expect((await get(`code=${code}&role=host`, hostToken)).status).toBe(200);
  });

  it('404s a room after ROOM_LIVE_MS without a heartbeat', async () => {
    const { code, hostToken } = await createRoom();
    now += ROOM_LIVE_MS + 1;
    expect((await get(`code=${code}`)).status).toBe(404);
    expect((await get(`code=${code}&role=host`, hostToken)).status).toBe(404);
    // Joining a dead room is rejected too.
    expect((await post({ t: 'join', code, joinerName: 'X', offer: 'o' })).status).toBe(404);
  });

  it('keeps a room alive while the host keeps polling', async () => {
    const { code, hostToken } = await createRoom();
    // Just under the window, then a host poll refreshes the heartbeat.
    now += ROOM_LIVE_MS - 1;
    expect((await get(`code=${code}&role=host`, hostToken)).status).toBe(200);
    // Another near-full window later it is still live thanks to that refresh.
    now += ROOM_LIVE_MS - 1;
    expect((await get(`code=${code}`)).status).toBe(200);
  });

  it('404s a joiner poll once the join expires (JOIN_TTL_MS)', async () => {
    const { code, hostToken } = await createRoom();
    const joinId = await join(code, 'RIVAL', 'offer');
    // Keep the room alive with host polls (each within ROOM_LIVE_MS) while time
    // marches past JOIN_TTL_MS since the join was posted.
    now += 50_000;
    await get(`code=${code}&role=host`, hostToken);
    now += 50_000;
    await get(`code=${code}&role=host`, hostToken);
    now += 30_000; // 130_000 since the join -> past JOIN_TTL_MS; room still live
    expect((await get(`code=${code}&joinId=${joinId}`)).status).toBe(404);
    // Expired join is gone from the host's pending list too.
    const hostPoll = await get(`code=${code}&role=host`, hostToken);
    expect(hostPoll.status).toBe(200);
    expect(await hostPoll.json()).toEqual({ joins: [] });
  });

  it('rejects a second answer for the same join', async () => {
    const { code, hostToken } = await createRoom();
    const joinId = await join(code, 'RIVAL', 'offer');
    expect((await post({ t: 'answer', code, joinId, answer: 'first' }, hostToken)).status).toBe(
      200,
    );
    const second = await post({ t: 'answer', code, joinId, answer: 'second' }, hostToken);
    expect(second.status).toBe(404);
    // The original answer stands.
    const poll = await get(`code=${code}&joinId=${joinId}`);
    expect(await poll.json()).toEqual({ answer: 'first' });
  });

  it('404s an answer for an unknown join', async () => {
    const { code, hostToken } = await createRoom();
    const res = await post(
      {
        t: 'answer',
        code,
        joinId: 'does-not-exist',
        answer: 'sdp',
      },
      hostToken,
    );
    expect(res.status).toBe(404);
  });

  it('rejects oversized bodies', async () => {
    const huge = 'x'.repeat(128 * 1024 + 1);
    const res = await handlers.POST(new Request(URL_BASE, { method: 'POST', body: huge }));
    expect(res.status).toBe(413);
  });

  it('rejects malformed requests', async () => {
    expect((await post({ t: 'create', hostName: '' })).status).toBe(400);
    expect((await post({ t: 'nonsense' })).status).toBe(400);
    // join with a bad code / missing offer.
    expect((await post({ t: 'join', code: 'nope', joinerName: 'X', offer: 'o' })).status).toBe(400);
    expect((await post({ t: 'join', code: 'LLLLLL', joinerName: 'X' })).status).toBe(400);
    // answer with a bad joinId shape.
    expect((await post({ t: 'answer', code: 'LLLLLL', joinId: 'no', answer: 's' })).status).toBe(
      400,
    );
    // GET with an invalid code.
    expect((await get('code=short')).status).toBe(400);
    // Non-JSON body.
    const bad = await handlers.POST(new Request(URL_BASE, { method: 'POST', body: '{not json' }));
    expect(bad.status).toBe(400);
  });
});
