/**
 * Versus signaling API (handlers + memory store) exercised as Web
 * Request/Response, the way Vercel and the dev middleware both run it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createSignalHandlers, type SignalHandlers } from '../src/net/signalApi';
import { MemorySignalStore } from '../src/net/signalStore';
import { isRoomCode, MAX_ROOM_CHARTS, ROOM_TTL_MS } from '../src/net/versus';

const URL_BASE = 'http://test/api/versus';

let handlers: SignalHandlers;
let now: number;

beforeEach(() => {
  now = 1_000_000;
  handlers = createSignalHandlers(new MemorySignalStore(), () => now);
});

const post = (body: unknown) =>
  handlers.POST(new Request(URL_BASE, { method: 'POST', body: JSON.stringify(body) }));

const songRef = () => ({
  title: 'Song',
  artist: 'Artist',
  charts: [
    { chartHash: 'aaa111', stepsType: 'dance-single', difficulty: 2, meter: 5 },
    { chartHash: 'bbb222', stepsType: 'dance-single', difficulty: 4, meter: 9 },
  ],
});

async function createRoom(): Promise<string> {
  const res = await post({
    t: 'create',
    hostName: 'HOST',
    song: songRef(),
    musicRate: 1,
    offer: 'v=0 fake-offer-sdp',
  });
  expect(res.status).toBe(200);
  const { code } = (await res.json()) as { code: string };
  expect(isRoomCode(code)).toBe(true);
  return code;
}

describe('versus signaling', () => {
  it('creates a room and serves the offer to a joiner', async () => {
    const code = await createRoom();
    const res = await handlers.GET(new Request(`${URL_BASE}?code=${code}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.hostName).toBe('HOST');
    expect(body.offer).toBe('v=0 fake-offer-sdp');
    const song = body.song as { charts: { chartHash: string }[] };
    expect(song.charts.map((c) => c.chartHash)).toEqual(['aaa111', 'bbb222']);
  });

  it('host poll sees nulls until the joiner answers, then the answer', async () => {
    const code = await createRoom();
    const empty = await handlers.GET(new Request(`${URL_BASE}?code=${code}&role=host`));
    expect(await empty.json()).toEqual({ answer: null, joinerName: null });

    const answered = await post({
      t: 'answer',
      code,
      joinerName: 'RIVAL',
      answer: 'v=0 fake-answer-sdp',
    });
    expect(answered.status).toBe(200);
    const poll = await handlers.GET(new Request(`${URL_BASE}?code=${code}&role=host`));
    expect(await poll.json()).toEqual({ answer: 'v=0 fake-answer-sdp', joinerName: 'RIVAL' });
  });

  it('a room takes exactly one answer (first joiner wins)', async () => {
    const code = await createRoom();
    await post({ t: 'answer', code, joinerName: 'A', answer: 'sdp-a' });
    const second = await post({ t: 'answer', code, joinerName: 'B', answer: 'sdp-b' });
    expect(second.status).toBe(409);
  });

  it('404s unknown and expired rooms', async () => {
    expect((await handlers.GET(new Request(`${URL_BASE}?code=LLLLLL`))).status).toBe(404);
    const code = await createRoom();
    now += ROOM_TTL_MS + 1;
    expect((await handlers.GET(new Request(`${URL_BASE}?code=${code}`))).status).toBe(404);
    const late = await post({ t: 'answer', code, joinerName: 'X', answer: 'sdp' });
    expect(late.status).toBe(404);
  });

  it('rejects malformed requests', async () => {
    expect((await post({ t: 'create', hostName: '' })).status).toBe(400);
    expect(
      (
        await post({
          t: 'create',
          hostName: 'H',
          song: { ...songRef(), charts: [] },
          musicRate: 1,
          offer: 's',
        })
      ).status,
    ).toBe(400);
    const tooMany = {
      ...songRef(),
      charts: Array.from({ length: MAX_ROOM_CHARTS + 1 }, (_, i) => ({
        chartHash: 'h' + i,
        stepsType: 'dance-single',
        difficulty: 2,
        meter: 5,
      })),
    };
    expect(
      (await post({ t: 'create', hostName: 'H', song: tooMany, musicRate: 1, offer: 's' })).status,
    ).toBe(400);
    expect((await post({ t: 'answer', code: 'nope', joinerName: 'X', answer: 's' })).status).toBe(
      400,
    );
    expect((await handlers.GET(new Request(`${URL_BASE}?code=short`))).status).toBe(400);
  });
});
