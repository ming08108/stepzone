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

const API_URL = '/api/versus';
const RTC_CONFIG: RTCConfiguration = {
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
      const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
      pc.addEventListener('icegatheringstatechange', function check() {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      });
    });
  }
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error('no local description');
  return sdp;
}

/** Resolve once the channel opens; reject on failure/timeout. */
function waitForOpen(pc: RTCPeerConnection, channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (why: string) => {
      clearTimeout(timer);
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail('connection timed out'), OPEN_TIMEOUT_MS);
    channel.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        fail('connection failed (NAT/firewall)');
      }
    });
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
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: 'create', hostName }),
    });
    if (!res.ok) return null;
    ({ code } = (await res.json()) as { code: string });
  } catch {
    return null;
  }

  let closed = false;
  const handled = new Set<string>();
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
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ t: 'answer', code, joinId: join.joinId, answer }),
      });
      if (!res.ok) throw new Error(`answer ${res.status}`);
      const channel = await Promise.race([
        channelArrived,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('connection timed out')), OPEN_TIMEOUT_MS),
        ),
      ]);
      if (channel.readyState !== 'open') await waitForOpen(pc, channel);
      if (closed) {
        pc.close();
        return;
      }
      room.onPeer?.({ channel, close: () => pc.close() });
    } catch {
      // A failed/timed-out joiner must not take down the poll loop.
      pc.close();
    }
  };

  const poll = async (): Promise<void> => {
    while (!closed) {
      try {
        const res = await fetch(`${API_URL}?code=${code}&role=host`);
        if (res.status === 404) {
          // Room expired server-side — surface it once and stop.
          if (!closed) room.onDead?.();
          closed = true;
          return;
        }
        if (res.ok) {
          const body = (await res.json()) as { joins?: PendingJoin[] };
          for (const join of body.joins ?? []) {
            if (handled.has(join.joinId)) continue;
            handled.add(join.joinId);
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
