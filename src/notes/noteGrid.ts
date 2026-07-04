/**
 * Decode the `#NOTES` grid string into NoteData.
 *
 * Mirrors ITGmania `NoteDataUtil::LoadFromSMNoteDataString`. See spec doc 1
 * (§1.5) and doc 3 (§3.7). Shared by the `.sm` and `.ssc` loaders.
 */

import { NoteData } from './noteData';
import {
  BEATS_PER_MEASURE,
  beatToNoteRow,
  makeAutoKeysound,
  makeFake,
  makeHoldHead,
  makeLift,
  makeMine,
  makeTap,
  TapNoteSubType,
  type TapNote,
} from './noteTypes';

// Strip `//` line comments (belt-and-suspenders; the MSD tokenizer already does).
function stripComments(s: string): string {
  return s
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

/**
 * Parse one player's grid (measures separated by `,`, rows by newline, one
 * character per column) into a NoteData with `numTracks` columns.
 */
export function parseNoteGrid(grid: string, numTracks: number, warnings: string[] = []): NoteData {
  const out = new NoteData(numTracks);
  const text = stripComments(grid);

  // Per-track open hold heads awaiting their `3` tail.
  const openRow: number[] = new Array<number>(numTracks).fill(-1);
  const openNote: (TapNote | null)[] = new Array<TapNote | null>(numTracks).fill(null);

  // `,,` (adjacent commas, zero-length token) collapses without adding a measure,
  // but `,\n,` (a token with content) is a real empty measure. This mirrors the
  // engine's ignore-empty split (spec doc 10 §10.1). Only zero-length tokens skip.
  let measure = -1;
  for (const rawMeasure of text.split(',')) {
    if (rawMeasure.length === 0) continue;
    measure++;

    const lines = rawMeasure
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const numLines = lines.length;

    for (let l = 0; l < numLines; l++) {
      const line = lines[l];
      const beat = (measure + l / numLines) * BEATS_PER_MEASURE;
      const row = beatToNoteRow(beat);

      let p = 0;
      let track = 0;
      while (track < numTracks && p < line.length) {
        const ch = line[p];
        p++;

        let note: TapNote | null = null;
        switch (ch) {
          case '0':
            break;
          case '1':
            note = makeTap();
            break;
          case '2':
          case '4': {
            note = makeHoldHead(ch === '2' ? TapNoteSubType.Hold : TapNoteSubType.Roll);
            openRow[track] = row;
            openNote[track] = note;
            break;
          }
          case '3': {
            const headRow = openRow[track];
            const head = openNote[track];
            if (headRow >= 0 && head) {
              head.durationRows = row - headRow;
              openRow[track] = -1;
              openNote[track] = null;
            } else {
              warnings.push(`Unmatched '3' (hold tail) at row ${row}, track ${track}`);
            }
            break;
          }
          case 'M':
            note = makeMine();
            break;
          case 'K':
            note = makeAutoKeysound();
            break;
          case 'L':
            note = makeLift();
            break;
          case 'F':
            note = makeFake();
            break;
          default:
            break; // invalid -> empty (tolerant)
        }

        // Optional keysound index suffix, e.g. `1[3]`.
        if (line[p] === '[') {
          p++;
          let digits = '';
          while (p < line.length && line[p] !== ']') {
            digits += line[p];
            p++;
          }
          if (line[p] === ']') p++;
          const idx = Number.parseInt(digits, 10);
          if (note && !Number.isNaN(idx)) note.keysoundIndex = idx;
        }

        if (note) out.setTapNote(track, row, note);
        track++;
      }
    }
  }

  // Drop any hold head that never found its tail.
  for (let t = 0; t < numTracks; t++) {
    if (openRow[t] >= 0) {
      warnings.push(`Unmatched hold head (no '3') at row ${openRow[t]}, track ${t}`);
      out.removeTapNote(t, openRow[t]);
    }
  }

  return out;
}
