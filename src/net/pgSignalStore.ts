/**
 * Neon Postgres SignalStore — production signaling storage behind
 * api/versus.ts. Serverless invocations share nothing, so the handshake rows
 * must live in the database (an in-memory store only works in the single
 * dev-server process). Rooms and joins are tiny and short-lived; expired rows
 * are reaped opportunistically on createRoom.
 */

import { neon } from '@neondatabase/serverless';
import { JOIN_TTL_MS, ROOM_LIVE_MS, type SignalJoin, type SignalRoom } from './versus';
import type { AddJoinOutcome, SignalStore } from './signalStore';

type Sql = ReturnType<typeof neon>;

const ROOMS_SCHEMA = `CREATE TABLE IF NOT EXISTS net_versus_rooms3 (
  code       TEXT PRIMARY KEY,
  host_name  TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen  BIGINT NOT NULL
)`;

const JOINS_SCHEMA = `CREATE TABLE IF NOT EXISTS net_versus_joins1 (
  code        TEXT NOT NULL,
  join_id     TEXT NOT NULL,
  joiner_name TEXT NOT NULL,
  offer       TEXT NOT NULL,
  answer      TEXT,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (code, join_id)
)`;

interface RoomRow {
  code: string;
  host_name: string;
  created_at: string | number;
  last_seen: string | number;
}

interface JoinRow {
  code: string;
  join_id: string;
  joiner_name: string;
  offer: string;
  answer: string | null;
  created_at: string | number;
}

export class PgSignalStore implements SignalStore {
  private readonly sql: Sql;
  private schemaReady: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  private ensureSchema(): Promise<void> {
    this.schemaReady ??= (async () => {
      await this.sql.query(ROOMS_SCHEMA);
      await this.sql.query(JOINS_SCHEMA);
    })();
    return this.schemaReady;
  }

  async createRoom(room: SignalRoom): Promise<boolean> {
    await this.ensureSchema();
    // Reap expired rows so codes recycle and the tables stay tiny.
    await this.sql.query(`DELETE FROM net_versus_rooms3 WHERE last_seen < $1`, [
      room.createdAt - ROOM_LIVE_MS,
    ]);
    await this.sql.query(`DELETE FROM net_versus_joins1 WHERE created_at < $1`, [
      room.createdAt - JOIN_TTL_MS,
    ]);
    const rows = (await this.sql.query(
      `INSERT INTO net_versus_rooms3 (code, host_name, created_at, last_seen)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO NOTHING
       RETURNING code`,
      [room.code, room.hostName, room.createdAt, room.lastSeen],
    )) as { code: string }[];
    return rows.length > 0;
  }

  async getRoom(code: string, now: number): Promise<SignalRoom | null> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `SELECT * FROM net_versus_rooms3 WHERE code = $1 AND last_seen > $2`,
      [code, now - ROOM_LIVE_MS],
    )) as RoomRow[];
    const r = rows[0];
    if (!r) return null;
    return {
      code: r.code,
      hostName: r.host_name,
      createdAt: Number(r.created_at),
      lastSeen: Number(r.last_seen),
    };
  }

  async heartbeat(code: string, now: number): Promise<boolean> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `UPDATE net_versus_rooms3 SET last_seen = $2
       WHERE code = $1 AND last_seen > $3
       RETURNING code`,
      [code, now, now - ROOM_LIVE_MS],
    )) as { code: string }[];
    return rows.length > 0;
  }

  async addJoin(join: SignalJoin): Promise<AddJoinOutcome> {
    await this.ensureSchema();
    const live = (await this.sql.query(
      `SELECT code FROM net_versus_rooms3 WHERE code = $1 AND last_seen > $2`,
      [join.code, join.createdAt - ROOM_LIVE_MS],
    )) as { code: string }[];
    if (live.length === 0) return 'no_room';
    await this.sql.query(
      `INSERT INTO net_versus_joins1 (code, join_id, joiner_name, offer, answer, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code, join_id) DO NOTHING`,
      [join.code, join.joinId, join.joinerName, join.offer, join.answer, join.createdAt],
    );
    return 'ok';
  }

  async pendingJoins(code: string, now: number): Promise<SignalJoin[]> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `SELECT * FROM net_versus_joins1
       WHERE code = $1 AND answer IS NULL AND created_at > $2
       ORDER BY created_at ASC`,
      [code, now - JOIN_TTL_MS],
    )) as JoinRow[];
    return rows.map((r) => ({
      code: r.code,
      joinId: r.join_id,
      joinerName: r.joiner_name,
      offer: r.offer,
      answer: r.answer,
      createdAt: Number(r.created_at),
    }));
  }

  async answerJoin(code: string, joinId: string, answer: string, now: number): Promise<boolean> {
    await this.ensureSchema();
    // Claim atomically: only the first answer for an unexpired join wins.
    const claimed = (await this.sql.query(
      `UPDATE net_versus_joins1 SET answer = $3
       WHERE code = $1 AND join_id = $2 AND answer IS NULL AND created_at > $4
       RETURNING join_id`,
      [code, joinId, answer, now - JOIN_TTL_MS],
    )) as { join_id: string }[];
    return claimed.length > 0;
  }

  async getJoin(code: string, joinId: string, now: number): Promise<SignalJoin | null> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `SELECT * FROM net_versus_joins1 WHERE code = $1 AND join_id = $2 AND created_at > $3`,
      [code, joinId, now - JOIN_TTL_MS],
    )) as JoinRow[];
    const r = rows[0];
    if (!r) return null;
    return {
      code: r.code,
      joinId: r.join_id,
      joinerName: r.joiner_name,
      offer: r.offer,
      answer: r.answer,
      createdAt: Number(r.created_at),
    };
  }
}
