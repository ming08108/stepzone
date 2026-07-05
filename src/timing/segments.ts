/**
 * Timing segment records. See spec doc 2 (§2.2).
 *
 * Every segment stores its position as an integer note row. Only BPM/Stop/
 * Delay/Warp participate in the beat<->time conversion; the rest are metadata
 * or purely visual (Scroll/Speed).
 */

export interface BpmSegment {
  row: number;
  /** Beats per second (BPM / 60). Stored as BPS to match the engine internals. */
  bps: number;
}

export interface StopSegment {
  row: number;
  /** Seconds to freeze. Applied *after* this row's notes are reachable. */
  seconds: number;
}

export interface DelaySegment {
  row: number;
  /** Seconds to freeze. Applied *before* this row's notes become current. */
  seconds: number;
}

export interface WarpSegment {
  row: number;
  /** Number of rows skipped (consuming zero real time). */
  lengthRows: number;
}

export interface ScrollSegment {
  row: number;
  /**
   * Visual scroll multiplier (0 = arrows stack up). Never affects timing.
   * Parsed and stored, but not yet consumed by the renderer.
   */
  ratio: number;
}

export type SpeedUnit = 'beats' | 'seconds';

export interface SpeedSegment {
  row: number;
  ratio: number;
  /** Ramp length in `unit`. */
  delay: number;
  unit: SpeedUnit;
}

export interface TimeSignatureSegment {
  row: number;
  numerator: number;
  denominator: number;
}

export interface TickcountSegment {
  row: number;
  ticks: number;
}

export interface ComboSegment {
  row: number;
  combo: number;
  missCombo: number;
}

export interface LabelSegment {
  row: number;
  label: string;
}

export interface FakeSegment {
  row: number;
  lengthRows: number;
}

/** Sort any segment list ascending by row (stable). */
export function sortByRow<T extends { row: number }>(segs: T[]): T[] {
  return segs.sort((a, b) => a.row - b.row);
}
