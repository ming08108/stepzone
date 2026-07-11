/**
 * Room storage behind the versus signaling API (net/signalApi.ts) — the same
 * store-seam pattern as scoreStore: memory for dev/tests, Postgres
 * (net/pgSignalStore.ts) in production. Rooms are ephemeral handshake state
 * (code + SDP offer/answer) and expire after ROOM_TTL_MS; a room accepts
 * exactly one answer (first joiner wins).
 */

import { ROOM_TTL_MS, type SignalRoom } from './versus';

export type AnswerOutcome = 'ok' | 'not_found' | 'taken';

export interface SignalStore {
  /** Store a fresh room; the code is assumed collision-checked by the caller. */
  create(room: SignalRoom): Promise<boolean>; // false = code already live
  /** The room, or null when unknown/expired. */
  get(code: string, now: number): Promise<SignalRoom | null>;
  /** First joiner claims the room with its answer SDP. */
  answer(code: string, joinerName: string, answer: string, now: number): Promise<AnswerOutcome>;
}

export class MemorySignalStore implements SignalStore {
  private readonly rooms = new Map<string, SignalRoom>();

  private live(code: string, now: number): SignalRoom | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    if (now - room.createdAt > ROOM_TTL_MS) {
      this.rooms.delete(code);
      return null;
    }
    return room;
  }

  create(room: SignalRoom): Promise<boolean> {
    if (this.live(room.code, room.createdAt)) return Promise.resolve(false);
    this.rooms.set(room.code, { ...room });
    return Promise.resolve(true);
  }

  get(code: string, now: number): Promise<SignalRoom | null> {
    const room = this.live(code, now);
    return Promise.resolve(room ? { ...room } : null);
  }

  answer(code: string, joinerName: string, answer: string, now: number): Promise<AnswerOutcome> {
    const room = this.live(code, now);
    if (!room) return Promise.resolve('not_found');
    if (room.answer !== null) return Promise.resolve('taken');
    room.answer = answer;
    room.joinerName = joinerName;
    return Promise.resolve('ok');
  }
}
