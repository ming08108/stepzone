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
const BTN =
  'border px-4 py-1.5 text-[13px] tracking-[0.12em] text-[#ececec]/85 hover:text-[#ececec]';

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

/** Frame-budget headroom: how many times over the canvas could draw at 60Hz. */
function headroom(s: ScenarioResult): number {
  return s.drawCpuMs.avg > 0 ? 16.7 / s.drawCpuMs.avg : 0;
}

function ResultsTable({ result }: { result: BenchResult }) {
  return (
    <table className="w-full border-collapse text-[12px] [font-variant-numeric:tabular-nums]">
      <thead>
        <tr className="text-left text-[10px] tracking-[0.14em] text-[#ececec]/40">
          <th className="py-1 pr-3 font-normal">SCENARIO</th>
          <th className="px-2 py-1 text-right font-normal">FPS</th>
          <th className="px-2 py-1 text-right font-normal">FRAME p95</th>
          <th className="px-2 py-1 text-right font-normal">MISSED</th>
          <th className="px-2 py-1 text-right font-normal">DRAW CPU avg</th>
          <th className="px-2 py-1 text-right font-normal">DRAW p99</th>
          <th className="px-2 py-1 text-right font-normal">MAX DRAWS/S</th>
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
                <td className="px-2 py-1.5 text-right">{fmt(s.drawCpuMs.avg, 2)} ms</td>
                <td className="px-2 py-1.5 text-right">{fmt(s.drawCpuMs.p99, 2)} ms</td>
                <td className="px-2 py-1.5 text-right">{fmt(s.satDrawsPerSec, 0)}</td>
                <td className="px-2 py-1.5 text-right">×{fmt(headroom(s), 1)}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Per-pass CPU breakdown for the heaviest non-skipped scenario. */
function PassBreakdown({ result }: { result: BenchResult }) {
  const ranked = result.scenarios
    .filter((s) => !s.skipped)
    .sort((a, b) => b.drawCpuMs.avg - a.drawCpuMs.avg);
  const worst = ranked[0];
  if (!worst) return null;
  const entries = Object.entries(worst.passes).sort((a, b) => b[1] - a[1]);
  const total = Math.max(0.0001, worst.drawCpuMs.avg);
  return (
    <div className="mt-4">
      <div className="mb-1 text-[10px] tracking-[0.14em] text-[#ececec]/40">
        WHERE THE CPU TIME GOES — {worst.label} ({fmt(worst.avgTapsPerFrame, 0)} arrows,{' '}
        {fmt(worst.avgHoldsPerFrame, 0)} holds, {fmt(worst.avgMinesPerFrame, 0)} mines on screen)
      </div>
      {entries.map(([key, ms]) => (
        <div key={key} className="flex items-center gap-2 py-0.5 text-[11px]">
          <span className="w-[90px] flex-none text-[#ececec]/60">{key}</span>
          <div className="h-[8px] flex-1 bg-white/[0.06]">
            <div
              className="h-full"
              style={{
                width: `${Math.min(100, (100 * ms) / total)}%`,
                background: AC,
                opacity: 0.75,
              }}
            />
          </div>
          <span className="w-[72px] flex-none text-right [font-variant-numeric:tabular-nums]">
            {fmt(ms, 3)} ms
          </span>
        </div>
      ))}
    </div>
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
        <div className={`absolute right-4 top-4 z-[2] px-4 py-2 ${PANEL}`}>
          <div className="text-[11px] tracking-[0.18em] text-[#ececec]/60">
            BENCHMARK {progress.scenarioIndex + 1}/{progress.scenarioCount} ·{' '}
            {progress.phase.toUpperCase()}
          </div>
          <div className="text-[13px]">{progress.label}</div>
          {progress.phase !== 'saturate' && (
            <div className="text-[13px] font-bold">{fmt(progress.liveFps, 0)} FPS</div>
          )}
        </div>
      )}

      {phase !== 'running' && (
        <div className="absolute inset-0 z-[2] flex items-center justify-center p-6">
          <div className={`max-h-full w-[860px] max-w-full overflow-y-auto p-6 ${PANEL}`}>
            <div className="mb-1 flex items-baseline gap-3">
              <span className="text-[19px] font-bold tracking-[0.22em]">RENDER BENCHMARK</span>
              <span className="text-[12px] tracking-[0.14em] text-[#ececec]/45">
                ~40s · full-screen synthetic gameplay
              </span>
            </div>

            {phase === 'idle' && (
              <p className="mb-4 mt-3 max-w-[560px] text-[13px] leading-relaxed text-[#ececec]/60">
                Measures note-field rendering on this machine: the WebGPU arcade field on a typical
                hard chart, a beyond-worst-case stress chart, and the stress chart with a background
                image composited behind it — plus the ITG skin&apos;s canvas renderer on the same
                stress chart. Results can be copied as JSON to compare computers.
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
                <PassBreakdown result={result} />
                <p className="mt-3 text-[11px] leading-relaxed text-[#ececec]/40">
                  FPS + frame p95/missed = what the player sees (vsync-bound). DRAW CPU = main-
                  thread time recording canvas commands; rasterization runs in the GPU process, so
                  low CPU with missed frames points at the GPU side. HEADROOM = 60Hz budget ÷ draw
                  CPU.
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
