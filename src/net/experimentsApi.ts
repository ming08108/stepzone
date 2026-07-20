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
import type { ExperimentsStore, ExpPayload, ExpHeartbeat, ExpRow } from './experimentsStore';

const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_PER_MIN = 60;
const RATE_WINDOW_MS = 60_000;

const WINDOW_MS = 24 * 60 * 60 * 1000; // rows older than this are not returned
// Boxes push every ~60s, so a push older than 150s means we've already missed at
// least one heartbeat. Tightened from the old 5-/30-min bands after a host-stopped
// box read "running" for minutes: <=150s ⇒ trust the heartbeat; 150s–15min ⇒
// "unreachable" (no heartbeat — box likely gone/host-stopped, NOT merely stale);
// >15min ⇒ dead.
const FRESH_MS = 150 * 1000; // push within this ⇒ trust the heartbeat signals
const UNREACHABLE_MS = 15 * 60 * 1000; // 150s–15min without a push ⇒ no heartbeat
const FROZEN_MS = 10 * 60 * 1000; // TB/step frozen this long (trainer alive) ⇒ stalled

const HISTORY_MAX_POINTS = 500; // default per-series bucket cap for the history endpoint
const HISTORY_HARD_CAP = 2000; // ceiling a caller can request

const MAX_HISTORY = 200;
const MAX_METRICS = 64;

/** Derived, server-side status. `running/dead` are age-compatible with the old
 *  age-only values; the rest are hb-derived signals. `unreachable` is the "we've
 *  lost the heartbeat but it hasn't been long enough to call it dead" band, and
 *  `paused` is a self-reported idle (not a failure). `stale` is retained for
 *  backward compat but no longer emitted. */
export type ExpStatus =
  'running' | 'starting' | 'stalled' | 'dead-trainer' | 'unreachable' | 'paused' | 'stale' | 'dead';

export interface PushHandler {
  POST(req: Request): Promise<Response>;
}
export interface ListHandler {
  GET(req: Request): Promise<Response>;
}
export interface HistoryHandler {
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

  const desc = typeof o.desc === 'string' && o.desc.length > 0 ? o.desc.slice(0, 400) : null;

  let box: ExpPayload['box'] = { gpu: 'GPU', dph: 0 };
  if (o.box && typeof o.box === 'object') {
    const b = o.box as Record<string, unknown>;
    box = {
      gpu: typeof b.gpu === 'string' ? b.gpu.slice(0, 120) : 'GPU',
      dph: isFiniteNum(b.dph) ? b.dph : 0,
    };
  }

  // hb is additive: a legacy pusher omits it and the list endpoint falls back to
  // age-only status. Every field is optional and independently defaulted.
  let hb: ExpHeartbeat | null = null;
  if (o.hb && typeof o.hb === 'object') {
    const h = o.hb as Record<string, unknown>;
    hb = {
      trainer_alive: typeof h.trainer_alive === 'boolean' ? h.trainer_alive : null,
      tb_last_write: isFiniteNum(h.tb_last_write) ? h.tb_last_write : null,
      step: isFiniteNum(h.step) ? h.step : null,
      config_hash: typeof h.config_hash === 'string' ? h.config_hash.slice(0, 64) : null,
      paused: typeof h.paused === 'boolean' ? h.paused : null,
    };
  }

  return { id, name, payload: { metrics, history_natural, ws_public, box, desc, hb } };
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
      const t = now();
      // Resolve the run's step from the heartbeat first (explicit), else from the
      // metrics blob (where legacy pushers keep it).
      const step = resolveStep(push.payload);
      const { stepChanged } = await store.upsert(push.id, push.name, push.payload, step, t);
      // Archive a time-series sample only when the step advanced — a stalled box
      // re-pushing the same scalars must not spam duplicate rows.
      if (stepChanged && step != null) {
        await store.insertSample({ expId: push.id, ts: t, step, metrics: push.payload.metrics });
      }
      return json(200, { ok: true });
    },
  };
}

/** The step for a push: hb.step wins (explicit), else metrics.step. */
function resolveStep(payload: ExpPayload): number | null {
  if (payload.hb && isFiniteNum(payload.hb.step)) return payload.hb.step;
  const m = payload.metrics ?? {};
  return isFiniteNum(m.step) ? m.step : null;
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

/** Server-side status from DISTINCT signals (v2 goal 1), not one age:
 *  - dead        : no push for >15 min (preempted / box gone / host stopped)
 *  - unreachable : no push for 150s–15 min (missed heartbeats; contact lost but
 *                  not yet long enough to call dead) — labelled "no heartbeat"
 *  - (fresh push, hb present:)
 *      paused       : run self-reports paused (intentionally idle — not a failure)
 *      dead-trainer : trainer process not found
 *      starting     : trainer up but no step yet, OR trainer_alive unconfirmed
 *      stalled      : trainer up but TB/step frozen ≥10 min (the hung-trainer bug)
 *      running      : trainer_alive AND a real (non-null) step that's advancing
 *  - (fresh push, no hb:) running — legacy pusher, age-only like before. */
function deriveStatus(row: ExpRow, now: number): { status: ExpStatus; reason: string } {
  const ageMs = now - row.updatedAt;
  if (ageMs > UNREACHABLE_MS) return { status: 'dead', reason: `no push for ${minutes(ageMs)}m` };
  if (ageMs > FRESH_MS) {
    return { status: 'unreachable', reason: `no heartbeat for ${minutes(ageMs)}m` };
  }

  const hb = row.payload?.hb ?? null;
  if (!hb) return { status: 'running', reason: 'fresh push (legacy pusher, no heartbeat)' };

  // Intentionally-stopped runs (e.g. the local 3080 arm) self-report paused: a
  // healthy idle state, surfaced neutrally rather than as a stalled failure.
  if (hb.paused === true) return { status: 'paused', reason: 'run paused (self-reported)' };

  if (hb.trainer_alive === false) {
    return { status: 'dead-trainer', reason: 'fresh push but train.py not running on the box' };
  }

  const step = row.lastStep ?? hb.step ?? null;
  if (step == null) {
    return { status: 'starting', reason: 'trainer up, no TB scalars yet' };
  }

  // Freeze detection: prefer the box's own TB events-file mtime (truthful even
  // right after a server restart, when step_changed_at hasn't warmed up yet);
  // fall back to our cross-push step-progress tracking.
  const frozenMs =
    hb.tb_last_write != null
      ? now - hb.tb_last_write * 1000
      : row.stepChangedAt != null
        ? now - row.stepChangedAt
        : 0;
  if (frozenMs > FROZEN_MS) {
    return {
      status: 'stalled',
      reason: `step ${step} frozen ${minutes(frozenMs)}m (trainer alive)`,
    };
  }

  // "running" (green) demands an affirmative trainer_alive AND a real step — a
  // freshly-booted run with step=null, or one whose pgrep was inconclusive, stays
  // "starting" rather than reading as falsely healthy.
  if (hb.trainer_alive !== true) {
    return { status: 'starting', reason: 'trainer status unconfirmed (pgrep inconclusive)' };
  }
  return { status: 'running', reason: `step ${step} advancing` };
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
        const { status, reason } = deriveStatus(r, t);
        return {
          id: r.id,
          name: r.name,
          desc: typeof p.desc === 'string' ? p.desc : null,
          status,
          status_reason: reason,
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

/** One downsampled point in a history series: bucket-averaged metrics at a step. */
interface HistoryPoint {
  step: number | null;
  ts: string;
  metrics: Record<string, number>;
}

/** Average the numeric metric keys of a bucket of raw samples into one point. */
function bucketAverage(
  bucket: { step: number | null; ts: number; metrics: Record<string, number> }[],
): HistoryPoint {
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  let stepSum = 0;
  let stepCount = 0;
  let tsSum = 0;
  for (const s of bucket) {
    if (s.step != null) {
      stepSum += s.step;
      stepCount++;
    }
    tsSum += s.ts;
    for (const [k, v] of Object.entries(s.metrics)) {
      if (!isFiniteNum(v)) continue;
      sums[k] = (sums[k] ?? 0) + v;
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  const metrics: Record<string, number> = {};
  for (const k of Object.keys(sums)) metrics[k] = sums[k] / counts[k];
  return {
    step: stepCount > 0 ? Math.round(stepSum / stepCount) : null,
    ts: new Date(Math.round(tsSum / bucket.length)).toISOString(),
    metrics,
  };
}

/** Downsample a step-ordered series to at most `maxPoints`, averaging within
 *  equal-count buckets. If `bucketStep` is given, bucket by step-value windows
 *  of that size instead (server-side step bucketing per the design doc). */
function bucketSeries(
  samples: { step: number | null; ts: number; metrics: Record<string, number> }[],
  maxPoints: number,
  bucketStep: number | null,
): HistoryPoint[] {
  if (samples.length === 0) return [];
  if (bucketStep && bucketStep > 0) {
    const groups = new Map<number, typeof samples>();
    for (const s of samples) {
      const key = s.step == null ? -1 : Math.floor(s.step / bucketStep);
      const arr = groups.get(key) ?? [];
      arr.push(s);
      groups.set(key, arr);
    }
    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, bucket]) => bucketAverage(bucket));
  }
  if (samples.length <= maxPoints) return samples.map((s) => bucketAverage([s]));
  const out: HistoryPoint[] = [];
  const size = samples.length / maxPoints;
  for (let i = 0; i < maxPoints; i++) {
    const lo = Math.floor(i * size);
    const hi = Math.min(samples.length, Math.floor((i + 1) * size));
    if (hi > lo) out.push(bucketAverage(samples.slice(lo, hi)));
  }
  return out;
}

function parseIntParam(v: string | null): number | null {
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** GET /api/experiments-history?id=<expId>[&ids=a,b][&bucket=<stepWindow>]
 *    [&from=<step>][&to=<step>][&max_points=<n>]
 *  Returns server-side-bucketed time-series per id: { series: { <id>: [ ... ] } }.
 *  x-axis is step (the scientifically useful cross-run comparison). */
export function createHistoryHandler(store: ExperimentsStore): HistoryHandler {
  return {
    async GET(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const idsParam = [
        ...(url.searchParams.get('id') ? [url.searchParams.get('id')!] : []),
        ...(url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()),
      ].filter((s) => s.length > 0);
      const ids = [...new Set(idsParam)].slice(0, 8);
      if (ids.length === 0) {
        return error(400, 'bad_request', 'supply ?id=<experiment id> (or ?ids=a,b)');
      }
      const bucketStep = parseIntParam(url.searchParams.get('bucket'));
      const fromStep = parseIntParam(url.searchParams.get('from'));
      const toStep = parseIntParam(url.searchParams.get('to'));
      const maxPoints = Math.min(
        parseIntParam(url.searchParams.get('max_points')) ?? HISTORY_MAX_POINTS,
        HISTORY_HARD_CAP,
      );

      const raw = await store.listSamples({ ids, fromStep, toStep });
      const byId = new Map<
        string,
        { step: number | null; ts: number; metrics: Record<string, number> }[]
      >();
      for (const id of ids) byId.set(id, []);
      for (const s of raw) {
        (byId.get(s.expId) ?? []).push({ step: s.step, ts: s.ts, metrics: s.metrics });
      }
      const series: Record<string, HistoryPoint[]> = {};
      for (const id of ids) {
        series[id] = bucketSeries(byId.get(id) ?? [], maxPoints, bucketStep);
      }
      return json(200, { series });
    },
  };
}
