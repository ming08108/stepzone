/** Judgment timing windows (seconds). Defaults from spec doc 4 (§4.1). */

export interface TimingWindows {
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

type WindowKey = 'w1' | 'w2' | 'w3' | 'w4' | 'w5' | 'mine' | 'hold' | 'roll';

/** Effective window in seconds: base * scale + add. */
export function windowSeconds(w: TimingWindows, key: WindowKey): number {
  return w[key] * w.scale + w.add;
}

/** The widest window (the miss horizon). */
export function maxWindowSeconds(w: TimingWindows): number {
  return Math.max(
    windowSeconds(w, 'w5'),
    windowSeconds(w, 'mine'),
    windowSeconds(w, 'hold'),
    windowSeconds(w, 'roll'),
  );
}
