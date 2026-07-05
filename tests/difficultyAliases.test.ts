import { describe, expect, it } from 'vitest';
import {
  DIFFICULTY_ALIAS_TO_SLOT,
  DIFFICULTY_SLOT_NAMES,
  difficultyAliasToSlot,
} from '../src/song/difficultyAliases';
import {
  Difficulty,
  difficultyToString,
  oldStyleStringToDifficulty,
  stringToDifficulty,
} from '../src/song/difficulty';

/**
 * Guards code-review finding #9: the catalog scripts and the engine must share
 * one difficulty-alias table (no 'novice' drift, no "Expert" slot-4 label).
 */
describe('shared difficulty alias table (engine <-> catalog agreement)', () => {
  it('engine oldStyleStringToDifficulty agrees with the shared table for every alias', () => {
    for (const [alias, slot] of Object.entries(DIFFICULTY_ALIAS_TO_SLOT)) {
      expect(oldStyleStringToDifficulty(alias)).toBe(slot);
      expect(oldStyleStringToDifficulty(alias.toUpperCase())).toBe(slot);
      expect(difficultyAliasToSlot(`  ${alias}  `)).toBe(slot);
    }
  });

  it("maps 'novice' to Beginner in both engine and catalog (was Invalid-vs-Beginner drift)", () => {
    expect(oldStyleStringToDifficulty('novice')).toBe(Difficulty.Beginner);
    expect(difficultyAliasToSlot('Novice')).toBe(0);
  });

  it('slot display names line up with the engine enum, including slot 4 = Challenge', () => {
    expect(DIFFICULTY_SLOT_NAMES[4]).toBe('Challenge');
    DIFFICULTY_SLOT_NAMES.forEach((name, slot) => {
      expect(difficultyToString(slot as Difficulty)).toBe(name);
      expect(stringToDifficulty(name)).toBe(slot);
    });
  });

  it('rejects unknown names in both', () => {
    for (const bogus of ['bogus', '', 'expert+', 'challenge2']) {
      expect(difficultyAliasToSlot(bogus)).toBe(-1);
      expect(oldStyleStringToDifficulty(bogus)).toBe(Difficulty.Invalid);
    }
  });
});
