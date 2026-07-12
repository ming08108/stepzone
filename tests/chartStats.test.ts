import { describe, expect, it } from 'vitest';
import { parseSimfile } from '../src/parse/loader';
import { computeChartStats } from '../src/analysis/chartStats';

// Columns: 0=Left, 1=Down, 2=Up, 3=Right. Tech expectations below are the exact
// values ITGmania's StepParity produces (verified against the compiled C++ on
// the real song library — see scripts/techValidate.ts).
function chart(bpm: number, body: string) {
  const sm = `#TITLE:t;\n#BPMS:0.000=${bpm.toFixed(3)};\n#NOTES:\ndance-single:\n:\nChallenge:\n10:\n:\n${body}\n;\n`;
  const song = parseSimfile(sm, 't.sm');
  const c = song.charts[0];
  return computeChartStats(c.getNoteData(), c.getTimingData(song.timing), c.stepsType);
}

describe('chartStats tech counts (ITGmania StepParity parity)', () => {
  it('a clean alternating stream has no tech', () => {
    // L D U R L D U R (8ths) — the solver foots it without crossing.
    const s = chart(150, '1000\n0100\n0010\n0001\n1000\n0100\n0010\n0001');
    expect(s.tech).toEqual({
      crossovers: 0,
      footswitches: 0,
      sideswitches: 0,
      jacks: 0,
      brackets: 0,
    });
  });

  it('L, U, R produces one crossover', () => {
    // The solver crosses to reach R rather than pay for a doublestep.
    expect(chart(150, '1000\n0010\n0001\n0000').tech!.crossovers).toBe(1);
  });

  it('repeated side arrows are jacks and sideswitches', () => {
    // 16 Lefts at 16ths: the solver jacks most and sideswitches the rest.
    const body = Array.from({ length: 16 }, () => '1000').join('\n');
    const s = chart(150, body).tech!;
    expect(s.jacks).toBe(10);
    expect(s.sideswitches).toBe(5);
    expect(s.crossovers).toBe(0);
    expect(s.footswitches).toBe(0);
  });

  it('a fast bracketable jump is bracketed by one foot', () => {
    // 16-line measure (16ths @150 = 0.1s): an Up, then a Left+Down jump close
    // enough that one foot brackets both rather than jumping.
    const body = ['0010', '1100', ...Array.from({ length: 14 }, () => '0000')].join('\n');
    expect(chart(150, body).tech!.brackets).toBe(1);
  });

  it('counts notes, holds, mines and jumps', () => {
    // row0: L+R jump; row1: Down hold head; row2: hold tail; row3: mine on Up.
    const s = chart(150, '1001\n0200\n0300\n00M0');
    expect(s.steps).toBe(2); // two step rows (the jump row + the hold-head row)
    expect(s.jumps).toBe(1);
    expect(s.holds).toBe(1);
    expect(s.mines).toBe(1);
  });
});
