import { useEffect, useMemo, useState, type CSSProperties } from 'react';

/**
 * ?experiments — live dashboard for the DDR RL training fleet.
 *
 * Feed source depends on host:
 *   • Production (stepzone-omega.vercel.app, or any non-local host) polls the
 *     PUSH feed at /api/experiments — training boxes self-report there, so the
 *     dashboard needs no local updater and no LAN access to the boxes.
 *   • Local dev / the trycloudflare tunnel viewer polls /experiments.json,
 *     written by F:\isaac-spike\experiments_status.py every 60 s (unchanged).
 * Both return the same {generated_at, experiments:[...]} shape.
 *
 * Polls once every 15 s and renders one card per experiment: status dot, the key
 * DDR metrics, the box it runs on + $/hr, and a mini sparkline of `natural` over
 * the last N samples. Clicking a card that has a stream navigates (same tab) to
 * the existing ?isaacviewer with ?ws pointed at that experiment's relay.
 *
 * WS selection: each experiment carries ws_local + ws_public. We use ws_public
 * when the page is served over a *.trycloudflare.com host (phone/off-LAN), else
 * ws_local. An experiment with neither is shown non-clickable with a "no stream"
 * tag. Styling follows IsaacViewer's dark overlay palette.
 */

const POLL_MS = 15_000;

/** Local dev server and the trycloudflare tunnel viewer read the file the local
 *  updater writes; everything else (the production Vercel host) reads the pushed
 *  feed served by the /api/experiments function. */
function feedUrl(): string {
  const h = location.hostname;
  const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local');
  const isTunnel = h.endsWith('trycloudflare.com');
  return isLocal || isTunnel ? '/experiments.json' : '/api/experiments';
}

// Fresh data past this age (of the newest training step's wall time) is stale.
// The updater sets `status` itself; this is only a client-side fallback tint.

interface ExpMetrics {
  natural?: number | null;
  attempt?: number | null;
  timing_ms?: number | null;
  tier_perfect?: number | null;
  tier_great?: number | null;
  timesteps?: number | null;
  jump_clean?: number | null; // v4.1 jumps+holds only
  hold_completion?: number | null; // v4.1 jumps+holds only
}

type ExpStatus =
  | 'running'
  | 'starting'
  | 'stalled'
  | 'dead-trainer'
  | 'stale'
  | 'dead'
  | 'unreachable'
  | 'provisioning';

interface Experiment {
  id?: string; // stable identity (e.g. "vast:45329658" / "local:...")
  name: string;
  desc?: string | null;
  status: ExpStatus;
  status_reason?: string | null; // human-readable why, e.g. "step 500 frozen 15m"
  last_update: string | null;
  step: number | null;
  metrics: ExpMetrics;
  history: number[]; // natural, oldest -> newest
  box: string;
  cost_per_hr: number;
  ws_local: string | null;
  ws_public: string | null;
  has_stream?: boolean; // box is emitting a pose stream
  stream_unwired?: boolean; // streaming but no ws tunnel mapped
  note?: string | null;
}

interface Payload {
  generated_at: string;
  experiments: Experiment[];
}

// ---- palette (matches IsaacViewer's overlay chrome) -----------------------
const C = {
  bg: '#0f1220',
  panel: '#151830',
  panelHi: '#1b1f3a',
  border: '#232842',
  text: '#cdd6f4',
  muted: '#6b7394',
  dim: '#8b93b8',
  running: '#8fead0',
  stale: '#e6c15a',
  dead: '#e0556a',
  prov: '#8fb6ea',
  starting: '#8fb6ea', // blue — booting/handshaking, like provisioning
  stalled: '#e6915a', // orange — alive but no progress (distinct from amber stale)
  deadTrainer: '#c94f8f', // magenta — trainer process gone (distinct from plain dead red)
  spark: '#8fead0',
  sparkB: '#8fb6ea', // second overlay line
} as const;

const MONO = '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace';

const STATUS_META: Record<ExpStatus, { color: string; label: string }> = {
  running: { color: C.running, label: 'running' },
  starting: { color: C.starting, label: 'starting' },
  stalled: { color: C.stalled, label: 'stalled' },
  'dead-trainer': { color: C.deadTrainer, label: 'dead-trainer' },
  stale: { color: C.stale, label: 'stale' },
  dead: { color: C.dead, label: 'dead' },
  unreachable: { color: C.dead, label: 'unreachable' },
  provisioning: { color: C.prov, label: 'provisioning' },
};

/** History endpoint (/api/experiments-history) exists only on the prod Vercel host
 *  — the same hosts that read /api/experiments (NOT local, NOT tunnel). */
function historyAvailable(): boolean {
  return feedUrl() === '/api/experiments';
}

/** One plotted point: natural rate at a training step. */
interface HistPoint {
  step: number | null;
  natural: number | null;
}

/** ws_public on a *.trycloudflare.com host, else ws_local; null => no stream. */
function wsUrlFor(exp: Experiment): string | null {
  const usePublic = location.hostname.endsWith('trycloudflare.com');
  const url = usePublic ? exp.ws_public : exp.ws_local;
  return url && url.length ? url : null;
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(0)}%`;
}

function fmtInt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString();
}

function fmtSteps(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return `${Math.round(v)}`;
}

function ageLabel(iso: string | null): string {
  if (!iso) return 'no data';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'no data';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// ---- mini sparkline (inline SVG) ------------------------------------------
// Accepts either an index-spaced `data` array (the pushed history fallback) or
// explicit {x,y} `points` (natural vs step from the history endpoint). When
// `points` has >=2 finite pairs it wins; otherwise we fall back to `data`.
function Sparkline({ data, points }: { data?: number[]; points?: { x: number; y: number }[] }) {
  const W = 168;
  const H = 34;
  let xy: { x: number; y: number }[];
  if (points && points.length >= 2) {
    xy = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  } else {
    xy = (data ?? []).filter((v) => Number.isFinite(v)).map((v, i) => ({ x: i, y: v }));
  }
  if (xy.length < 2) {
    return (
      <div style={{ height: H, display: 'flex', alignItems: 'center' }}>
        <span style={{ color: C.muted, fontSize: 11 }}>no history yet</span>
      </div>
    );
  }
  // natural is a 0..1 rate; frame the plot to the data's own range with padding
  // so a flat-but-nonzero series still reads. x spans the actual step range.
  const xs = xy.map((p) => p.x);
  const ys = xy.map((p) => p.y);
  const xlo = Math.min(...xs);
  const xspan = Math.max(...xs) - xlo || 1;
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const pad = span * 0.12;
  const y0 = lo - pad;
  const y1 = hi + pad;
  const yr = y1 - y0 || 1;
  const x = (xv: number) => ((xv - xlo) / xspan) * (W - 2) + 1;
  const y = (v: number) => H - 2 - ((v - y0) / yr) * (H - 4);
  const line = xy.map((p) => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
  const area = `1,${H - 1} ${line} ${(W - 1).toFixed(1)},${H - 1}`;
  const last = xy[xy.length - 1];
  return (
    <svg width={W} height={H} style={{ display: 'block' }} aria-hidden>
      <polygon points={area} fill={C.spark} opacity={0.1} />
      <polyline points={line} fill="none" stroke={C.spark} strokeWidth={1.5} opacity={0.9} />
      <circle cx={x(last.x)} cy={y(last.y)} r={2.2} fill={C.spark} />
    </svg>
  );
}

// ---- overlay comparison chart (inline SVG, prod only) ---------------------
// Two natural-vs-step series overlaid with distinct colors; used by the run A/B
// selector. Larger than the per-card sparkline but the same visual language.
function OverlayChart({ a, b }: { a: { x: number; y: number }[]; b: { x: number; y: number }[] }) {
  const W = 560;
  const H = 180;
  const padX = 6;
  const padT = 10;
  const padB = 10;
  const all = [...a, ...b].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (all.length < 2) {
    return (
      <div style={{ height: H, display: 'flex', alignItems: 'center' }}>
        <span style={{ color: C.muted, fontSize: 11 }}>pick two runs to overlay</span>
      </div>
    );
  }
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const xlo = Math.min(...xs);
  const xspan = Math.max(...xs) - xlo || 1;
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const pd = span * 0.12;
  const y0 = lo - pd;
  const yr = hi + pd - y0 || 1;
  const X = (xv: number) => padX + ((xv - xlo) / xspan) * (W - padX * 2);
  const Y = (v: number) => H - padB - ((v - y0) / yr) * (H - padT - padB);
  const path = (s: { x: number; y: number }[]) =>
    s
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)} ${Y(p.y).toFixed(1)}`)
      .join(' ');
  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ display: 'block', maxWidth: W }}
      aria-hidden
    >
      {a.length >= 2 ? (
        <path d={path(a)} fill="none" stroke={C.spark} strokeWidth={1.6} opacity={0.9} />
      ) : null}
      {b.length >= 2 ? (
        <path d={path(b)} fill="none" stroke={C.sparkB} strokeWidth={1.6} opacity={0.9} />
      ) : null}
    </svg>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 60 }}>
      <span style={{ color: C.muted, fontSize: 10, letterSpacing: 0.3 }}>{label}</span>
      <span style={{ color: C.text, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  );
}

function ExperimentCard({ exp, hist }: { exp: Experiment; hist?: HistPoint[] }) {
  const meta = STATUS_META[exp.status] ?? STATUS_META.dead;
  const ws = wsUrlFor(exp);
  const clickable = ws != null && exp.status !== 'provisioning';
  const m = exp.metrics ?? {};
  const hasTiers = m.tier_perfect != null || m.tier_great != null;
  // natural vs step from the history endpoint; empty => Sparkline falls back to the
  // pushed exp.history array (local/tunnel hosts, fetch failure, or empty series).
  const xy = (hist ?? [])
    .filter((p) => p.step != null && p.natural != null)
    .map((p) => ({ x: p.step as number, y: p.natural as number }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  const open = () => {
    if (!clickable) return;
    // Same tab, same query-param convention the app uses (App.tsx routes on
    // ?isaacviewer). Prefer the stable ?exp=<id> link (IsaacViewer re-resolves the
    // ws from the feed, surviving box cycles); fall back to ?ws= if there's no id.
    const target = exp.id
      ? `${location.pathname}?isaacviewer&exp=${encodeURIComponent(exp.id)}`
      : ws
        ? `${location.pathname}?isaacviewer&ws=${encodeURIComponent(ws)}`
        : null;
    if (!target) return;
    location.href = target;
  };

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={open}
      onKeyDown={(e) => {
        if (clickable && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          open();
        }
      }}
      style={{
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        cursor: clickable ? 'pointer' : 'default',
        opacity: exp.status === 'provisioning' ? 0.72 : 1,
        transition: 'background 120ms, border-color 120ms',
      }}
      onMouseEnter={(e) => {
        if (clickable) {
          e.currentTarget.style.background = C.panelHi;
          e.currentTarget.style.borderColor = '#33406e';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = C.panel;
        e.currentTarget.style.borderColor = C.border;
      }}
    >
      {/* header: status dot + name + stream tag */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          title={exp.status_reason || meta.label}
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: meta.color,
            boxShadow: `0 0 8px ${meta.color}`,
            flex: '0 0 auto',
          }}
        />
        <span style={{ color: C.text, fontSize: 14, fontWeight: 600, flex: '1 1 auto' }}>
          {exp.name}
        </span>
        {ws == null ? (
          <span
            title={
              exp.stream_unwired ? 'a pose stream is running but no tunnel is mapped' : undefined
            }
            style={{
              color: exp.stream_unwired ? C.prov : C.muted,
              fontSize: 10,
              border: `1px solid ${exp.stream_unwired ? '#33406e' : C.border}`,
              borderRadius: 5,
              padding: '1px 6px',
            }}
          >
            {exp.stream_unwired ? 'stream · tunnel not wired' : 'no stream'}
          </span>
        ) : (
          <span
            title={exp.status_reason || meta.label}
            style={{ color: meta.color, fontSize: 10, letterSpacing: 0.3, cursor: 'help' }}
          >
            {meta.label}
          </span>
        )}
      </div>

      {/* sub: box + $/hr + freshness */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ color: C.dim, fontSize: 11 }}>{exp.box}</span>
        <span style={{ color: C.muted, fontSize: 11 }}>${exp.cost_per_hr.toFixed(2)}/hr</span>
        <span style={{ color: C.muted, fontSize: 11 }}>· {ageLabel(exp.last_update)}</span>
      </div>

      {exp.desc ? <div style={{ color: C.dim, fontSize: 11 }}>{exp.desc}</div> : null}

      {exp.note ? (
        <div style={{ color: C.muted, fontSize: 11, fontStyle: 'italic' }}>{exp.note}</div>
      ) : null}

      {/* metrics grid */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', rowGap: 10 }}>
        <Metric label="natural" value={fmtPct(m.natural)} />
        <Metric label="attempt" value={fmtPct(m.attempt)} />
        <Metric label="timing" value={m.timing_ms != null ? `${fmt(m.timing_ms, 1)}ms` : '—'} />
        {hasTiers ? <Metric label="perfect" value={fmtPct(m.tier_perfect)} /> : null}
        {hasTiers ? <Metric label="great" value={fmtPct(m.tier_great)} /> : null}
        {m.jump_clean != null ? <Metric label="jumps" value={fmtPct(m.jump_clean)} /> : null}
        {m.hold_completion != null ? (
          <Metric label="holds" value={fmtPct(m.hold_completion)} />
        ) : null}
        <Metric label="step" value={fmtInt(exp.step)} />
        <Metric label="timesteps" value={fmtSteps(m.timesteps)} />
      </div>

      {/* sparkline of natural — prefers step-indexed history, falls back to array */}
      <div>
        <span style={{ color: C.muted, fontSize: 10, letterSpacing: 0.3 }}>
          natural {xy.length >= 2 ? 'vs step' : '(last N)'}
        </span>
        <Sparkline points={xy.length >= 2 ? xy : undefined} data={exp.history ?? []} />
      </div>
    </div>
  );
}

// ---- two-run overlay comparison (React page only, prod hosts only) --------
// Two dropdowns pick run A / run B by id; below them one chart overlays both runs'
// natural-vs-step using the history endpoint (?ids=a,b). Distinct colors + legend.
function OverlayCompare({ experiments }: { experiments: Experiment[] }) {
  const [a, setA] = useState<string>('');
  const [b, setB] = useState<string>('');
  const [ptsA, setPtsA] = useState<{ x: number; y: number }[]>([]);
  const [ptsB, setPtsB] = useState<{ x: number; y: number }[]>([]);

  const options = experiments.filter((e) => !!e.id);

  useEffect(() => {
    if (!a && !b) {
      setPtsA([]);
      setPtsB([]);
      return;
    }
    let cancelled = false;
    const ids = [a, b].filter(Boolean);
    const run = async () => {
      try {
        const res = await fetch(
          `/api/experiments-history?ids=${ids.map(encodeURIComponent).join(',')}&max_points=120&t=${Date.now()}`,
          { cache: 'no-store' },
        );
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          series?: Record<string, { step: number | null; metrics?: { natural?: number | null } }[]>;
        };
        if (cancelled) return;
        const pick = (id: string) =>
          (body.series?.[id] ?? [])
            .map((p) => ({ x: p.step, y: p.metrics?.natural }))
            .filter(
              (p): p is { x: number; y: number } =>
                p.x != null && p.y != null && Number.isFinite(p.x) && Number.isFinite(p.y),
            );
        setPtsA(a ? pick(a) : []);
        setPtsB(b ? pick(b) : []);
      } catch {
        /* keep whatever we have */
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [a, b]);

  const selStyle: CSSProperties = {
    font: 'inherit',
    color: C.text,
    background: C.panel,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: '4px 8px',
  };
  const nameOf = (id: string) => options.find((e) => e.id === id)?.name ?? id;

  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: '14px 16px',
        marginBottom: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ color: C.dim, fontSize: 12, fontWeight: 600 }}>overlay compare</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 3, background: C.spark, borderRadius: 2 }} />
          <select value={a} onChange={(e) => setA(e.target.value)} style={selStyle}>
            <option value="">run A…</option>
            {options.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 3, background: C.sparkB, borderRadius: 2 }} />
          <select value={b} onChange={(e) => setB(e.target.value)} style={selStyle}>
            <option value="">run B…</option>
            {options.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {/* legend */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {a ? <span style={{ color: C.spark, fontSize: 11 }}>■ {nameOf(a)}</span> : null}
        {b ? <span style={{ color: C.sparkB, fontSize: 11 }}>■ {nameOf(b)}</span> : null}
        <span style={{ color: C.muted, fontSize: 11 }}>natural vs step</span>
      </div>
      <OverlayChart a={ptsA} b={ptsB} />
    </div>
  );
}

export function ExperimentsDashboard({ onExit }: { onExit: () => void }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number>(0);
  // natural-vs-step series per experiment id, from /api/experiments-history (prod
  // only). Refreshed in the same 15s poll as the feed; empty for any id => the card
  // falls back to that row's pushed history array.
  const [series, setSeries] = useState<Record<string, HistPoint[]>>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${feedUrl()}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) {
          // The feed function replies 503 {message} until EXPERIMENTS_PUSH_TOKEN
          // is set; surface that message rather than a bare status code.
          let detail = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { message?: string };
            if (body?.message) detail = body.message;
          } catch {
            /* non-JSON error body; keep the status code */
          }
          throw new Error(detail);
        }
        const data = (await res.json()) as Payload;
        if (cancelled) return;
        setPayload(data);
        setError(null);
        setFetchedAt(Date.now());

        // Prod only: batch-fetch natural-vs-step history for all ids in one request
        // (endpoint accepts ids=a,b). Failure here is non-fatal — cards fall back to
        // the pushed history array. Debounced to the 15s feed poll.
        if (historyAvailable()) {
          const ids = data.experiments.map((e) => e.id).filter((x): x is string => !!x);
          if (ids.length) {
            try {
              const hres = await fetch(
                `/api/experiments-history?ids=${ids.map(encodeURIComponent).join(',')}&max_points=120&t=${Date.now()}`,
                { cache: 'no-store' },
              );
              if (hres.ok) {
                const hbody = (await hres.json()) as {
                  series?: Record<
                    string,
                    { step: number | null; ts: string; metrics?: { natural?: number | null } }[]
                  >;
                };
                if (cancelled) return;
                const out: Record<string, HistPoint[]> = {};
                for (const [id, pts] of Object.entries(hbody.series ?? {})) {
                  out[id] = (pts ?? []).map((p) => ({
                    step: p.step,
                    natural: p.metrics?.natural ?? null,
                  }));
                }
                setSeries(out);
              }
            } catch {
              /* history unavailable this cycle; keep last series / array fallback */
            }
          }
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  const experiments = payload?.experiments ?? [];
  const runningCount = useMemo(
    () => experiments.filter((e) => e.status === 'running').length,
    [experiments],
  );

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: C.bg,
        overflow: 'auto',
        font: MONO,
        color: C.text,
      }}
    >
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '28px 24px 48px' }}>
        {/* header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 14,
            flexWrap: 'wrap',
            marginBottom: 6,
          }}
        >
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: C.text }}>
            DDR RL — training fleet
          </h1>
          <span style={{ color: C.muted, fontSize: 12 }}>
            {experiments.length} experiments · {runningCount} running
          </span>
          <button
            onClick={onExit}
            style={{
              marginLeft: 'auto',
              font: 'inherit',
              color: C.dim,
              background: 'transparent',
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: '4px 10px',
              cursor: 'pointer',
            }}
          >
            ESC — menu
          </button>
        </div>
        <div style={{ color: C.muted, fontSize: 11, marginBottom: 20 }}>
          {payload
            ? `generated ${ageLabel(payload.generated_at)} · polled ${ageLabel(new Date(fetchedAt).toISOString())} · refreshes every 15s`
            : `loading ${feedUrl()}…`}
          {error ? (
            <span style={{ color: C.stale }}> · fetch error: {error} (keeping last data)</span>
          ) : null}
        </div>

        {/* two-run overlay compare — prod hosts only (needs the history endpoint) */}
        {historyAvailable() ? (
          experiments.length > 0 ? (
            <OverlayCompare experiments={experiments} />
          ) : null
        ) : (
          <div style={{ color: C.muted, fontSize: 11, marginBottom: 20 }}>
            overlay comparison needs the production feed — history charts aren't available on
            local/tunnel hosts
          </div>
        )}

        {/* cards */}
        {experiments.length === 0 && !error ? (
          <div style={{ color: C.muted, fontSize: 13 }}>
            No experiments in the feed yet. Is experiments_status.py running?
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
              gap: 16,
            }}
          >
            {experiments.map((exp) => (
              <ExperimentCard
                key={exp.id ?? exp.name}
                exp={exp}
                hist={exp.id ? series[exp.id] : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
