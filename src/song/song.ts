/** A song: metadata, timing, and one or more charts. See spec doc 5 (§5.2). */

import { TimingData } from '../timing/timingData';
import { Steps } from './steps';

export type DisplayBpmType = 'actual' | 'specified' | 'random';

export class Song {
  title = '';
  subtitle = '';
  artist = '';
  titleTranslit = '';
  subtitleTranslit = '';
  artistTranslit = '';
  genre = '';
  credit = '';
  origin = '';

  musicFile = '';
  previewFile = '';
  bannerFile = '';
  backgroundFile = '';
  cdTitleFile = '';
  jacketFile = '';
  lyricsFile = '';

  /** Preview clip start/length in seconds (-1 start = auto). */
  sampleStartSeconds = -1;
  sampleLengthSeconds = 12;

  displayBpmType: DisplayBpmType = 'actual';
  specifiedBpmMin = 0;
  specifiedBpmMax = 0;

  /** Simfile format version (`#VERSION`), 0 for plain `.sm`. */
  version = 0;

  /** Song-wide timing (BPMs, stops, warps, offset). */
  timing = new TimingData();

  /** Per-note keysound sample filenames, indexed by TapNote.keysoundIndex. */
  keysounds: string[] = [];

  charts: Steps[] = [];

  /** The song `#OFFSET` in seconds (convenience mirror of timing). */
  get offsetSeconds(): number {
    return this.timing.offsetSeconds;
  }

  findChart(stepsType: string, difficulty: number): Steps | undefined {
    return this.charts.find((c) => c.stepsType === stepsType && c.difficulty === difficulty);
  }
}
