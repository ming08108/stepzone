import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSimfile } from '../src/parse/loader';
import { Difficulty } from '../src/song/difficulty';
import { TapNoteType } from '../src/notes/noteTypes';

const here = dirname(fileURLToPath(import.meta.url));
const ssc = readFileSync(join(here, '../src/dev/example.ssc'), 'utf8');

describe('worked example: full .ssc -> Song (spec doc 9)', () => {
  const song = parseSimfile(ssc, 'example.ssc');

  it('parses song metadata', () => {
    expect(song.title).toBe('Example');
    expect(song.musicFile).toBe('example.ogg');
    expect(song.timing.offsetSeconds).toBeCloseTo(-0.1, 6);
    expect(song.version).toBeCloseTo(0.83, 6);
  });

  it('parses the chart header', () => {
    expect(song.charts).toHaveLength(1);
    const chart = song.charts[0];
    expect(chart.stepsType).toBe('dance-single');
    expect(chart.numTracks).toBe(4);
    expect(chart.difficulty).toBe(Difficulty.Hard);
    expect(chart.meter).toBe(5);
  });

  it('reproduces the doc-9 beat->second table from song timing', () => {
    const t = song.timing;
    expect(t.getElapsedTimeFromBeat(0)).toBeCloseTo(0.1, 6);
    expect(t.getElapsedTimeFromBeat(2)).toBeCloseTo(1.1, 6); // U tap, on the stop
    expect(t.getElapsedTimeFromBeat(3)).toBeCloseTo(2.1, 6); // hold head
    expect(t.getElapsedTimeFromBeat(6)).toBeCloseTo(4.6, 6); // mine
  });

  it('parses the notes with correct times', () => {
    const nd = song.charts[0].getNoteData();
    const t = song.timing;
    // U tap at beat 2
    expect(nd.getTapNote(2, 2 * 48).type).toBe(TapNoteType.Tap);
    expect(t.getElapsedTimeFromBeat(2)).toBeCloseTo(1.1, 6);
    // R hold head at beat 3, mine at beat 6
    expect(nd.getTapNote(3, 3 * 48).type).toBe(TapNoteType.HoldHead);
    expect(nd.getTapNote(0, 6 * 48).type).toBe(TapNoteType.Mine);

    const counts = nd.computeCounts();
    expect(counts.taps).toBe(3);
    expect(counts.holdHeads).toBe(1);
    expect(counts.mines).toBe(1);
  });
});
