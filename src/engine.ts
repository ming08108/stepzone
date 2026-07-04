/**
 * Public API of the framework-free engine. The React app and tests import from
 * here rather than reaching into subfolders.
 */

// Notes
export * from './notes/noteTypes';
export { NoteData, type RowTapNote, type NoteCounts } from './notes/noteData';
export { parseNoteGrid } from './notes/noteGrid';

// Timing
export * from './timing/segments';
export { TimingData, type BeatInfo } from './timing/timingData';

// Song / charts
export { Song, type DisplayBpmType } from './song/song';
export { Steps } from './song/steps';
export {
  Difficulty,
  difficultyToString,
  stringToDifficulty,
  oldStyleStringToDifficulty,
} from './song/difficulty';
export { STEPS_TYPES, stepsTypeNumTracks, type StepsTypeInfo } from './song/stepsType';

// Parsing
export { tokenizeMsd, type MsdValue } from './parse/msd';
export { parseSimfile, parseSsc, parseSm, detectFormat, type SimfileFormat } from './parse/index';

// Audio clock (browser only, but the pure sync math is exported for testing)
export { SyncMap, type SyncAnchor } from './audio/syncMap';
