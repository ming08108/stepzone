/** Difficulty slots and the legacy name aliases. See spec doc 5 (§5.5). */

export enum Difficulty {
  Beginner,
  Easy,
  Medium,
  Hard,
  Challenge,
  Edit,
  Invalid,
}

const CANONICAL: readonly string[] = ['Beginner', 'Easy', 'Medium', 'Hard', 'Challenge', 'Edit'];

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
  switch (s.trim().toLowerCase()) {
    case 'beginner':
      return Difficulty.Beginner;
    case 'easy':
    case 'basic':
    case 'light':
      return Difficulty.Easy;
    case 'medium':
    case 'another':
    case 'trick':
    case 'standard':
    case 'difficult':
      return Difficulty.Medium;
    case 'hard':
    case 'ssr':
    case 'maniac':
    case 'heavy':
      return Difficulty.Hard;
    case 'smaniac':
    case 'challenge':
    case 'expert':
    case 'oni':
      return Difficulty.Challenge;
    case 'edit':
      return Difficulty.Edit;
    default:
      return Difficulty.Invalid;
  }
}
