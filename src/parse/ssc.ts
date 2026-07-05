/**
 * `.ssc` parser. A song header followed by one or more `#NOTEDATA … #NOTES`
 * chart blocks. See spec doc 1 (§1.4).
 *
 * Tags shared with `.sm` are handled by applySongHeaderTag (songHeader.ts);
 * only `.ssc`-specific handling lives here.
 *
 * Split-timing note: we seed each chart's working timing as a copy of the song
 * timing, then replace whichever lists the chart overrides. A chart is treated
 * as having its own timing only if it overrides at least one list. This is
 * slightly more forgiving than the engine (which seeds only the offset) but
 * behaves identically for fully-specified and non-split charts.
 */

import { TimingData } from '../timing/timingData';
import { Song } from '../song/song';
import { Steps } from '../song/steps';
import { stringToDifficulty } from '../song/difficulty';
import { param, tagName, tokenizeMsd } from './msd';
import { applySongHeaderTag } from './songHeader';
import {
  parseBpms,
  parseDelays,
  parseFakes,
  parseScrolls,
  parseSpeeds,
  parseStops,
  parseWarps,
  supportsSplitTiming,
} from './timingTags';

/** Parse `.ssc` text. Parse warnings are appended to the optional `warnings` array. */
export function parseSsc(text: string, warnings: string[] = []): Song {
  const song = new Song();
  const values = tokenizeMsd(text, true);

  let inChart = false;
  let chart: Steps | null = null;
  let chartTiming: TimingData | null = null;
  let chartHasOwnTiming = false;

  const finishChart = (noteString: string) => {
    if (chart) {
      chart.noteDataString = noteString;
      if (chartHasOwnTiming && chartTiming) {
        chartTiming.tidy();
        chart.timing = chartTiming;
      }
      song.charts.push(chart);
    }
    chart = null;
    chartTiming = null;
    chartHasOwnTiming = false;
    inChart = false;
  };

  for (const value of values) {
    const tag = tagName(value);
    const v1 = param(value, 1);

    if (!inChart) {
      if (applySongHeaderTag(song, tag, value)) continue;
      switch (tag) {
        case 'ORIGIN':
          song.origin = v1;
          break;
        case 'PREVIEW':
          song.previewFile = v1;
          break;
        case 'JACKET':
          song.jacketFile = v1;
          break;
        case 'VERSION':
          song.version = Number.parseFloat(v1) || 0;
          break;
        case 'KEYSOUNDS':
          song.keysounds = v1.length > 0 ? v1.split(',').map((k) => k.trim()) : [];
          break;
        case 'BPMS':
          song.timing.bpms = parseBpms(v1);
          break;
        case 'STOPS':
          song.timing.stops = parseStops(v1);
          break;
        case 'WARPS':
          song.timing.warps = parseWarps(v1, song.version);
          break;
        case 'SCROLLS':
          song.timing.scrolls = parseScrolls(v1);
          break;
        case 'SPEEDS':
          song.timing.speeds = parseSpeeds(v1);
          break;
        case 'FAKES':
          song.timing.fakes = parseFakes(v1);
          break;
        case 'NOTEDATA':
          inChart = true;
          chart = new Steps();
          chartTiming = song.timing.clone();
          chartHasOwnTiming = false;
          break;
        default:
          break; // ignore unknown/song tags we don't model yet
      }
      continue;
    }

    // Inside a #NOTEDATA block.
    const splitOK = supportsSplitTiming(song.version);
    switch (tag) {
      case 'STEPSTYPE':
        if (chart) chart.stepsType = v1;
        break;
      case 'DIFFICULTY':
        if (chart) chart.difficulty = stringToDifficulty(v1);
        break;
      case 'METER':
        if (chart) chart.meter = Number.parseInt(v1, 10) || 1;
        break;
      case 'DESCRIPTION':
        if (chart) chart.description = v1;
        break;
      case 'CHARTNAME':
        if (chart) chart.chartName = v1;
        break;
      case 'CHARTSTYLE':
        if (chart) chart.chartStyle = v1;
        break;
      case 'CREDIT':
        if (chart) chart.credit = v1;
        break;
      case 'OFFSET':
        if (splitOK && chartTiming) {
          chartTiming.offsetSeconds = Number.parseFloat(v1) || 0;
          chartHasOwnTiming = true;
        }
        break;
      case 'BPMS':
        if (splitOK && chartTiming) {
          chartTiming.bpms = parseBpms(v1);
          chartHasOwnTiming = true;
        }
        break;
      case 'STOPS':
        if (splitOK && chartTiming) {
          chartTiming.stops = parseStops(v1);
          chartHasOwnTiming = true;
        }
        break;
      case 'DELAYS':
        if (splitOK && chartTiming) {
          chartTiming.delays = parseDelays(v1);
          chartHasOwnTiming = true;
        }
        break;
      case 'WARPS':
        if (splitOK && chartTiming) {
          chartTiming.warps = parseWarps(v1, song.version);
          chartHasOwnTiming = true;
        }
        break;
      case 'SCROLLS':
        if (splitOK && chartTiming) {
          chartTiming.scrolls = parseScrolls(v1);
          chartHasOwnTiming = true;
        }
        break;
      case 'SPEEDS':
        if (splitOK && chartTiming) {
          chartTiming.speeds = parseSpeeds(v1);
          chartHasOwnTiming = true;
        }
        break;
      case 'FAKES':
        if (splitOK && chartTiming) {
          chartTiming.fakes = parseFakes(v1);
          chartHasOwnTiming = true;
        }
        break;
      case 'NOTES':
      case 'NOTES2':
        finishChart(v1);
        break;
      default:
        break;
    }
  }

  // Tolerate a trailing chart with no closing NOTES (shouldn't happen).
  if (inChart) {
    warnings.push('#NOTEDATA block missing its closing #NOTES; chart kept with no notes.');
    finishChart('');
  }

  song.timing.tidy();
  return song;
}
