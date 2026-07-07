/**
 * RENDER BENCHMARK screen, launched from Options. Runs the scenario suite
 * (bench/runner.ts) on a full-viewport canvas and reports frame-time and
 * CPU-draw statistics per scenario, with copyable JSON for comparing
 * machines. `?bench=auto` in the URL auto-starts a run (used by the
 * automated harness; also handy as a shareable link).
 */
import { useEffect, useRef, useState } from 'react';
import {
  BENCH_SCENARIOS,
  runBenchmark,
  type BenchProgress,
  type BenchResult,
  type ScenarioResult,
} from '../bench/runner';
import { STEP_AC as AC } from './Stage';
import { useMenuNav } from './useMenuNav';

type Phase = 'idle' | 'running' | 'done' | 'error';

const PANEL = 'border border-white/15 bg-black/70 backdrop-blur-[2px]';
/** Live progress overlay: solid (no backdrop-blur) so per-update repaints stay
 *  cheap even over a 4K field. */
const RUN_PANEL = 'border border-white/15 bg-black/85';
const BTN =
  'border px-4 py-1.5 text-[13px] tracking-[0.12em] text-[#ececec]/85 hover:text-[#ececec]';

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

/** How many of this scenario's frames fit one display-refresh interval, by the
 *  binding per-frame cost: real GPU time where measured, else the CPU draw. */
function headroom(s: ScenarioResult, refreshMs: number): number {
  const cost = s.gpuMs ? Math.max(s.gpuMs.avg, s.drawCpuMs.avg) : s.drawCpuMs.avg;
  return cost > 0 ? refreshMs / cost : 0;
}

function ResultsTable({ result }: { result: BenchResult }) {
  const refreshMs = 1000 / result.refreshHz;
  return (
    <table className="w-full border-collapse text-[12px] [font-variant-numeric:tabular-nums]">
      <thead>
        <tr className="text-left text-[10px] tracking-[0.14em] text-[#ececec]/40">
          <th className="py-1 pr-3 font-normal">SCENARIO</th>
          <th className="px-2 py-1 text-right font-normal">FPS</th>
          <th className="px-2 py-1 text-right font-normal">FRAME p95</th>
          <th className="px-2 py-1 text-right font-normal">MISSED</th>
          <th className="px-2 py-1 text-right font-normal">GPU/FRAME</th>
          <th className="px-2 py-1 text-right font-normal">GPU p95</th>
          <th className="px-2 py-1 text-right font-normal">CPU/FRAME</th>
          <th className="px-2 py-1 text-right font-normal">HEADROOM</th>
        </tr>
      </thead>
      <tbody>
        {result.scenarios.map((s) => (
          <tr key={s.id} className="border-t border-white/[0.08]">
            <td className="py-1.5 pr-3 text-[#ececec]/85">
              {s.label}
              {s.skipped && <span className="ml-2 text-[#ffcf3d]/80">SKIPPED — {s.skipped}</span>}
            </td>
            {s.skipped ? (
              <td colSpan={7} />
            ) : (
              <>
                <td className="px-2 py-1.5 text-right font-bold">{fmt(s.fps, 0)}</td>
                <td className="px-2 py-1.5 text-right">{fmt(s.frameMs.p95)} ms</td>
                <td
                  className="px-2 py-1.5 text-right"
                  style={s.missedPct > 2 ? { color: '#ff5d47' } : undefined}
                >
                  {fmt(s.missedPct)}%
                </td>
                <td className="px-2 py-1.5 text-right font-bold">
                  {s.gpuMs ? `${fmt(s.gpuMs.avg, 2)} ms` : '—'}
                </td>
                <td className="px-2 py-1.5 text-right">
                  {s.gpuMs ? `${fmt(s.gpuMs.p95, 2)} ms` : '—'}
                </td>
                <td className="px-2 py-1.5 text-right text-[#ececec]/60">
                  {fmt(s.drawCpuMs.avg, 2)} ms
                </td>
                <td className="px-2 py-1.5 text-right">×{fmt(headroom(s, refreshMs), 0)}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Benchmark({ onBack }: { onBack: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<BenchProgress | null>(null);
  const [result, setResult] = useState<BenchResult | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useMenuNav(onBack);

  const run = async () => {
    const container = containerRef.current;
    if (!container || phase === 'running') return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setPhase('running');
    setResult(null);
    setProgress(null);
    setError('');
    try {
      // ?only=<substring> narrows the suite (fast iteration / automation).
      const only = new URLSearchParams(location.search).get('only');
      const r = await runBenchmark({
        container,
        signal: abort.signal,
        onProgress: setProgress,
        scenarios: only ? BENCH_SCENARIOS.filter((s) => s.id.includes(only)) : undefined,
      });
      setResult(r);
      setPhase('done');
      // Automation + easy sharing: full results on the console and window.
      (window as unknown as { __benchResult?: BenchResult }).__benchResult = r;
      console.log('[bench]', JSON.stringify(r));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  };

  // Cancel a live run when the screen unmounts; ?bench=auto starts one.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (new URLSearchParams(location.search).get('bench') === 'auto') void runRef.current();
    return () => abortRef.current?.abort();
  }, []);

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions) — the console has the same JSON.
    }
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#050506] font-grotesk text-[#ececec] [font-variant-numeric:tabular-nums]">
      {/* The runner creates its canvases in here (fresh element per scenario). */}
      <div ref={containerRef} className="absolute inset-0" />

      {phase === 'running' && progress && (
        // No backdrop-blur: at 4K it re-samples the whole field behind the
        // panel on every ~400ms update (an ~18ms raster). Fixed width + a
        // fixed 3-line layout (FPS line always present) so updating the text
        // never resizes the panel — no layout shift either.
        <div className={`absolute right-4 top-4 z-[2] w-[240px] px-4 py-2 ${RUN_PANEL}`}>
          <div className="truncate text-[11px] tracking-[0.18em] text-[#ececec]/60">
            BENCHMARK {progress.scenarioIndex + 1}/{progress.scenarioCount} ·{' '}
            {progress.phase.toUpperCase()}
          </div>
          <div className="truncate text-[13px]">{progress.label}</div>
          <div className="text-[13px] font-bold">{fmt(progress.liveFps, 0)} FPS</div>
        </div>
      )}

      {phase !== 'running' && (
        <div className="absolute inset-0 z-[2] flex items-center justify-center p-6">
          <div className={`max-h-full w-[860px] max-w-full overflow-y-auto p-6 ${PANEL}`}>
            <div className="mb-1 flex items-baseline gap-3">
              <span className="text-[19px] font-bold tracking-[0.22em]">RENDER BENCHMARK</span>
              <span className="text-[12px] tracking-[0.14em] text-[#ececec]/45">
                ~30s · full-screen synthetic gameplay
              </span>
            </div>

            {phase === 'idle' && (
              <p className="mb-4 mt-3 max-w-[560px] text-[13px] leading-relaxed text-[#ececec]/60">
                Measures the WebGPU note field on this machine: the arcade field on a typical hard
                chart, a beyond-worst-case stress chart, the stress chart with a background image
                composited behind it, and the ITG skin on the same stress chart. Results can be
                copied as JSON to compare computers.
              </p>
            )}

            {phase === 'error' && (
              <p className="mb-4 mt-3 text-[13px]" style={{ color: AC }}>
                Benchmark failed: {error}
              </p>
            )}

            {phase === 'done' && result && (
              <>
                <div className="mb-3 mt-2 text-[11px] leading-relaxed text-[#ececec]/45">
                  {result.device.webglRenderer ?? 'unknown GPU'} · {fmt(result.refreshHz, 0)} Hz
                  display · {result.view.width}×{result.view.height} @dpr {result.view.dpr} ·{' '}
                  {result.device.webgpu
                    ? `WebGPU: ${result.device.webgpu.vendor} ${result.device.webgpu.architecture}`.trim()
                    : 'WebGPU unavailable'}
                </div>
                <ResultsTable result={result} />
                <p className="mt-3 text-[11px] leading-relaxed text-[#ececec]/40">
                  FPS + frame p95/missed = what the player sees, normally capped at this
                  display&apos;s refresh ({fmt(result.refreshHz, 0)} Hz). GPU/FRAME = the real GPU
                  time of each presented frame (WebGPU timestamp query) — the honest per-frame cost.
                  CPU/FRAME = main-thread encode time per draw(). HEADROOM = how many of these
                  frames fit one refresh interval ({fmt(1000 / result.refreshHz, 1)} ms) at the
                  binding cost.
                </p>
              </>
            )}

            <div className="mt-5 flex items-center gap-3">
              <button onClick={() => void run()} className={BTN} style={{ borderColor: AC }}>
                {phase === 'done' ? 'RUN AGAIN' : 'START'}
              </button>
              {phase === 'done' && (
                <button
                  onClick={() => void copy()}
                  className={`${BTN} border-white/15`}
                  style={copied ? { borderColor: '#59f07f', color: '#59f07f' } : undefined}
                >
                  {copied ? 'COPIED ✓' : 'COPY JSON'}
                </button>
              )}
              <span className="flex-1" />
              <button onClick={onBack} className={`${BTN} border-white/15`}>
                ← OPTIONS
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <button
          onClick={() => {
            abortRef.current?.abort();
            setPhase('idle');
          }}
          className={`absolute bottom-4 left-4 z-[2] ${BTN} border-white/15 bg-black/50`}
        >
          CANCEL
        </button>
      )}
    </div>
  );
}
