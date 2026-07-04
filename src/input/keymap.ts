/**
 * Keyboard -> note column for dance-single. A key is not a column: this is the
 * (tiny) Style table (spec doc 7). Columns are L D U R = 0 1 2 3.
 */

export const DANCE_SINGLE_KEYMAP: Readonly<Record<string, number>> = {
  ArrowLeft: 0,
  ArrowDown: 1,
  ArrowUp: 2,
  ArrowRight: 3,
  // Secondary home-row layout (D F J K).
  KeyD: 0,
  KeyF: 1,
  KeyJ: 2,
  KeyK: 3,
};

/** Column for a KeyboardEvent.code, or undefined if unmapped. */
export function keyToColumn(
  code: string,
  keymap: Readonly<Record<string, number>> = DANCE_SINGLE_KEYMAP,
): number | undefined {
  return keymap[code];
}

/** Column labels for the receptors (dance-single order). */
export const DANCE_SINGLE_LABELS = ['←', '↓', '↑', '→'] as const;
