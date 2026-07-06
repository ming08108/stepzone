/**
 * Content identity for a chart, so leaderboards match the SAME steps across
 * every player's copy of a song. Two simfiles that differ only cosmetically —
 * title/artist edits, banner swaps, file renames, offset resyncs — must hash
 * identically; changing what is actually played must not. The hash therefore
 * covers exactly the playable content:
 *
 *  - steps type + track count,
 *  - every note (track, row, type, subtype, hold length),
 *  - the tempo map that gives those rows their timing (BPMs, stops, delays,
 *    warps — chart-level split timing included via getTimingData).
 *
 * Excluded on purpose: #OFFSET (aligns audio, not steps), difficulty label
 * and meter (routinely re-rated), and every display field.
 *
 * SHA-256 via WebCrypto (browser + Node ≥ 18), truncated to 16 hex chars —
 * 64 bits is far beyond collision risk for chart-count scales, and short
 * enough to live in URLs and storage keys.
 */

import type { Song } from './song';
import type { Steps } from './steps';

/** Stable serialization of the playable content (see module doc). */
export function chartIdentity(song: Song, chart: Steps): string {
  const nd = chart.getNoteData();
  const timing = chart.getTimingData(song.timing);
  const parts: string[] = [chart.stepsType, `tracks=${nd.numTracks}`];
  for (let track = 0; track < nd.numTracks; track++) {
    for (const { row, note } of nd.getTrack(track)) {
      parts.push(`${track}.${row}.${note.type}.${note.subType}.${note.durationRows}`);
    }
  }
  parts.push('bpms', ...timing.bpms.map((s) => `${s.row}=${s.bps}`));
  parts.push('stops', ...timing.stops.map((s) => `${s.row}=${s.seconds}`));
  parts.push('delays', ...timing.delays.map((s) => `${s.row}=${s.seconds}`));
  parts.push('warps', ...timing.warps.map((s) => `${s.row}=${s.lengthRows}`));
  return parts.join('|');
}

/** 16-hex-char SHA-256 of the chart's playable content. */
export async function chartHash(song: Song, chart: Steps): Promise<string> {
  const bytes = new TextEncoder().encode(chartIdentity(song, chart));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
