/** One chart (difficulty) of a song. See spec doc 5 (§5.3). */

import { NoteData } from '../notes/noteData';
import { parseNoteGrid } from '../notes/noteGrid';
import { TimingData } from '../timing/timingData';
import { Difficulty } from './difficulty';
import { stepsTypeNumTracks } from './stepsType';

export class Steps {
  stepsType = '';
  difficulty: Difficulty = Difficulty.Invalid;
  meter = 1;
  description = '';
  chartName = '';
  chartStyle = '';
  credit = '';

  /** Raw `#NOTES` grid string, parsed on demand. */
  noteDataString = '';

  /** Per-chart (split) timing, or null to use the song's timing. */
  timing: TimingData | null = null;

  private cachedNoteData: NoteData | null = null;
  private cachedWarnings: string[] = [];

  get numTracks(): number {
    return stepsTypeNumTracks(this.stepsType);
  }

  /** Parse (and cache) the note grid. */
  getNoteData(): NoteData {
    if (this.cachedNoteData === null) {
      const tracks = this.numTracks;
      this.cachedWarnings = [];
      this.cachedNoteData = parseNoteGrid(
        this.noteDataString,
        tracks > 0 ? tracks : 4,
        this.cachedWarnings,
      );
    }
    return this.cachedNoteData;
  }

  /**
   * Warnings produced while parsing the note grid (parses on first access).
   * Surfacing these in the UI is deferred; they are kept reachable here (and
   * simfile-level warnings via parseSimfile's `warnings` out-param) for when
   * that lands.
   */
  get noteWarnings(): readonly string[] {
    this.getNoteData();
    return this.cachedWarnings;
  }

  /** The timing that governs this chart: its own, or the song's fallback. */
  getTimingData(songTiming: TimingData): TimingData {
    return this.timing ?? songTiming;
  }
}
