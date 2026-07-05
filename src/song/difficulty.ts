/** Difficulty slots and the legacy name aliases. See spec doc 5 (§5.5). */

import { DIFFICULTY_SLOT_NAMES, difficultyAliasToSlot } from './difficultyAliases';

export enum Difficulty {
  Beginner,
  Easy,
  Medium,
  Hard,
  Challenge,
  Edit,
  Invalid,
}

// Slot names/aliases live in difficultyAliases.ts (enum-free) so the Node-side
// catalog scripts can share them; enum values match the slot indices there.
const CANONICAL: readonly string[] = DIFFICULTY_SLOT_NAMES;

export function difficultyToString(d: Difficulty): string {
  return d >= 0 && d < CANONICAL.length ? CANONICAL[d] : 'Invalid';
}

/** New-style (`.ssc`) names, case-insensitive. */
export function stringToDifficulty(s: string): Difficulty {
  const lower = s.trim().toLowerCase();
  const idx = CANONICAL.findIndex((n) => n.toLowerCase() === lower);
  return idx >= 0 ? (idx as Difficulty) : Difficulty.Invalid;
}

/** Legacy DDR/ITG aliases used in `.sm` `#NOTES` difficulty fields. */
export function oldStyleStringToDifficulty(s: string): Difficulty {
  const slot = difficultyAliasToSlot(s);
  return slot >= 0 ? (slot as Difficulty) : Difficulty.Invalid;
}
