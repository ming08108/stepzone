import { describe, expect, it } from 'vitest';
import { parseSm } from '../src/parse/sm';
import { beatToNoteRow, noteRowToBeat } from '../src/notes/noteTypes';

const sm = (bpms: string) =>
  `#TITLE:Warp Test;\n#OFFSET:0.000;\n#BPMS:${bpms};\n` +
  `#NOTES:\n     dance-single:\n     :\n     Hard:\n     8:\n     :\n0000\n1000\n0000\n0001\n;\n`;

describe('.sm negative-BPM -> warp (spec doc 2 §2.5, todo #16/M6)', () => {
  it('converts a negative-BPM section to a zero-time warp', () => {
    // 120 from beat 0; -120 at beat 4; back to 120 at beat 6.
    const t = parseSm(sm('0.000=120.000,4.000=-120.000,6.000=120.000')).timing;
    expect(t.warps.length).toBeGreaterThan(0);
    const w = t.warps[0];
    expect(w.row).toBe(beatToNoteRow(4));

    // The warped region is unhittable and consumes no real time.
    expect(t.isWarpAtRow(beatToNoteRow(5))).toBe(true);
    expect(t.isJudgableAtRow(beatToNoteRow(5))).toBe(false);
    const t4 = t.getElapsedTimeFromBeat(4);
    const tDest = t.getElapsedTimeFromBeat(4 + noteRowToBeat(w.lengthRows));
    expect(t4).toBeCloseTo(2.0, 3); // 4 beats @ 120 BPM
    expect(tDest).toBeCloseTo(2.0, 3); // warp end shares the same audio time
  });

  it('leaves a constant-BPM chart warp-free', () => {
    const t = parseSm(sm('0.000=140.000')).timing;
    expect(t.warps.length).toBe(0);
    expect(t.getElapsedTimeFromBeat(7)).toBeCloseTo(3.0, 3); // 7 beats @ 140 BPM
  });
});
