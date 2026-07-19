/**
 * The experiments-feed API handlers — Web-standard (Request -> Response), so
 * the same code runs as a Vercel Function and under vitest with constructed
 * Requests. Two mounts:
 *
 *   POST /api/experiments-push  (createPushHandler) — a training box self-reports.
 *     Bearer EXPERIMENTS_PUSH_TOKEN. Body {id, name, metrics, history_natural,
 *     ws_public, box:{gpu,dph}}. Compromise of the token only lets an attacker
 *     post fake metrics — no account, no other data. Bodies >32 KB and >60
 *     req/min per id are rejected (light protection).
 *
 *   GET /api/experiments  (createListHandler) — public read (metrics only). No
 *     auth. Returns {generated_at, experiments:[...]} in the SAME shape the
 *     ?experiments dashboard already consumes from the local experiments.json,
 *     each row given a computed status from its age:
 *       running (<5 min) · stale (<30 min) · dead (older). Rows older than 24 h
 *     are dropped entirely.
 */

import { error, json } from './httpResponse';
import type { ExperimentsStore, ExpPayload } from './experimentsStore';

const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_PER_MIN = 60;
const RATE_WINDOW_MS = 60_000;

const WINDOW_MS = 24 * 60 * 60 * 1000; // rows older than this are not returned
const RUNNING_MS = 5 * 60 * 1000;
const STALE_MS = 30 * 60 * 1000;

const MAX_HISTORY = 200;
const MAX_METRICS = 64;

export interface PushHandler {
  POST(req: Request): Promise<Response>;
}
export interface ListHandler {
  GET(req: Request): Promise<Response>;
}

/** Sliding-window per-id counter. Best-effort: a serverless instance only sees
 *  its own share of traffic, but that is enough to blunt a runaway pusher. */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  allow(id: string, now: number): boolean {
    const cutoff = now - RATE_WINDOW_MS;
    const arr = (this.hits.get(id) ?? []).filter((t) => t > cutoff);
    if (arr.length >= RATE_LIMIT_PER_MIN) {
      this.hits.set(id, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(id, arr);
    return true;
  }
}

function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** Constant-time-ish string compare (avoids trivially leaking length via ===). */
function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Validate + normalize a push body. Returns null on any malformed field. */
function parsePush(raw: unknown): { id: string; name: string; payload: ExpPayload } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const id = o.id;
  const name = o.name;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return null;

  // metrics: a flat map of finite numbers (non-numbers are dropped, not fatal).
  const metrics: Record<string, number> = {};
  if (o.metrics && typeof o.metrics === 'object') {
    let n = 0;
    for (const [k, v] of Object.entries(o.metrics as Record<string, unknown>)) {
      if (n >= MAX_METRICS) break;
      if (isFiniteNum(v)) {
        metrics[k.slice(0, 48)] = v;
        n++;
      }
    }
  }

  const history_natural: number[] = Array.isArray(o.history_natural)
    ? (o.history_natural as unknown[]).filter(isFiniteNum).slice(-MAX_HISTORY)
    : [];

  const ws_public =
    typeof o.ws_public === 'string' && o.ws_public.length <= 300 ? o.ws_public : null;

  let box: ExpPayload['box'] = { gpu: 'GPU', dph: 0 };
  if (o.box && typeof o.box === 'object') {
    const b = o.box as Record<string, unknown>;
    box = {
      gpu: typeof b.gpu === 'string' ? b.gpu.slice(0, 120) : 'GPU',
      dph: isFiniteNum(b.dph) ? b.dph : 0,
    };
  }

  return { id, name, payload: { metrics, history_natural, ws_public, box } };
}

export function createPushHandler(
  store: ExperimentsStore,
  token: string,
  now: () => number = Date.now,
): PushHandler {
  const limiter = new RateLimiter();
  return {
    async POST(req: Request): Promise<Response> {
      const supplied = bearerToken(req);
      if (!supplied || !tokenEquals(supplied, token)) {
        return error(401, 'unauthorized', 'missing or invalid push token');
      }
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return error(413, 'too_large', 'body too large (>32KB)');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return error(400, 'bad_request', 'invalid JSON');
      }
      const push = parsePush(parsed);
      if (!push) return error(400, 'bad_request', 'invalid experiment payload');
      if (!limiter.allow(push.id, now())) {
        return error(429, 'rate_limited', 'too many pushes for this id (max 60/min)');
      }
      await store.upsert(push.id, push.name, push.payload, now());
      return json(200, { ok: true });
    },
  };
}

function statusFromAge(ageMs: number): 'running' | 'stale' | 'dead' {
  if (ageMs <= RUNNING_MS) return 'running';
  if (ageMs <= STALE_MS) return 'stale';
  return 'dead';
}

export function createListHandler(
  store: ExperimentsStore,
  now: () => number = Date.now,
): ListHandler {
  return {
    async GET(_req: Request): Promise<Response> {
      const t = now();
      const rows = await store.listRecent(t - WINDOW_MS);
      const experiments = rows.map((r) => {
        const p = r.payload ?? { metrics: {}, history_natural: [], ws_public: null, box: null };
        const metrics = p.metrics ?? {};
        // `step` is a top-level field on the dashboard card; the box reports it
        // inside metrics (if at all). Pull it out; leave the rest as metrics.
        const step = isFiniteNum(metrics.step) ? metrics.step : null;
        const box = p.box ?? { gpu: 'GPU', dph: 0 };
        const wsPublic = p.ws_public ?? null;
        return {
          id: r.id,
          name: r.name,
          status: statusFromAge(t - r.updatedAt),
          last_update: new Date(r.updatedAt).toISOString(),
          step,
          metrics,
          history: Array.isArray(p.history_natural) ? p.history_natural : [],
          box: box.gpu ?? 'GPU',
          cost_per_hr: isFiniteNum(box.dph) ? box.dph : 0,
          ws_local: null,
          ws_public: wsPublic,
          has_stream: wsPublic != null,
          note: null,
        };
      });
      return json(200, { generated_at: new Date(t).toISOString(), experiments });
    },
  };
}
