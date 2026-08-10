/**
 * The versus signaling API — Web-standard handlers (like net/scoresApi.ts)
 * mounted at /api/versus. This is the ONLY server involvement in live versus:
 * it brokers the room code and the WebRTC SDP offer/answer, then gets out of
 * the way — the match runs peer-to-peer (docs/VERSUS.md).
 *
 * Signaling v2 is joiner-initiated (one room, many joiners) — the host polls
 * for joins and that poll doubles as its heartbeat.
 *
 * Routes:
 *   POST {t:'create', hostName}            -> { code }
 *   POST {t:'join', code, joinerName, offer} -> { joinId } | 404 not_found
 *   POST {t:'answer', code, joinId, answer}  -> { ok: true } | 404 not_found
 *   GET  ?code=XXXXXX             (lookup)     -> { hostName } | 404
 *   GET  ?code=XXXXXX&role=host   (host poll, bearer auth) -> { joins: [...] } | 404
 *   GET  ?code=XXXXXX&joinId=YYY  (join poll)  -> { answer } | 404
 */

import { error, json } from './httpResponse';
import { isRoomCode, parseSignalRequest, randomRoomCode } from './versus';
import type { SignalStore } from './signalStore';
import { bearerToken, randomToken, sha256Hex } from './crypto';

const MAX_BODY_BYTES = 128 * 1024;

async function authenticateHost(
  store: SignalStore,
  req: Request,
  code: string,
  now: number,
): Promise<Response | null> {
  const token = bearerToken(req);
  if (!token) return error(401, 'unauthorized', 'host token required');
  const outcome = await store.authenticateHost(code, await sha256Hex(token), now);
  if (outcome === 'missing') return error(404, 'not_found', 'no such room (or it expired)');
  if (outcome === 'forbidden') return error(403, 'forbidden', 'invalid host token');
  return null;
}

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

      // Joiner polling for its answer.
      const joinId = url.searchParams.get('joinId');
      if (joinId !== null) {
        const join = await store.getJoin(code, joinId, now());
        if (!join) return error(404, 'not_found', 'no such join (or it expired)');
        return json(200, { answer: join.answer });
      }

      // Host polling for joins — also refreshes the room heartbeat.
      if (url.searchParams.get('role') === 'host') {
        const denied = await authenticateHost(store, req, code, now());
        if (denied) return denied;
        const joins = await store.pendingJoins(code, now());
        return json(200, {
          joins: joins.map((j) => ({ joinId: j.joinId, joinerName: j.joinerName, offer: j.offer })),
        });
      }

      // Plain lookup before joining.
      const room = await store.getRoom(code, now());
      if (!room) return error(404, 'not_found', 'no such room (or it expired)');
      return json(200, { hostName: room.hostName });
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
          const hostToken = randomToken();
          const at = now();
          const ok = await store.createRoom({
            code,
            hostName: msg.hostName,
            hostTokenHash: await sha256Hex(hostToken),
            createdAt: at,
            lastSeen: at,
          });
          if (ok) return json(200, { code, hostToken });
        }
        return error(503, 'busy', 'could not allocate a room code');
      }

      if (msg.t === 'join') {
        const joinId = crypto.randomUUID();
        const outcome = await store.addJoin({
          code: msg.code,
          joinId,
          joinerName: msg.joinerName,
          offer: msg.offer,
          answer: null,
          createdAt: now(),
        });
        if (outcome === 'no_room') return error(404, 'not_found', 'no such room (or it expired)');
        return json(200, { joinId });
      }

      // msg.t === 'answer'
      const denied = await authenticateHost(store, req, msg.code, now());
      if (denied) return denied;
      if (!(await store.answerJoin(msg.code, msg.joinId, msg.answer, now()))) {
        return error(404, 'not_found', 'no such pending join');
      }
      return json(200, { ok: true });
    },
  };
}
