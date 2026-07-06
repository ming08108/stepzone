/**
 * Per-pass CPU timing for the render benchmark: wraps a Theme so every hook
 * call accumulates its main-thread time into a named bucket. Costs the
 * wrapped run two performance.now() calls per hook — negligible next to the
 * canvas work being measured, and identical across scenarios so comparisons
 * stay fair. Note this measures CPU-side command recording only: the actual
 * rasterization happens in the browser's GPU process and shows up in the
 * frame-time (vsync) numbers instead.
 */

import type { Theme } from '../render/theme';

export type PassKey =
  'chrome' | 'hudUnderlay' | 'receptors' | 'taps' | 'mines' | 'holds' | 'explosions' | 'hudOverlay';

export type PassTotals = Record<PassKey, number>;

export function emptyPassTotals(): PassTotals {
  return {
    chrome: 0,
    hudUnderlay: 0,
    receptors: 0,
    taps: 0,
    mines: 0,
    holds: 0,
    explosions: 0,
    hudOverlay: 0,
  };
}

/** Wrap a Theme so each hook adds its elapsed ms into `totals`. */
export function instrumentTheme(theme: Theme, totals: PassTotals): Theme {
  const timed = <A extends unknown[]>(key: PassKey, fn: (...args: A) => void) => {
    return (...args: A): void => {
      const t0 = performance.now();
      fn(...args);
      totals[key] += performance.now() - t0;
    };
  };
  return {
    quantColor: theme.quantColor,
    judgments: theme.judgments,
    explosionSeconds: theme.explosionSeconds,
    receptorOffset: theme.receptorOffset,
    fieldLeft: theme.fieldLeft.bind(theme),
    drawFieldChrome: timed('chrome', theme.drawFieldChrome.bind(theme)),
    drawHudUnderlay: timed('hudUnderlay', theme.drawHudUnderlay.bind(theme)),
    drawReceptor: timed('receptors', theme.drawReceptor.bind(theme)),
    drawTapNote: timed('taps', theme.drawTapNote.bind(theme)),
    drawMine: timed('mines', theme.drawMine.bind(theme)),
    drawHoldBody: timed('holds', theme.drawHoldBody.bind(theme)),
    drawExplosion: timed('explosions', theme.drawExplosion.bind(theme)),
    drawHudOverlay: timed('hudOverlay', theme.drawHudOverlay.bind(theme)),
  };
}
