/**
 * Live gameplay telemetry for the DOM HUD.
 *
 * The note field runs at display rate on the GPU; the HUD does not need to.
 * This samples the running GameSession at HUD_HZ and hands React a plain
 * snapshot, so the panels re-render ~15×/s instead of 60×/s and the render loop
 * is never blocked by layout. Nothing here mutates the session.
 *
 * Everything read is already computed by the engine — no new work per frame:
 *   judge.percentDancePoints / grade / combo / maxCombo / life / failed / tapCounts
 *   session.offsets   (every judged tap's signed error, seconds)
 *   session.songNow   (audio-clock song position)
 */
import { useEffect, useRef, useState } from 'react';
import type { GameSession } from '../../game/session';

/** HUD sample rate. Fast enough that the percent never looks stuck, slow
 *  enough that it costs nothing next to a 60–240 Hz field. */
export const HUD_HZ = 15;

/** How many recent taps the timing bar shows. ~6s of a 12 NPS stream. */
export const TIMING_WINDOW = 40;

export interface HudTelemetry {
  percent: number;
  grade: string;
  combo: number;
  maxCombo: number;
  /** 0..1; 0 once failed. */
  life: number;
  failed: boolean;
  /** TapNoteScore -> count. */
  counts: Record<number, number>;
  /** The last TIMING_WINDOW tap errors, in milliseconds (− early, + late). */
  recentMs: number[];
  /** Mean of `recentMs`, or null before any taps land. */
  meanMs: number | null;
  /** Song position in seconds (negative during lead-in). */
  elapsed: number;
}

const EMPTY: HudTelemetry = {
  percent: 0,
  grade: 'D',
  combo: 0,
  maxCombo: 0,
  life: 0.5,
  failed: false,
  counts: {},
  recentMs: [],
  meanMs: null,
  elapsed: 0,
};

export function useHudTelemetry(
  sessionRef: React.RefObject<GameSession | null>,
  active: boolean,
): HudTelemetry {
  const [t, setT] = useState<HudTelemetry>(EMPTY);
  // Keep the ref out of the effect deps — it is stable, and re-subscribing on
  // every sample would defeat the whole point.
  const ref = useRef(sessionRef);
  ref.current = sessionRef;

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(
      () => {
        const s = ref.current.current;
        if (!s) return;
        const j = s.judge;
        const recentMs = s.offsets.slice(-TIMING_WINDOW).map((o) => o * 1000);
        const meanMs =
          recentMs.length > 0 ? recentMs.reduce((a, b) => a + b, 0) / recentMs.length : null;
        setT({
          percent: Math.max(0, Math.min(1, j.percentDancePoints)),
          grade: j.grade,
          combo: j.combo,
          maxCombo: j.maxCombo,
          life: j.failed ? 0 : Math.max(0, Math.min(1, j.life)),
          failed: j.failed,
          // Copied, not aliased: tapCounts is mutated in place by the judge.
          counts: { ...j.tapCounts },
          recentMs,
          meanMs,
          elapsed: s.songNow,
        });
      },
      Math.round(1000 / HUD_HZ),
    );
    return () => window.clearInterval(id);
  }, [active]);

  return t;
}
