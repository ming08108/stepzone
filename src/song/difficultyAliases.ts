/**
 * Canonical difficulty-alias tables shared by the engine
 * (`src/song/difficulty.ts`) and the Node-side catalog scripts
 * (`scripts/songLibrary.ts`), so the two cannot drift.
 *
 * ENUM-FREE ON PURPOSE: the scripts run under plain `node` with type
 * stripping (Node >= 22.6), which cannot execute TypeScript enums. Keep this
 * module to plain const objects/arrays/functions only.
 */

/**
 * Canonical display names by slot index. Indices match the `Difficulty` enum
 * in `src/song/difficulty.ts` (Beginner=0 ... Edit=5).
 */
export const DIFFICULTY_SLOT_NAMES = [
  'Beginner',
  'Easy',
  'Medium',
  'Hard',
  'Challenge',
  'Edit',
] as const;

/**
 * Legacy DDR/ITG difficulty aliases (lowercase) -> slot index, mirroring
 * StepMania/ITGmania's `OldStyleStringToDifficulty`, plus `novice`, which the
 * DDR lineage uses as a Beginner display name (and simfiles in the wild use
 * in `#NOTES` difficulty fields).
 */
export const DIFFICULTY_ALIAS_TO_SLOT: Readonly<Record<string, number>> = {
  beginner: 0,
  novice: 0,
  easy: 1,
  basic: 1,
  light: 1,
  medium: 2,
  another: 2,
  trick: 2,
  standard: 2,
  difficult: 2,
  hard: 3,
  ssr: 3,
  maniac: 3,
  heavy: 3,
  smaniac: 4,
  challenge: 4,
  expert: 4,
  oni: 4,
  edit: 5,
};

/** Alias -> slot index (case/whitespace-insensitive); -1 when unknown. */
export function difficultyAliasToSlot(name: string): number {
  return DIFFICULTY_ALIAS_TO_SLOT[name.trim().toLowerCase()] ?? -1;
}
