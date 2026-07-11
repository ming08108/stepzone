/**
 * Browser side of versus signaling: create/join rooms over /api/versus and
 * bring up the peer RTCDataChannel. Non-trickle ICE — each side waits for
 * candidate gathering to finish (with a ship-what-we-have timeout) and sends
 * ONE complete SDP through the server, so signaling is plain request/response
 * HTTP and works on serverless. After the channel opens the server is out of
 * the loop entirely.
 *
 * NAT reality (docs/VERSUS.md): STUN alone connects most peer pairs; both
 * sides behind symmetric NAT/CGNAT will fail — callers surface that as
 * "could not connect" rather than hanging forever.
 */

import { parseVersusSongRef, type VersusSongRef } from './versus';

const API_URL = '/api/versus';
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
/** Ship the SDP after this long even if gathering hasn't said "complete". */
const GATHER_TIMEOUT_MS = 2_500;
const ANSWER_POLL_MS = 1_000;
/** Give up on ICE if the channel hasn't opened by then (symmetric NAT etc.). */
const OPEN_TIMEOUT_MS = 25_000;

export interface VersusConnection {
  channel: RTCDataChannel;
  close(): void;
}

export interface RoomInfo {
  hostName: string;
  song: VersusSongRef;
  musicRate: number;
  offer: string;
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

export interface HostedRoom {
  code: string;
  /** Resolves when a joiner connects; rejects on failure. cancel() aborts. */
  waitForPeer(): Promise<VersusConnection>;
  cancel(): void;
}

/** Create a room: returns the arrow code immediately, the peer later. */
export async function createRoom(
  hostName: string,
  song: VersusSongRef,
  musicRate: number,
): Promise<HostedRoom | null> {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = pc.createDataChannel('versus', { ordered: true });
  try {
    await pc.setLocalDescription(await pc.createOffer());
    const offer = await completeSdp(pc);
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: 'create', hostName, song, musicRate, offer }),
    });
    if (!res.ok) throw new Error(`signaling ${res.status}`);
    const { code } = (await res.json()) as { code: string };
    let cancelled = false;
    return {
      code,
      cancel() {
        cancelled = true;
        pc.close();
      },
      async waitForPeer(): Promise<VersusConnection> {
        // Poll for the joiner's answer, then let ICE do the rest.
        for (;;) {
          if (cancelled) throw new Error('cancelled');
          const poll = await fetch(`${API_URL}?code=${code}&role=host`);
          if (poll.ok) {
            const body = (await poll.json()) as { answer: string | null };
            if (body.answer) {
              await pc.setRemoteDescription({ type: 'answer', sdp: body.answer });
              break;
            }
          }
          await new Promise((r) => setTimeout(r, ANSWER_POLL_MS));
        }
        await waitForOpen(pc, channel);
        return { channel, close: () => pc.close() };
      },
    };
  } catch {
    pc.close();
    return null;
  }
}

/** Look a room up by code (shows the chart before committing to join). */
export async function fetchRoom(code: string): Promise<RoomInfo | null> {
  try {
    const res = await fetch(`${API_URL}?code=${code}`);
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const song = parseVersusSongRef(body.song);
    if (!song || typeof body.offer !== 'string' || typeof body.hostName !== 'string') return null;
    const musicRate = typeof body.musicRate === 'number' ? body.musicRate : 1;
    return { hostName: body.hostName, song, musicRate, offer: body.offer };
  } catch {
    return null;
  }
}

/** Answer a room's offer and connect. Null = signaling refused (gone/taken). */
export async function joinRoom(
  code: string,
  joinerName: string,
  room: RoomInfo,
): Promise<VersusConnection | null> {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channelOpen = new Promise<RTCDataChannel>((resolve) => {
    pc.addEventListener('datachannel', (e) => resolve(e.channel));
  });
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: room.offer });
    await pc.setLocalDescription(await pc.createAnswer());
    const answer = await completeSdp(pc);
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: 'answer', code, joinerName, answer }),
    });
    if (!res.ok) throw new Error(`signaling ${res.status}`);
    // The channel arrives via ondatachannel once ICE connects.
    const channel = await Promise.race([
      channelOpen,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('connection timed out')), OPEN_TIMEOUT_MS),
      ),
    ]);
    if (channel.readyState !== 'open') {
      await waitForOpen(pc, channel);
    }
    return { channel, close: () => pc.close() };
  } catch {
    pc.close();
    return null;
  }
}
