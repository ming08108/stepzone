/** Judgment timing windows (seconds). Defaults from spec doc 4 (§4.1). */

export interface TimingWindows {
  /**
   * Simply Love's "FA+" white-Fantastic window: a hit inside it scores exactly
   * the same W1 as a wider (blue) Fantastic, but is shown white — a display-only
   * precision tier, never used for scoring or the miss ladder.
   */
  w0: number;
  w1: number;
  w2: number;
  w3: number;
  w4: number;
  w5: number;
  mine: number;
  hold: number;
  roll: number;
  /** Global multiplier applied to every window (the "judge difficulty" slider). */
  scale: number;
  /** Global constant added to every window. */
  add: number;
}

export const DEFAULT_WINDOWS: TimingWindows = {
  w0: 0.0115,
  w1: 0.0225,
  w2: 0.045,
  w3: 0.09,
  w4: 0.135,
  w5: 0.18,
  mine: 0.09,
  hold: 0.25,
  roll: 0.5,
  scale: 1,
  add: 0,
};

export type WindowKey = 'w0' | 'w1' | 'w2' | 'w3' | 'w4' | 'w5' | 'mine' | 'hold' | 'roll';

/** Effective window in seconds: base * scale + add. */
export function windowSeconds(w: TimingWindows, key: WindowKey): number {
  return w[key] * w.scale + w.add;
}

/**
 * The tap miss horizon in seconds: the widest *hit* window (w5) or the mine
 * window. Deliberately excludes the hold/roll drop-timers — those govern how
 * long an in-progress hold survives, not when an un-hit tap becomes a Miss.
 * Conflating them delayed misses to ~0.5s and let a stale note swallow presses
 * aimed at the next note.
 */
export function missHorizonSeconds(w: TimingWindows): number {
  return Math.max(windowSeconds(w, 'w5'), windowSeconds(w, 'mine'));
}
