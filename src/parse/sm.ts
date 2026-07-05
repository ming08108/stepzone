/**
 * `.sm` parser. Song tags plus 6-field `#NOTES` charts. See spec doc 1 (§1.2–1.3).
 *
 * Negative BPMs / negative stops (and "infinite" BPMs) are converted to warps
 * after parsing, via processBpmsAndStops (spec doc 2 §2.5), so DDR gimmick
 * charts time correctly.
 *
 * Tags shared with `.ssc` are handled by applySongHeaderTag (songHeader.ts);
 * only `.sm`-specific handling lives here.
 */

import { Song } from '../song/song';
import { Steps } from '../song/steps';
import { oldStyleStringToDifficulty } from '../song/difficulty';
import { param, tagName, tokenizeMsd } from './msd';
import { applySongHeaderTag } from './songHeader';
import { processBpmsAndStops, rawPairs } from './negativeBpm';

/** Parse `.sm` text. Parse warnings are appended to the optional `warnings` array. */
export function parseSm(text: string, warnings: string[] = []): Song {
  const song = new Song();
  const values = tokenizeMsd(text, true);

  // BPMs/stops are processed together at the end (negative -> warp conversion).
  let rawBpms: Array<[number, number]> = [];
  let rawStops: Array<[number, number]> = [];

  for (const value of values) {
    const tag = tagName(value);
    if (applySongHeaderTag(song, tag, value)) continue;
    const v1 = param(value, 1);

    switch (tag) {
      case 'BPMS':
        rawBpms = rawPairs(v1);
        break;
      case 'STOPS':
      case 'FREEZES':
        rawStops = rawPairs(v1);
        break;
      case 'NOTES':
      case 'NOTES2': {
        if (value.params.length < 7) {
          warnings.push('#NOTES with fewer than 6 fields skipped.');
          break;
        }
        const chart = new Steps();
        chart.stepsType = param(value, 1).trim();
        chart.description = param(value, 2).trim();
        chart.chartName = chart.description;
        chart.credit = chart.description;
        chart.difficulty = oldStyleStringToDifficulty(param(value, 3));
        chart.meter = Number.parseInt(param(value, 4), 10) || 1;
        // param 5 (radar values) is ignored and recomputed.
        chart.noteDataString = param(value, 6).trim();
        song.charts.push(chart);
        break;
      }
      default:
        break;
    }
  }

  // Convert BPMs/stops (incl. negatives) into positive BPMs + warps + stops.
  const processed = processBpmsAndStops(rawBpms, rawStops);
  song.timing.bpms = processed.bpms;
  song.timing.stops = processed.stops;
  song.timing.warps = processed.warps;
  song.timing.offsetSeconds += processed.offsetDelta;

  song.timing.tidy();
  return song;
}
