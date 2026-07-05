/**
 * Song-header tags shared verbatim by the `.sm` and `.ssc` parsers.
 *
 * Format-specific tags stay in the per-format parsers: `.sm` routes
 * BPMS/STOPS through negative-BPM -> warp conversion (see negativeBpm.ts)
 * while `.ssc` parses them directly, and tags like VERSION/WARPS/NOTEDATA
 * exist only in `.ssc`.
 */

import { Song, type DisplayBpmType } from '../song/song';
import { param, type MsdValue } from './msd';
import { hhmmssToSeconds, parseDelays } from './timingTags';

/** `#DISPLAYBPM` values: `*` (random), one value, or a `min:max` range. */
export function parseDisplayBpm(
  v1: string,
  v2: string,
): { type: DisplayBpmType; min: number; max: number } {
  if (v1.trim() === '*') return { type: 'random', min: 0, max: 0 };
  const min = Number.parseFloat(v1);
  if (v2.trim().length > 0) return { type: 'specified', min, max: Number.parseFloat(v2) };
  return { type: 'specified', min, max: min };
}

/**
 * Apply one song-header tag whose semantics are identical in `.sm` and
 * `.ssc`. Returns true if the tag was handled; false means the caller's
 * per-format switch should deal with it.
 */
export function applySongHeaderTag(song: Song, tag: string, value: MsdValue): boolean {
  const v1 = param(value, 1);
  switch (tag) {
    case 'TITLE':
      song.title = v1;
      return true;
    case 'SUBTITLE':
      song.subtitle = v1;
      return true;
    case 'ARTIST':
      song.artist = v1;
      return true;
    case 'TITLETRANSLIT':
      song.titleTranslit = v1;
      return true;
    case 'SUBTITLETRANSLIT':
      song.subtitleTranslit = v1;
      return true;
    case 'ARTISTTRANSLIT':
      song.artistTranslit = v1;
      return true;
    case 'GENRE':
      song.genre = v1;
      return true;
    case 'CREDIT':
      song.credit = v1;
      return true;
    case 'MUSIC':
      song.musicFile = v1;
      return true;
    case 'BANNER':
      song.bannerFile = v1;
      return true;
    case 'BACKGROUND':
      song.backgroundFile = v1;
      return true;
    case 'CDTITLE':
      song.cdTitleFile = v1;
      return true;
    case 'LYRICSPATH':
      song.lyricsFile = v1;
      return true;
    case 'OFFSET':
      song.timing.offsetSeconds = Number.parseFloat(v1) || 0;
      return true;
    case 'SAMPLESTART':
      song.sampleStartSeconds = hhmmssToSeconds(v1);
      return true;
    case 'SAMPLELENGTH':
      song.sampleLengthSeconds = hhmmssToSeconds(v1);
      return true;
    case 'DISPLAYBPM': {
      const d = parseDisplayBpm(v1, param(value, 2));
      song.displayBpmType = d.type;
      song.specifiedBpmMin = d.min;
      song.specifiedBpmMax = d.max;
      return true;
    }
    case 'DELAYS':
      song.timing.delays = parseDelays(v1);
      return true;
    default:
      return false;
  }
}
