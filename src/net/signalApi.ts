/**
 * The versus signaling API — Web-standard handlers (like net/scoresApi.ts)
 * mounted at /api/versus. This is the ONLY server involvement in live versus:
 * it brokers the room code and the WebRTC SDP offer/answer, then gets out of
 * the way — the match runs peer-to-peer (docs/VERSUS.md).
 *
 * Routes:
 *   POST {t:'create', hostName, chart, musicRate, offer} -> { code }
 *   POST {t:'answer', code, joinerName, answer}          -> { ok } | 404/409
 *   GET  ?code=XXXXXX          (joiner) -> { hostName, chart, musicRate, offer }
 *   GET  ?code=XXXXXX&role=host (host poll) -> { answer, joinerName } (nulls until joined)
 */

import { error, json } from './httpResponse';
import { isRoomCode, parseSignalRequest, randomRoomCode } from './versus';
import type { SignalStore } from './signalStore';

const MAX_BODY_BYTES = 128 * 1024;

export interface SignalHandlers {
  GET(req: Request): Promise<Response>;
  POST(req: Request): Promise<Response>;
}

export function createSignalHandlers(
  store: SignalStore,
  now: () => number = Date.now,
): SignalHandlers {
  return {
    async GET(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const code = url.searchParams.get('code');
      if (!isRoomCode(code)) return error(400, 'bad_request', 'invalid room code');
      const room = await store.get(code, now());
      if (!room) return error(404, 'not_found', 'no such room (or it expired)');
      if (url.searchParams.get('role') === 'host') {
        return json(200, { answer: room.answer, joinerName: room.joinerName });
      }
      return json(200, {
        hostName: room.hostName,
        song: room.song,
        musicRate: room.musicRate,
        offer: room.offer,
      });
    },

    async POST(req: Request): Promise<Response> {
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return error(413, 'too_large', 'body too large');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return error(400, 'bad_request', 'invalid JSON');
      }
      const msg = parseSignalRequest(parsed);
      if (!msg) return error(400, 'bad_request', 'invalid signaling request');

      if (msg.t === 'create') {
        // Codes are 4^6 — collisions are rare; retry a few times then give up.
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = randomRoomCode();
          const ok = await store.create({
            code,
            hostName: msg.hostName,
            song: msg.song,
            musicRate: msg.musicRate,
            offer: msg.offer,
            answer: null,
            joinerName: null,
            createdAt: now(),
          });
          if (ok) return json(200, { code });
        }
        return error(503, 'busy', 'could not allocate a room code');
      }

      const outcome = await store.answer(msg.code, msg.joinerName, msg.answer, now());
      if (outcome === 'not_found') return error(404, 'not_found', 'no such room (or it expired)');
      if (outcome === 'taken') return error(409, 'taken', 'room already has a player');
      return json(200, { ok: true });
    },
  };
}
