/**
 * `.ssc` parser. A song header followed by one or more `#NOTEDATA … #NOTES`
 * chart blocks. See spec doc 1 (§1.4).
 *
 * Split-timing note: we seed each chart's working timing as a copy of the song
 * timing, then replace whichever lists the chart overrides. A chart is treated
 * as having its own timing only if it overrides at least one list. This is
 * slightly more forgiving than the engine (which seeds only the offset) but
 * behaves identically for fully-specified and non-split charts.
 */

import { TimingData } from '../timing/timingData';
import { Song, type DisplayBpmType } from '../song/song';
import { Steps } from '../song/steps';
import { stringToDifficulty } from '../song/difficulty';
import { param, tagName, tokenizeMsd } from './msd';
import {
  cloneTiming,
  hhmmssToSeconds,
  parseBpms,
  parseDelays,
  parseFakes,
  parseScrolls,
  parseSpeeds,
  parseStops,
  parseWarps,
} from './timingTags';

function parseDisplayBpm(
  v1: string,
  v2: string,
): { type: DisplayBpmType; min: number; max: number } {
  if (v1.trim() === '*') return { type: 'random', min: 0, max: 0 };
  const min = Number.parseFloat(v1);
  if (v2.trim().length > 0) {
    return { type: 'specified', min, max: Number.parseFloat(v2) };
  }
  return { type: 'specified', min, max: min };
}

export function parseSsc(text: string): Song {
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
      switch (tag) {
        case 'TITLE':
          song.title = v1;
          break;
        case 'SUBTITLE':
          song.subtitle = v1;
          break;
        case 'ARTIST':
          song.artist = v1;
          break;
        case 'TITLETRANSLIT':
          song.titleTranslit = v1;
          break;
        case 'SUBTITLETRANSLIT':
          song.subtitleTranslit = v1;
          break;
        case 'ARTISTTRANSLIT':
          song.artistTranslit = v1;
          break;
        case 'GENRE':
          song.genre = v1;
          break;
        case 'CREDIT':
          song.credit = v1;
          break;
        case 'ORIGIN':
          song.origin = v1;
          break;
        case 'MUSIC':
          song.musicFile = v1;
          break;
        case 'PREVIEW':
          song.previewFile = v1;
          break;
        case 'BANNER':
          song.bannerFile = v1;
          break;
        case 'BACKGROUND':
          song.backgroundFile = v1;
          break;
        case 'CDTITLE':
          song.cdTitleFile = v1;
          break;
        case 'JACKET':
          song.jacketFile = v1;
          break;
        case 'LYRICSPATH':
          song.lyricsFile = v1;
          break;
        case 'VERSION':
          song.version = Number.parseFloat(v1) || 0;
          break;
        case 'OFFSET':
          song.timing.offsetSeconds = Number.parseFloat(v1) || 0;
          break;
        case 'SAMPLESTART':
          song.sampleStartSeconds = hhmmssToSeconds(v1);
          break;
        case 'SAMPLELENGTH':
          song.sampleLengthSeconds = hhmmssToSeconds(v1);
          break;
        case 'KEYSOUNDS':
          song.keysounds = v1.length > 0 ? v1.split(',').map((k) => k.trim()) : [];
          break;
        case 'DISPLAYBPM': {
          const d = parseDisplayBpm(v1, param(value, 2));
          song.displayBpmType = d.type;
          song.specifiedBpmMin = d.min;
          song.specifiedBpmMax = d.max;
          break;
        }
        case 'BPMS':
          song.timing.bpms = parseBpms(v1);
          break;
        case 'STOPS':
          song.timing.stops = parseStops(v1);
          break;
        case 'DELAYS':
          song.timing.delays = parseDelays(v1);
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
          chartTiming = cloneTiming(song.timing);
          chartHasOwnTiming = false;
          break;
        default:
          break; // ignore unknown/song tags we don't model yet
      }
      continue;
    }

    // Inside a #NOTEDATA block.
    const splitOK = song.version === 0 || song.version >= 0.7;
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
  if (inChart) finishChart('');

  song.timing.tidy();
  return song;
}
