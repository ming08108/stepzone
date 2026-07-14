/**
 * Dancer test harness (dev tool): the attract dance background on its own,
 * with the dancer driven by the arrow keys so you can eyeball the animation
 * and footwork without loading a song. Reachable at `?dancer` (see App) and
 * from a hidden link in OPTIONS.
 *
 * ←↓↑→ step that panel · Space = jump (both feet) · V = cycle mood · Esc = exit.
 * Steps are injected a fraction of a beat ahead (the clip scheduler wants a
 * little wind-up), landing on a steady internal beat the dancer grooves to.
 */
import { useEffect, useRef } from 'react';
import { GpuNoteField } from '../render/gpu/gpuNoteField';
import { NoteData } from '../notes/noteData';
import { Judge } from '../gameplay/judge';
import { DEFAULT_WINDOWS } from '../gameplay/windows';
import { TimingData } from '../timing/timingData';
import { columnAnglesFor } from '../render/columns';
import type { Feedback } from '../render/types';

const BPM = 128;
const LOOKAHEAD = 0.28; // beats of wind-up before a keyed step lands
// A jump needs its whole pre-impact arc (anticipation crouch → takeoff → rise)
// to actually render: the clip's impact (landing) keyframe is ~0.65 of the way
// in, so it wants ~1.1 beats of lead. With the short step lookahead the
// scheduler places the clip start in the PAST and skips straight to the apex —
// no wind-up, no takeoff, so the hop reads weightless. Give jumps their own,
// longer lead so the full gravity arc plays. (Attract-mode/chart jumps already
// get this via the scheduler's wind-up window; only the manual test-jump was
// truncated.)
const JUMP_LOOKAHEAD = 1.6;

export function DancerTest({ onExit }: { onExit: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // `?dancer&model=0` forces the light procedural dancer (skips the 3D avatar) —
  // handy for eyeballing the source animation itself, apart from retargeting.
  const useModel = new URLSearchParams(location.search).get('model') !== '0';

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let cancelled = false;
    let raf = 0;
    let gpuField: GpuNoteField | null = null;
    let ro: ResizeObserver | null = null;
    let variant = 0;

    const nd = new NoteData(4); // empty chart — no notes, just the dancer + bg
    const timing = new TimingData();
    timing.bpms.push({ row: 0, bps: BPM / 60 });
    timing.tidy();
    const judge = new Judge(nd, timing, DEFAULT_WINDOWS, 1);
    const feedback: Feedback = {
      lastJudgment: null,
      laneFlash: new Array<number>(4).fill(-999),
      laneHit: new Array<Feedback['laneHit'][number]>(4).fill(null),
    };
    const held = new Array<boolean>(4).fill(false);
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const resize = () =>
      gpuField?.resize(canvas.clientWidth || 300, canvas.clientHeight || 400, dpr);

    let t0 = 0;
    const beatAt = (t: number) => (t0 ? ((t - t0) / 1000) * (BPM / 60) : 0);

    // Panel → (column mask, which foot). -1 lets the dancer's heuristic pick.
    const PANELS: Record<string, { cols: number; l: number; r: number }> = {
      ArrowLeft: { cols: 1 << 0, l: 0, r: -1 },
      ArrowDown: { cols: 1 << 1, l: -1, r: -1 },
      ArrowUp: { cols: 1 << 2, l: -1, r: -1 },
      ArrowRight: { cols: 1 << 3, l: -1, r: 3 },
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onExit();
      if (!gpuField) return;
      const now = beatAt(performance.now());
      const at = now + LOOKAHEAD;
      if (e.key === ' ') {
        // full pre-impact lead so the wind-up + takeoff actually render
        gpuField.pushAttractStep(now + JUMP_LOOKAHEAD, (1 << 0) | (1 << 3), 0, 3); // jump: both feet
        e.preventDefault();
      } else if (e.key === 'v' || e.key === 'V') {
        variant = (variant + 1) % 4;
        gpuField.setAttract({ variant, steps: [], model: useModel });
      } else if (PANELS[e.key]) {
        const p = PANELS[e.key];
        gpuField.pushAttractStep(at, p.cols, p.l, p.r);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);

    const frame = (t: number) => {
      if (!t0) t0 = t;
      const now = (t - t0) / 1000;
      judge.update(now, held);
      gpuField?.draw(judge, now, beatAt(t), 0, feedback);
      raf = requestAnimationFrame(frame);
    };

    void (async () => {
      gpuField = await GpuNoteField.create(canvas, 4, {
        columnAngles: columnAnglesFor('dance-single', 4),
        bare: true,
        bgDim: 0.15,
        scrollMode: 'X',
        scrollValue: 2,
        noteSkin: 'arcade',
      });
      if (cancelled || !gpuField) {
        gpuField?.destroy();
        gpuField = null;
        return;
      }
      gpuField.setAttract({ variant, steps: [], model: useModel });
      resize();
      ro = new ResizeObserver(() => resize());
      ro.observe(canvas);
      raf = requestAnimationFrame(frame);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      ro?.disconnect();
      gpuField?.destroy();
    };
  }, [onExit, useModel]);

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <canvas ref={ref} className="block h-full w-full" />
      <div className="pointer-events-none absolute left-4 top-4 rounded border border-white/15 bg-black/50 px-3 py-1.5 font-mono text-[12px] tracking-wide text-white/80">
        DANCER TEST — ←↓↑→ step · Space jump · V mood · Esc exit
      </div>
    </div>
  );
}
