/**
 * Neon Postgres SignalStore — production signaling storage behind
 * api/versus.ts. Serverless invocations share nothing, so the handshake rows
 * must live in the database (an in-memory store only works in the single
 * dev-server process). Rooms are tiny and short-lived; expired rows are
 * reaped opportunistically on create.
 */

import { neon } from '@neondatabase/serverless';
import { ROOM_TTL_MS, type SignalRoom } from './versus';
import type { AnswerOutcome, SignalStore } from './signalStore';

type Sql = ReturnType<typeof neon>;

const SCHEMA = `CREATE TABLE IF NOT EXISTS net_versus_rooms (
  code        TEXT PRIMARY KEY,
  host_name   TEXT NOT NULL,
  chart       JSONB NOT NULL,
  music_rate  DOUBLE PRECISION NOT NULL,
  offer       TEXT NOT NULL,
  answer      TEXT,
  joiner_name TEXT,
  created_at  BIGINT NOT NULL
)`;

interface RoomRow {
  code: string;
  host_name: string;
  chart: SignalRoom['chart'];
  music_rate: number;
  offer: string;
  answer: string | null;
  joiner_name: string | null;
  created_at: string | number;
}

export class PgSignalStore implements SignalStore {
  private readonly sql: Sql;
  private schemaReady: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  private ensureSchema(): Promise<void> {
    this.schemaReady ??= this.sql.query(SCHEMA).then(() => undefined);
    return this.schemaReady;
  }

  async create(room: SignalRoom): Promise<boolean> {
    await this.ensureSchema();
    // Reap expired rows so codes recycle and the table stays tiny.
    await this.sql.query(`DELETE FROM net_versus_rooms WHERE created_at < $1`, [
      room.createdAt - ROOM_TTL_MS,
    ]);
    const rows = (await this.sql.query(
      `INSERT INTO net_versus_rooms (code, host_name, chart, music_rate, offer, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO NOTHING
       RETURNING code`,
      [
        room.code,
        room.hostName,
        JSON.stringify(room.chart),
        room.musicRate,
        room.offer,
        room.createdAt,
      ],
    )) as { code: string }[];
    return rows.length > 0;
  }

  async get(code: string, now: number): Promise<SignalRoom | null> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `SELECT * FROM net_versus_rooms WHERE code = $1 AND created_at > $2`,
      [code, now - ROOM_TTL_MS],
    )) as RoomRow[];
    const r = rows[0];
    if (!r) return null;
    return {
      code: r.code,
      hostName: r.host_name,
      chart: r.chart,
      musicRate: r.music_rate,
      offer: r.offer,
      answer: r.answer,
      joinerName: r.joiner_name,
      createdAt: Number(r.created_at),
    };
  }

  async answer(
    code: string,
    joinerName: string,
    answer: string,
    now: number,
  ): Promise<AnswerOutcome> {
    await this.ensureSchema();
    const claimed = (await this.sql.query(
      `UPDATE net_versus_rooms SET answer = $2, joiner_name = $3
       WHERE code = $1 AND answer IS NULL AND created_at > $4
       RETURNING code`,
      [code, answer, joinerName, now - ROOM_TTL_MS],
    )) as { code: string }[];
    if (claimed.length > 0) return 'ok';
    return (await this.get(code, now)) ? 'taken' : 'not_found';
  }
}
