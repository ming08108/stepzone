/**
 * The in-memory note container: one sorted list of (row, TapNote) per track.
 * Empty cells are never stored. Mirrors ITGmania `NoteData`. See spec doc 3
 * (§3.5).
 */

import { type TapNote, TapNoteSubType, TapNoteType, NO_KEYSOUND, NO_PLAYER } from './noteTypes';

export interface RowTapNote {
  row: number;
  note: TapNote;
}

const EMPTY_NOTE: TapNote = Object.freeze({
  type: TapNoteType.Empty,
  subType: TapNoteSubType.Invalid,
  durationRows: 0,
  keysoundIndex: NO_KEYSOUND,
  player: NO_PLAYER,
});

export interface NoteCounts {
  taps: number; // single taps only (not hold/roll heads)
  holdHeads: number; // hold subtype heads
  rollHeads: number; // roll subtype heads
  mines: number;
  lifts: number;
  fakes: number;
  /** Rows with >= 2 simultaneous taps/heads (jumps). */
  jumps: number;
  /** Rows with >= 3 simultaneous (hands). */
  hands: number;
  /** taps + hold heads + roll heads (the "TapsAndHolds" radar value). */
  tapsAndHolds: number;
}

export class NoteData {
  private readonly tracks: RowTapNote[][];

  constructor(numTracks: number) {
    this.tracks = Array.from({ length: numTracks }, () => []);
  }

  get numTracks(): number {
    return this.tracks.length;
  }

  private lowerBound(arr: RowTapNote[], row: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].row < row) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Insert/overwrite a note; passing an Empty note erases the cell. */
  setTapNote(track: number, row: number, note: TapNote): void {
    if (track < 0 || track >= this.tracks.length || row < 0) return;
    const arr = this.tracks[track];
    const idx = this.lowerBound(arr, row);
    const exists = idx < arr.length && arr[idx].row === row;
    if (note.type === TapNoteType.Empty) {
      if (exists) arr.splice(idx, 1);
      return;
    }
    if (exists) arr[idx].note = note;
    else arr.splice(idx, 0, { row, note });
  }

  /** The note at a cell, or the shared Empty sentinel if absent. */
  getTapNote(track: number, row: number): TapNote {
    const arr = this.tracks[track];
    if (!arr) return EMPTY_NOTE;
    const idx = this.lowerBound(arr, row);
    if (idx < arr.length && arr[idx].row === row) return arr[idx].note;
    return EMPTY_NOTE;
  }

  removeTapNote(track: number, row: number): void {
    this.setTapNote(track, row, EMPTY_NOTE);
  }

  /** The sorted (row, note) list for a track. Do not mutate. */
  getTrack(track: number): readonly RowTapNote[] {
    return this.tracks[track] ?? [];
  }

  /** Total non-empty entries across all tracks. */
  get size(): number {
    let n = 0;
    for (const t of this.tracks) n += t.length;
    return n;
  }

  firstRow(): number {
    let first = -1;
    for (const t of this.tracks) {
      if (t.length > 0 && (first < 0 || t[0].row < first)) first = t[0].row;
    }
    return first < 0 ? 0 : first;
  }

  /** Last occupied row, counting hold tails (headRow + durationRows). */
  lastRow(): number {
    let last = 0;
    for (const t of this.tracks) {
      for (const { row, note } of t) {
        const end = note.type === TapNoteType.HoldHead ? row + note.durationRows : row;
        if (end > last) last = end;
      }
    }
    return last;
  }

  computeCounts(): NoteCounts {
    const c: NoteCounts = {
      taps: 0,
      holdHeads: 0,
      rollHeads: 0,
      mines: 0,
      lifts: 0,
      fakes: 0,
      jumps: 0,
      hands: 0,
      tapsAndHolds: 0,
    };
    const tapsPerRow = new Map<number, number>();

    for (const t of this.tracks) {
      for (const { row, note } of t) {
        switch (note.type) {
          case TapNoteType.Tap:
            c.taps++;
            c.tapsAndHolds++;
            tapsPerRow.set(row, (tapsPerRow.get(row) ?? 0) + 1);
            break;
          case TapNoteType.HoldHead:
            if (note.subType === TapNoteSubType.Roll) c.rollHeads++;
            else c.holdHeads++;
            c.tapsAndHolds++;
            tapsPerRow.set(row, (tapsPerRow.get(row) ?? 0) + 1);
            break;
          case TapNoteType.Mine:
            c.mines++;
            break;
          case TapNoteType.Lift:
            c.lifts++;
            tapsPerRow.set(row, (tapsPerRow.get(row) ?? 0) + 1);
            break;
          case TapNoteType.Fake:
            c.fakes++;
            break;
          default:
            break;
        }
      }
    }

    for (const count of tapsPerRow.values()) {
      if (count >= 2) c.jumps++;
      if (count >= 3) c.hands++;
    }
    return c;
  }
}

export { EMPTY_NOTE };
