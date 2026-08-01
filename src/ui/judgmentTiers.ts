/**
 * The generic judgment-tier display vocabulary (skin-neutral ITG wording +
 * the results palette). ONE copy: the results breakdown and the settings
 * lifetime tallies must never drift apart. (The in-play HUD deliberately uses
 * the active skin's own wording instead — A3_JUDGMENT / ITG_LABELS.)
 */
import { TapNoteScore } from '../notes/noteTypes';

export const JUDGMENT_TIERS: ReadonlyArray<readonly [TapNoteScore, string, string]> = [
  [TapNoteScore.W1, 'FANTASTIC', '#38f0ff'],
  [TapNoteScore.W2, 'EXCELLENT', '#ffd23d'],
  [TapNoteScore.W3, 'GREAT', '#59f07f'],
  [TapNoteScore.W4, 'DECENT', '#c86bff'],
  [TapNoteScore.W5, 'WAY OFF', '#ff9d3d'],
  [TapNoteScore.Miss, 'MISS', '#ff5d47'],
];
