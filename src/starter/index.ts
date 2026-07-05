/**
 * Bundled starter songs — original Stepzone compositions synthesized on the
 * fly, so a fresh install (no dropped folders, no song server) still has
 * something real to play. Charts and audio share one beat grid (see songs.ts /
 * charts.ts); the WAV is rendered lazily on first preview/play and cached for
 * the session.
 */

import { parseSimfile } from '../parse/loader';
import type { LibraryEntry } from '../io/songFiles';
import { expandNotes, STARTER_CHARTS } from './charts';
import { STARTER_SONG_DEFS, type StarterSongDef } from './songs';
import { renderTrackWav } from './trackSynth';

export const STARTER_PACK = 'Stepzone Starter';

/** Full .ssc text for one starter song (parsed by the normal simfile loader). */
export function starterSsc(def: StarterSongDef): string {
  const header = [
    '#VERSION:0.83;',
    `#TITLE:${def.title};`,
    '#ARTIST:Stepzone;',
    '#CREDIT:Stepzone;',
    '#MUSIC:synth.wav;',
    '#OFFSET:0.000;',
    `#SAMPLESTART:${def.sampleStart.toFixed(3)};`,
    '#SAMPLELENGTH:14.000;',
    `#BPMS:0.000=${def.bpm.toFixed(3)};`,
    `#DISPLAYBPM:${def.bpm};`,
  ].join('\n');
  const blocks = STARTER_CHARTS[def.title].map((c) =>
    [
      '#NOTEDATA:;',
      '#STEPSTYPE:dance-single;',
      `#DIFFICULTY:${c.difficulty};`,
      `#METER:${c.meter};`,
      '#NOTES:',
      expandNotes(c.measures),
      ';',
    ].join('\n'),
  );
  return `${header}\n${blocks.join('\n')}\n`;
}

/** Library entries for the bundled pack (fresh Song objects per call). */
export function starterEntries(): LibraryEntry[] {
  return STARTER_SONG_DEFS.map((def) => {
    let wav: ArrayBuffer | null = null;
    return {
      song: parseSimfile(starterSsc(def), def.file),
      files: [],
      sourceName: def.file,
      bannerUrl: null,
      pack: STARTER_PACK,
      synthAudio: () => (wav ??= renderTrackWav(def.spec())),
    };
  });
}
