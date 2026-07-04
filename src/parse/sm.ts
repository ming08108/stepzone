/**
 * `.sm` parser. Song tags plus 6-field `#NOTES` charts. See spec doc 1 (§1.2–1.3).
 *
 * Limitation (tracked for a later milestone): negative BPMs / negative stops are
 * NOT yet converted to warps (spec doc 2 §2.5). They are dropped with a warning,
 * so `.sm` charts that use negative-BPM gimmicks will mis-time. `.ssc` (with
 * explicit `#WARPS`) is fully supported.
 */

import { Song, type DisplayBpmType } from '../song/song';
import { Steps } from '../song/steps';
import { oldStyleStringToDifficulty } from '../song/difficulty';
import { param, tagName, tokenizeMsd } from './msd';
import { hhmmssToSeconds, parseBpms, parseDelays, parsePairs, parseStops } from './timingTags';

function parseDisplayBpm(
  v1: string,
  v2: string,
): { type: DisplayBpmType; min: number; max: number } {
  if (v1.trim() === '*') return { type: 'random', min: 0, max: 0 };
  const min = Number.parseFloat(v1);
  if (v2.trim().length > 0) return { type: 'specified', min, max: Number.parseFloat(v2) };
  return { type: 'specified', min, max: min };
}

function hasNegativeTiming(s: string): boolean {
  return parsePairs(s).some((p) => p.values[0] < 0);
}

export function parseSm(text: string, warnings: string[] = []): Song {
  const song = new Song();
  const values = tokenizeMsd(text, true);

  for (const value of values) {
    const tag = tagName(value);
    const v1 = param(value, 1);

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
      case 'MUSIC':
        song.musicFile = v1;
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
      case 'LYRICSPATH':
        song.lyricsFile = v1;
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
      case 'DISPLAYBPM': {
        const d = parseDisplayBpm(v1, param(value, 2));
        song.displayBpmType = d.type;
        song.specifiedBpmMin = d.min;
        song.specifiedBpmMax = d.max;
        break;
      }
      case 'BPMS':
        if (hasNegativeTiming(v1)) {
          warnings.push('Negative BPMs present; warp conversion not yet implemented.');
        }
        song.timing.bpms = parseBpms(v1);
        break;
      case 'STOPS':
      case 'FREEZES':
        if (hasNegativeTiming(v1)) {
          warnings.push('Negative stops present; warp conversion not yet implemented.');
        }
        song.timing.stops = parseStops(v1);
        break;
      case 'DELAYS':
        song.timing.delays = parseDelays(v1);
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

  song.timing.tidy();
  return song;
}
