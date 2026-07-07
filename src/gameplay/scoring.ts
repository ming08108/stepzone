/**
 * Scoring weights, life deltas, and grades. Values are the verified ITGmania
 * fallback-theme defaults (spec doc 4 §4.6, §4.8), diffed against the ITGmania
 * source (Player.cpp / ScoreKeeperNormal.cpp / _fallback metrics). Combo matches
 * ITG dance: one per tap, but a jump's continue/break is decided by its worst
 * tap (judge.ts). Not yet modeled: the merciful/progressive LifeDifficulty
 * scaling (we use the raw per-judgment life deltas).
 */

import { HoldNoteScore, TapNoteScore } from '../notes/noteTypes';

/** Dance-point weight (drives the % score). */
export function tapDancePoints(tns: TapNoteScore): number {
  switch (tns) {
    case TapNoteScore.W1:
      return 3;
    case TapNoteScore.W2:
      return 2;
    case TapNoteScore.W3:
      return 1;
    case TapNoteScore.HitMine:
      return -2;
    default:
      return 0; // W4, W5, Miss, AvoidMine, None
  }
}

export function holdDancePoints(hns: HoldNoteScore): number {
  return hns === HoldNoteScore.Held ? 3 : 0;
}

/** Grade-point weight (drives the letter grade, separate from the %). */
export function tapGradePoints(tns: TapNoteScore): number {
  switch (tns) {
    case TapNoteScore.W1:
      return 2;
    case TapNoteScore.W2:
      return 2;
    case TapNoteScore.W3:
      return 1;
    case TapNoteScore.W5:
      return -4;
    case TapNoteScore.Miss:
      return -8;
    case TapNoteScore.HitMine:
      return -8;
    default:
      return 0; // W4, AvoidMine, None
  }
}

export function holdGradePoints(hns: HoldNoteScore): number {
  return hns === HoldNoteScore.Held ? 6 : 0;
}

/** Life change as a fraction of the full bar. */
export function tapLifeDelta(tns: TapNoteScore): number {
  switch (tns) {
    case TapNoteScore.W1:
    case TapNoteScore.W2:
      return 0.008;
    case TapNoteScore.W3:
      return 0.004;
    case TapNoteScore.W4:
      return 0;
    case TapNoteScore.W5:
      return -0.04;
    case TapNoteScore.Miss:
      return -0.08;
    case TapNoteScore.HitMine:
      return -0.16;
    default:
      return 0;
  }
}

export function holdLifeDelta(hns: HoldNoteScore): number {
  switch (hns) {
    case HoldNoteScore.Held:
      return 0.008;
    case HoldNoteScore.LetGo:
      return -0.08;
    default:
      return 0;
  }
}

export const GRADE_TIERS: ReadonlyArray<{ min: number; name: string }> = [
  { min: 1.0, name: 'AAA' },
  { min: 0.93, name: 'AA' },
  { min: 0.8, name: 'A' },
  { min: 0.65, name: 'B' },
  { min: 0.45, name: 'C' },
  { min: -Infinity, name: 'D' },
];

export function gradeFromPercent(percent: number): string {
  for (const tier of GRADE_TIERS) if (percent >= tier.min) return tier.name;
  return 'D';
}
