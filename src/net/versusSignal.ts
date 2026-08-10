/**
 * Browser side of versus signaling: create/join rooms over /api/versus and
 * bring up the peer RTCDataChannel. Non-trickle ICE — each side waits for
 * candidate gathering to finish (with a ship-what-we-have timeout) and sends
 * ONE complete SDP through the server, so signaling is plain request/response
 * HTTP and works on serverless. After the channel opens the server is out of
 * the loop entirely.
 *
 * v2 flow (docs/VERSUS.md): the JOINER now drives the handshake. It creates the
 * data channel, offers, and posts the offer; the host — polling for joins,
 * which also heartbeats its room — answers each one. One room accepts many
 * joiners this way, and the host survives as long as it keeps polling.
 *
 * NAT reality: STUN alone connects most peer pairs; both sides behind symmetric
 * NAT/CGNAT will fail — callers surface that as "could not connect" rather than
 * hanging forever.
 */

import { isRoomCode } from './versus';

const API_URL = '/api/versus';
// A public STUN server for NAT traversal in production. E2E runs both peers on
// localhost, where host candidates connect directly and STUN only adds gather
// latency/network flakiness — so the e2e injects window.__e2eRtc = {iceServers:[]}
// before load to skip it. Prod (no override) keeps STUN.
const RTC_CONFIG: RTCConfiguration = (typeof window !== 'undefined' &&
  (window as unknown as { __e2eRtc?: RTCConfiguration }).__e2eRtc) || {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
/** Ship the SDP after this long even if gathering hasn't said "complete". */
const GATHER_TIMEOUT_MS = 2_500;
/** Host poll cadence — also the room's heartbeat interval. */
const HOST_POLL_MS = 1_500;
/** Joiner poll cadence while waiting for the host's answer. */
const ANSWER_POLL_MS = 1_000;
/** Joiner gives up if no answer arrives within this window. */
const JOIN_ANSWER_TIMEOUT_MS = 30_000;
/** Give up on ICE if the channel hasn't opened by then (symmetric NAT etc.). */
const OPEN_TIMEOUT_MS = 25_000;

export interface VersusConnection {
  channel: RTCDataChannel;
  close(): void;
}

export interface HostedRoomChannel {
  code: string;
  /** Called with each newly-connected guest channel. */
  onPeer?: (conn: VersusConnection) => void;
  /** Fired once if the server reports the room gone (host should recreate). */
  onDead?: () => void;
  /** Stop polling and refuse new joiners (existing channels unaffected). */
  close(): void;
}

/** setLocalDescription and wait for a complete (or good-enough) SDP. */
async function completeSdp(pc: RTCPeerConnection): Promise<string> {
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      const timer = setTimeout(done, GATHER_TIMEOUT_MS); // ship what we have
      pc.addEventListener('icegatheringstatechange', check);
    });
  }
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error('no local description');
  return sdp;
}

/** Resolve once the channel opens; reject on failure/timeout. */
function waitForOpen(pc: RTCPeerConnection, channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener('open', onOpen);
      pc.removeEventListener('connectionstatechange', onState);
    };
    const fail = (why: string) => {
      cleanup();
      reject(new Error(why));
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onState = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        fail('connection failed (NAT/firewall)');
      }
    };
    const timer = setTimeout(() => fail('connection timed out'), OPEN_TIMEOUT_MS);
    channel.addEventListener('open', onOpen);
    pc.addEventListener('connectionstatechange', onState);
  });
}

interface PendingJoin {
  joinId: string;
  joinerName: string;
  offer: string;
}

/**
 * Create a room and start accepting joiners. Returns immediately with the arrow
 * code; guests arrive later via onPeer. The poll loop below is the room's
 * heartbeat — while it runs the room stays live server-side.
 */
export async function createRoomChannel(hostName: string): Promise<HostedRoomChannel | null> {
  let code: string;
  let hostToken: string;
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: 'create', hostName }),
    });
    if (!res.ok) return null;
    ({ code, hostToken } = (await res.json()) as { code: string; hostToken: string });
  } catch {
    return null;
  }
  // A malformed create response (no/invalid code) would otherwise spin the poll
  // loop forever on `?code=undefined` (400s, never 404) — fail fast instead.
  if (!isRoomCode(code) || typeof hostToken !== 'string' || hostToken.length < 32) return null;
  const hostHeaders = { authorization: `Bearer ${hostToken}` };

  let closed = false;
  /** Joins whose answer we've committed — never answer them twice. */
  const answered = new Set<string>();
  /** Joins currently being answered — dedupe concurrent poll cycles without
   *  permanently skipping a join whose answer failed transiently. */
  const inFlight = new Set<string>();
  const room: HostedRoomChannel = {
    code,
    close() {
      closed = true;
    },
  };

  // Answer one joiner's offer and, once its channel opens, hand it to onPeer.
  const handleJoin = async (join: PendingJoin): Promise<void> => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    try {
      const channelArrived = new Promise<RTCDataChannel>((resolve) => {
        pc.addEventListener('datachannel', (e) => resolve(e.channel));
      });
      await pc.setRemoteDescription({ type: 'offer', sdp: join.offer });
      await pc.setLocalDescription(await pc.createAnswer());
      const answer = await completeSdp(pc);
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...hostHeaders },
        body: JSON.stringify({ t: 'answer', code, joinId: join.joinId, answer }),
      });
      if (!res.ok) throw new Error(`answer ${res.status}`);
      // The answer is committed (consume-once server-side) — never re-answer
      // this join. Anything past here failing means the joiner re-joins fresh.
      answered.add(join.joinId);
      let openTimer: ReturnType<typeof setTimeout> | undefined;
      const channel = await Promise.race([
        channelArrived,
        new Promise<never>((_, rej) => {
          openTimer = setTimeout(() => rej(new Error('connection timed out')), OPEN_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(openTimer); // channelArrived won — don't leak the 25s timer
      if (channel.readyState !== 'open') await waitForOpen(pc, channel);
      if (closed) {
        pc.close();
        return;
      }
      room.onPeer?.({ channel, close: () => pc.close() });
    } catch {
      // A failed/timed-out joiner must not take down the poll loop. If we never
      // got as far as committing the answer, a later poll will retry this join.
      pc.close();
    } finally {
      inFlight.delete(join.joinId);
    }
  };

  const poll = async (): Promise<void> => {
    while (!closed) {
      try {
        const res = await fetch(`${API_URL}?code=${code}&role=host`, { headers: hostHeaders });
        if (res.status === 404) {
          // Room expired server-side — surface it once and stop.
          if (!closed) room.onDead?.();
          closed = true;
          return;
        }
        if (res.ok) {
          const body = (await res.json()) as { joins?: PendingJoin[] };
          for (const join of body.joins ?? []) {
            if (answered.has(join.joinId) || inFlight.has(join.joinId)) continue;
            inFlight.add(join.joinId);
            void handleJoin(join);
          }
        }
      } catch {
        // Transient network error — keep polling.
      }
      await new Promise((r) => setTimeout(r, HOST_POLL_MS));
    }
  };
  void poll();
  return room;
}

/** Look a room up by code (confirms it's live before committing to join). */
export async function fetchRoom(code: string): Promise<{ hostName: string } | null> {
  try {
    const res = await fetch(`${API_URL}?code=${code}`);
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.hostName !== 'string') return null;
    return { hostName: body.hostName };
  } catch {
    return null;
  }
}

/** Join a room: offer, post it, poll for the host's answer, connect. Null =
 *  the room is gone or the connection never came up. */
export async function joinRoomChannel(
  code: string,
  joinerName: string,
): Promise<VersusConnection | null> {
  if (!(await fetchRoom(code))) return null;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = pc.createDataChannel('versus', { ordered: true });
  try {
    await pc.setLocalDescription(await pc.createOffer());
    const offer = await completeSdp(pc);
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: 'join', code, joinerName, offer }),
    });
    if (!res.ok) throw new Error(`join ${res.status}`);
    const { joinId } = (await res.json()) as { joinId: string };

    const deadline = Date.now() + JOIN_ANSWER_TIMEOUT_MS;
    let answer: string | null = null;
    while (Date.now() < deadline) {
      const poll = await fetch(`${API_URL}?code=${code}&joinId=${joinId}`);
      if (poll.status === 404) throw new Error('join expired');
      if (poll.ok) {
        const body = (await poll.json()) as { answer: string | null };
        if (body.answer) {
          answer = body.answer;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, ANSWER_POLL_MS));
    }
    if (!answer) throw new Error('no answer');

    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    await waitForOpen(pc, channel);
    return { channel, close: () => pc.close() };
  } catch {
    pc.close();
    return null;
  }
}
