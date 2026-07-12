import { describe, expect, it } from 'vitest';
import { parseSimfile } from '../src/parse/loader';
import { computeChartStats } from '../src/analysis/chartStats';

// Columns: 0=Left, 1=Down, 2=Up, 3=Right.
function chart(bpm: number, body: string) {
  const sm = `#TITLE:t;\n#BPMS:0.000=${bpm.toFixed(3)};\n#NOTES:\ndance-single:\n:\nChallenge:\n10:\n:\n${body}\n;\n`;
  const song = parseSimfile(sm, 't.sm');
  const c = song.charts[0];
  return computeChartStats(c.getNoteData(), c.getTimingData(song.timing), c.stepsType);
}

describe('chartStats tech counts', () => {
  it('a plain alternating stream has no tech', () => {
    // L D U R L D U R (8ths) — clean crossover-free alternation (left foot stays
    // on left/centre, right foot on centre/right).
    const s = chart(150, '1000\n0100\n0010\n0001\n1000\n0100\n0010\n0001');
    expect(s.tech).not.toBeNull();
    expect(s.tech!.crossovers).toBe(0);
    expect(s.tech!.jacks).toBe(0);
    expect(s.tech!.footswitches).toBe(0);
    expect(s.tech!.sideswitches).toBe(0);
  });

  it('repeated up arrows at 8ths are footswitches', () => {
    // 8 Ups in a measure (8th notes @150 = 0.2s: slower than a jack, within a
    // footswitch) → alternating feet on the same up arrow.
    const s = chart(150, '0010\n0010\n0010\n0010\n0010\n0010\n0010\n0010');
    expect(s.tech!.footswitches).toBe(7);
    expect(s.tech!.jacks).toBe(0);
    expect(s.tech!.crossovers).toBe(0);
  });

  it('repeated side arrows at 16ths are jacks', () => {
    // 16 Lefts in a measure (16th @150 = 0.1s: fast → same foot on a side arrow,
    // which a player jacks rather than sideswitches).
    const body = Array.from({ length: 16 }, () => '1000').join('\n');
    const s = chart(150, body);
    expect(s.tech!.jacks).toBe(15);
    expect(s.tech!.footswitches).toBe(0);
    expect(s.tech!.crossovers).toBe(0);
  });

  it('L, U, R produces a crossover (alternation crosses to the far arrow)', () => {
    // left foot L, right foot U, left foot alternates across to R. ITGmania's
    // solver crosses here too (a doublestep would cost far more), regardless of
    // speed.
    expect(chart(150, '1000\n0010\n0001\n0000').tech!.crossovers).toBe(1);
    expect(chart(150, '1000\n0010\n0001\n0000\n0000\n0000\n0000\n0000').tech!.crossovers).toBe(1);
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
