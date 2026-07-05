import { describe, expect, it } from 'vitest';
import { parseSsc } from '../src/parse/ssc';
import { parseWarps, supportsSplitTiming, VERSION_SPLIT_TIMING } from '../src/parse/timingTags';
import { beatToNoteRow } from '../src/notes/noteTypes';

describe('supportsSplitTiming (#VERSION gate)', () => {
  it('treats a missing #VERSION (0) and >= 0.7 as modern', () => {
    expect(supportsSplitTiming(0)).toBe(true);
    expect(supportsSplitTiming(VERSION_SPLIT_TIMING)).toBe(true);
    expect(supportsSplitTiming(0.83)).toBe(true);
  });

  it('rejects explicit pre-0.7 versions', () => {
    expect(supportsSplitTiming(0.56)).toBe(false);
    expect(supportsSplitTiming(0.699)).toBe(false);
  });
});

describe('parseWarps versioning', () => {
  it('pre-0.7: the value is an absolute destination beat', () => {
    expect(parseWarps('4=6', 0.65)).toEqual([
      { row: beatToNoteRow(4), lengthRows: beatToNoteRow(2) },
    ]);
  });

  it('>= 0.7: the value is a relative length in beats', () => {
    expect(parseWarps('4=6', 0.83)).toEqual([
      { row: beatToNoteRow(4), lengthRows: beatToNoteRow(6) },
    ]);
  });

  it('version 0 (no #VERSION tag) parses as modern relative lengths', () => {
    expect(parseWarps('4=6', 0)).toEqual([{ row: beatToNoteRow(4), lengthRows: beatToNoteRow(6) }]);
  });

  it('pre-0.7 with destination <= beat falls back to a relative length', () => {
    expect(parseWarps('4=2', 0.65)).toEqual([
      { row: beatToNoteRow(4), lengthRows: beatToNoteRow(2) },
    ]);
  });

  it('drops non-positive lengths in every era', () => {
    expect(parseWarps('4=0', 0.83)).toEqual([]);
    expect(parseWarps('4=-2', 0.83)).toEqual([]);
    expect(parseWarps('4=0', 0.65)).toEqual([]);
  });
});

/** Minimal `.ssc`: song header (120 BPM, stop at beat 2) + one chart block. */
function makeSsc({ version = '', header = '', chart = '' } = {}): string {
  const versionTag = version.length > 0 ? `#VERSION:${version};\n` : '';
  return (
    `#TITLE:Split Test;\n${versionTag}#OFFSET:-0.1;\n#BPMS:0=120;\n#STOPS:2=0.5;\n${header}` +
    `#NOTEDATA:;\n#STEPSTYPE:dance-single;\n#DIFFICULTY:Hard;\n#METER:5;\n${chart}` +
    `#NOTES:\n0000\n0000\n0000\n0000\n;\n`
  );
}

describe('parseSsc split (per-chart) timing', () => {
  it('a chart #BPMS overrides song BPMs and inherits everything else', () => {
    const song = parseSsc(makeSsc({ version: '0.83', chart: '#BPMS:0=180;\n' }));
    const chart = song.charts[0];
    expect(chart.timing).not.toBeNull();
    // Overridden: 180 BPM instead of 120.
    expect(chart.timing!.bpms).toEqual([{ row: 0, bps: 3 }]);
    // Inherited from the song header: stop and offset.
    expect(chart.timing!.stops).toEqual([{ row: beatToNoteRow(2), seconds: 0.5 }]);
    expect(chart.timing!.offsetSeconds).toBeCloseTo(-0.1, 6);
    // The song's own timing is untouched.
    expect(song.timing.bpms).toEqual([{ row: 0, bps: 2 }]);
    expect(chart.getTimingData(song.timing)).toBe(chart.timing);
  });

  it('a chart #OFFSET alone triggers split timing', () => {
    const song = parseSsc(makeSsc({ version: '0.83', chart: '#OFFSET:0.25;\n' }));
    const chart = song.charts[0];
    expect(chart.timing).not.toBeNull();
    expect(chart.timing!.offsetSeconds).toBeCloseTo(0.25, 6);
    expect(chart.timing!.bpms).toEqual([{ row: 0, bps: 2 }]); // inherited
    expect(song.timing.offsetSeconds).toBeCloseTo(-0.1, 6);
  });

  it('pre-0.7 files ignore chart timing tags entirely', () => {
    const song = parseSsc(makeSsc({ version: '0.56', chart: '#BPMS:0=180;\n#OFFSET:0.25;\n' }));
    const chart = song.charts[0];
    expect(chart.timing).toBeNull();
    expect(chart.getTimingData(song.timing)).toBe(song.timing);
    expect(song.timing.bpms).toEqual([{ row: 0, bps: 2 }]);
  });

  it('a file with no #VERSION tag honors split timing', () => {
    const song = parseSsc(makeSsc({ chart: '#BPMS:0=180;\n' }));
    expect(song.version).toBe(0);
    expect(song.charts[0].timing).not.toBeNull();
    expect(song.charts[0].timing!.bpms).toEqual([{ row: 0, bps: 3 }]);
  });

  it('metadata-only chart tags do not create per-chart timing', () => {
    const song = parseSsc(makeSsc({ version: '0.83', chart: '#CHARTNAME:Meta Only;\n' }));
    expect(song.charts[0].chartName).toBe('Meta Only');
    expect(song.charts[0].timing).toBeNull();
  });

  it('song-level #WARPS respects the file version', () => {
    const legacy = parseSsc(makeSsc({ version: '0.56', header: '#WARPS:2=4;\n' }));
    expect(legacy.timing.warps).toEqual([
      { row: beatToNoteRow(2), lengthRows: beatToNoteRow(2) }, // absolute dest 4
    ]);
    const modern = parseSsc(makeSsc({ version: '0.83', header: '#WARPS:2=4;\n' }));
    expect(modern.timing.warps).toEqual([
      { row: beatToNoteRow(2), lengthRows: beatToNoteRow(4) }, // relative length 4
    ]);
  });

  it('chart-level #WARPS overrides the song and stays version-aware', () => {
    const song = parseSsc(makeSsc({ version: '0.83', chart: '#WARPS:2=4;\n' }));
    const chart = song.charts[0];
    expect(song.timing.warps).toEqual([]);
    expect(chart.timing!.warps).toEqual([{ row: beatToNoteRow(2), lengthRows: beatToNoteRow(4) }]);
  });
});
