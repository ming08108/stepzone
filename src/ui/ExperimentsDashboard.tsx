import { useEffect, useMemo, useState } from 'react';

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

type ExpStatus = 'running' | 'stale' | 'dead' | 'unreachable' | 'provisioning';

interface Experiment {
  id?: string; // stable identity (e.g. "vast:45329658" / "local:...")
  name: string;
  desc?: string | null;
  status: ExpStatus;
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
  spark: '#8fead0',
} as const;

const MONO = '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace';

const STATUS_META: Record<ExpStatus, { color: string; label: string }> = {
  running: { color: C.running, label: 'running' },
  stale: { color: C.stale, label: 'stale' },
  dead: { color: C.dead, label: 'dead' },
  unreachable: { color: C.dead, label: 'unreachable' },
  provisioning: { color: C.prov, label: 'provisioning' },
};

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
function Sparkline({ data }: { data: number[] }) {
  const W = 168;
  const H = 34;
  const pts = data.filter((v) => Number.isFinite(v));
  if (pts.length < 2) {
    return (
      <div style={{ height: H, display: 'flex', alignItems: 'center' }}>
        <span style={{ color: C.muted, fontSize: 11 }}>no history yet</span>
      </div>
    );
  }
  // natural is a 0..1 rate; frame the plot to the data's own range with padding
  // so a flat-but-nonzero series still reads.
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const pad = span * 0.12;
  const y0 = lo - pad;
  const y1 = hi + pad;
  const yr = y1 - y0 || 1;
  const x = (i: number) => (i / (pts.length - 1)) * (W - 2) + 1;
  const y = (v: number) => H - 2 - ((v - y0) / yr) * (H - 4);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `1,${H - 1} ${line} ${(W - 1).toFixed(1)},${H - 1}`;
  return (
    <svg width={W} height={H} style={{ display: 'block' }} aria-hidden>
      <polygon points={area} fill={C.spark} opacity={0.1} />
      <polyline points={line} fill="none" stroke={C.spark} strokeWidth={1.5} opacity={0.9} />
      <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1])} r={2.2} fill={C.spark} />
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

function ExperimentCard({ exp }: { exp: Experiment }) {
  const meta = STATUS_META[exp.status] ?? STATUS_META.dead;
  const ws = wsUrlFor(exp);
  const clickable = ws != null && exp.status !== 'provisioning';
  const m = exp.metrics ?? {};
  const hasTiers = m.tier_perfect != null || m.tier_great != null;

  const open = () => {
    if (!clickable || !ws) return;
    // Same tab, same query-param convention the app uses (App.tsx routes on
    // ?isaacviewer; IsaacViewer reads ?ws=).
    location.href = `${location.pathname}?isaacviewer&ws=${encodeURIComponent(ws)}`;
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
          <span style={{ color: meta.color, fontSize: 10, letterSpacing: 0.3 }}>{meta.label}</span>
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

      {/* sparkline of natural */}
      <div>
        <span style={{ color: C.muted, fontSize: 10, letterSpacing: 0.3 }}>natural (last N)</span>
        <Sparkline data={exp.history ?? []} />
      </div>
    </div>
  );
}

export function ExperimentsDashboard({ onExit }: { onExit: () => void }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number>(0);

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
              <ExperimentCard key={exp.id ?? exp.name} exp={exp} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
