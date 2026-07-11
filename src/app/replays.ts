/**
 * Local replay store: the input log of your BEST play per chart + rate, kept in
 * localStorage so you can re-watch it later (todo: REPLAYS). Small and
 * self-evicting — replays are heavier than scores, so only the most recently
 * written MAX_REPLAYS survive and an over-long log is dropped rather than
 * stored. Same defensive load/sanitize discipline as app/scores.ts: malformed
 * entries are skipped, never thrown on.
 */

import { isRecord, loadJson, saveJson } from './storage';
import { MAX_REPLAY_EVENTS, parseReplay, type ReplayEvent } from '../net/protocol';

const STORAGE_KEY = 'notefield.replays.v1';
/** Keep at most this many stored replays (least-recently-written evicted). */
const MAX_REPLAYS = 40;
/** Don't persist logs bigger than this — the same ceiling the server accepts. */
const MAX_STORED_EVENTS = MAX_REPLAY_EVENTS;

interface StoredReplay {
  events: ReplayEvent[];
  /** Unix ms this entry was last written; drives least-recently-written evict. */
  written: number;
}

/** Board-local key: one best replay per chart content hash × integer rate. */
function key(chartHash: string, rateKey: number): string {
  return `${chartHash}·${rateKey}`;
}

/** Validate one persisted entry; null drops malformed ones instead of throwing. */
function sanitize(v: unknown): StoredReplay | null {
  if (!isRecord(v)) return null;
  const events = parseReplay(v.events);
  if (!events) return null;
  const written = typeof v.written === 'number' && Number.isFinite(v.written) ? v.written : 0;
  return { events, written };
}

function load(): Record<string, StoredReplay> {
  const parsed = loadJson<unknown>(STORAGE_KEY);
  const out: Record<string, StoredReplay> = {};
  if (isRecord(parsed)) {
    for (const [k, entry] of Object.entries(parsed)) {
      const r = sanitize(entry);
      if (r) out[k] = r;
    }
  }
  return out;
}

/**
 * Store the replay of a best play. No-ops for an over-long log (never persist
 * more than the store cap). When the store is full, the least-recently-written
 * entry is evicted to make room.
 */
export function saveReplay(chartHash: string, rateKey: number, events: ReplayEvent[]): void {
  if (events.length > MAX_STORED_EVENTS) return;
  const map = load();
  map[key(chartHash, rateKey)] = { events, written: Date.now() };
  const keys = Object.keys(map);
  if (keys.length > MAX_REPLAYS) {
    // Evict oldest-written first until back under the cap.
    keys.sort((a, b) => map[a].written - map[b].written);
    for (const k of keys.slice(0, keys.length - MAX_REPLAYS)) delete map[k];
  }
  saveJson(STORAGE_KEY, map);
}

/** The stored best replay for a chart + rate, or null when none is kept. */
export function loadReplay(chartHash: string, rateKey: number): ReplayEvent[] | null {
  const entry = load()[key(chartHash, rateKey)];
  return entry ? entry.events : null;
}
