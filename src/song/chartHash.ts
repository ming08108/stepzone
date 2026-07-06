/**
 * Content identity for a chart: a hash of the normalized note grid plus the
 * gameplay-relevant timing (BPMs/stops/delays/warps/fakes). Metadata edits —
 * titles, banners, folder moves, offset/sync tweaks — don't change it; a note
 * or timing revision does (a re-synced chart plays differently, so it is a
 * different record). Same idea as Etterna's ChartKey / GrooveStats' chartkey.
 * Used as the score-storage key (app/scores).
 */

import type { Song } from './song';
import type { Steps } from './steps';
import type { TimingData } from '../timing/timingData';

/** 64-bit hash as 16 hex chars: two 32-bit imul mixers (cyrb53, doubled). */
function hash64(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Halve a measure's rows while every dropped row is all-zero padding, so
 *  `1000/0000/0010/0000` and `1000/0010` (the same steps written at different
 *  subdivisions) fingerprint identically. */
function minimizeMeasure(rows: string[]): string[] {
  let r = rows;
  while (r.length > 1 && r.length % 2 === 0) {
    let padded = true;
    for (let i = 1; i < r.length; i += 2) {
      if (!/^0+$/.test(r[i])) {
        padded = false;
        break;
      }
    }
    if (!padded) break;
    const half: string[] = [];
    for (let i = 0; i < r.length; i += 2) half.push(r[i]);
    r = half;
  }
  return r;
}

/** The note grid with formatting noise removed: comments, blank lines,
 *  whitespace/line endings, and pure padding rows. */
function normalizeNotes(noteDataString: string): string {
  return noteDataString
    .split(',')
    .map((measure) => {
      const rows = measure
        .split('\n')
        .map((line) => line.replace(/\/\/.*/, '').trim())
        .filter((line) => line.length > 0);
      return minimizeMeasure(rows).join('\n');
    })
    .join(',');
}

const num = (v: number) => v.toFixed(6);

/** The timing that changes how a chart plays. Offset is deliberately absent:
 *  it only shifts audio sync, and sync fixes must not orphan records. */
function timingFingerprint(t: TimingData): string {
  return [
    t.bpms.map((s) => `${s.row}:${num(s.bps)}`).join(','),
    t.stops.map((s) => `${s.row}:${num(s.seconds)}`).join(','),
    t.delays.map((s) => `${s.row}:${num(s.seconds)}`).join(','),
    t.warps.map((s) => `${s.row}:${s.lengthRows}`).join(','),
    t.fakes.map((s) => `${s.row}:${s.lengthRows}`).join(','),
  ].join(';');
}

export function chartContentHash(song: Song, chart: Steps): string {
  const timing = chart.getTimingData(song.timing);
  return hash64(
    `${chart.stepsType}|${normalizeNotes(chart.noteDataString)}|${timingFingerprint(timing)}`,
  );
}
