import { describe, expect, it } from 'vitest';
import { HoldNoteScore, TapNoteScore } from '../src/notes/noteTypes';
import {
  GRADE_TIERS,
  gradeFromPercent,
  holdDancePoints,
  holdGradePoints,
  holdLifeDelta,
  tapDancePoints,
  tapGradePoints,
  tapLifeDelta,
} from '../src/gameplay/scoring';

describe('gradeFromPercent: tier boundaries (both sides of every cutoff)', () => {
  const EPS = 1e-9;
  const cases: Array<[number, string]> = [
    [1.5, 'AAA'], // above the top tier still AAA
    [1.0, 'AAA'], // exact AAA cutoff
    [1.0 - EPS, 'AA'], // just below AAA
    [0.93, 'AA'], // exact AA cutoff
    [0.93 - EPS, 'A'], // just below AA
    [0.8, 'A'], // exact A cutoff
    [0.8 - EPS, 'B'], // just below A
    [0.65, 'B'], // exact B cutoff
    [0.65 - EPS, 'C'], // just below B
    [0.45, 'C'], // exact C cutoff
    [0.45 - EPS, 'D'], // just below C
    [0, 'D'],
    [-1, 'D'], // negative grade-point totals still map to D
  ];
  for (const [percent, grade] of cases) {
    it(`${percent} -> ${grade}`, () => {
      expect(gradeFromPercent(percent)).toBe(grade);
    });
  }

  it('GRADE_TIERS pins the exact cutoffs in descending order', () => {
    expect(GRADE_TIERS.map((t) => t.name)).toEqual(['AAA', 'AA', 'A', 'B', 'C', 'D']);
    expect(GRADE_TIERS.map((t) => t.min)).toEqual([1.0, 0.93, 0.8, 0.65, 0.45, -Infinity]);
  });
});

describe('tapGradePoints: letter-grade weights per TapNoteScore', () => {
  it('rewards W1/W2 equally and W3 half as much', () => {
    expect(tapGradePoints(TapNoteScore.W1)).toBe(2);
    expect(tapGradePoints(TapNoteScore.W2)).toBe(2);
    expect(tapGradePoints(TapNoteScore.W3)).toBe(1);
  });

  it('is neutral for W4, AvoidMine, and None', () => {
    expect(tapGradePoints(TapNoteScore.W4)).toBe(0);
    expect(tapGradePoints(TapNoteScore.AvoidMine)).toBe(0);
    expect(tapGradePoints(TapNoteScore.None)).toBe(0);
  });

  it('penalizes W5, Miss, and HitMine', () => {
    expect(tapGradePoints(TapNoteScore.W5)).toBe(-4);
    expect(tapGradePoints(TapNoteScore.Miss)).toBe(-8);
    expect(tapGradePoints(TapNoteScore.HitMine)).toBe(-8);
  });
});

describe('tapDancePoints: %-score weights per TapNoteScore', () => {
  it('scores the 3/2/1 ladder for W1/W2/W3', () => {
    expect(tapDancePoints(TapNoteScore.W1)).toBe(3);
    expect(tapDancePoints(TapNoteScore.W2)).toBe(2);
    expect(tapDancePoints(TapNoteScore.W3)).toBe(1);
  });

  it('gives nothing for W4/W5/Miss/AvoidMine and -2 for HitMine', () => {
    expect(tapDancePoints(TapNoteScore.W4)).toBe(0);
    expect(tapDancePoints(TapNoteScore.W5)).toBe(0);
    expect(tapDancePoints(TapNoteScore.Miss)).toBe(0);
    expect(tapDancePoints(TapNoteScore.AvoidMine)).toBe(0);
    expect(tapDancePoints(TapNoteScore.HitMine)).toBe(-2);
  });
});

describe('hold scoring weights per HoldNoteScore', () => {
  it('only Held earns dance points (3)', () => {
    expect(holdDancePoints(HoldNoteScore.Held)).toBe(3);
    expect(holdDancePoints(HoldNoteScore.LetGo)).toBe(0);
    expect(holdDancePoints(HoldNoteScore.Missed)).toBe(0);
    expect(holdDancePoints(HoldNoteScore.None)).toBe(0);
  });

  it('only Held earns grade points (6)', () => {
    expect(holdGradePoints(HoldNoteScore.Held)).toBe(6);
    expect(holdGradePoints(HoldNoteScore.LetGo)).toBe(0);
    expect(holdGradePoints(HoldNoteScore.Missed)).toBe(0);
    expect(holdGradePoints(HoldNoteScore.None)).toBe(0);
  });
});

describe('tapLifeDelta: life-bar deltas per TapNoteScore', () => {
  it('is positive for the good judgments (W1/W2/W3)', () => {
    expect(tapLifeDelta(TapNoteScore.W1)).toBeCloseTo(0.008, 9);
    expect(tapLifeDelta(TapNoteScore.W2)).toBeCloseTo(0.008, 9);
    expect(tapLifeDelta(TapNoteScore.W3)).toBeCloseTo(0.004, 9);
  });

  it('is zero for W4 and AvoidMine', () => {
    expect(tapLifeDelta(TapNoteScore.W4)).toBe(0);
    expect(tapLifeDelta(TapNoteScore.AvoidMine)).toBe(0);
    expect(tapLifeDelta(TapNoteScore.None)).toBe(0);
  });

  it('is increasingly negative for W5 < Miss < HitMine', () => {
    expect(tapLifeDelta(TapNoteScore.W5)).toBeCloseTo(-0.04, 9);
    expect(tapLifeDelta(TapNoteScore.Miss)).toBeCloseTo(-0.08, 9);
    expect(tapLifeDelta(TapNoteScore.HitMine)).toBeCloseTo(-0.16, 9);
    expect(tapLifeDelta(TapNoteScore.HitMine)).toBeLessThan(tapLifeDelta(TapNoteScore.Miss));
    expect(tapLifeDelta(TapNoteScore.Miss)).toBeLessThan(tapLifeDelta(TapNoteScore.W5));
    expect(tapLifeDelta(TapNoteScore.W5)).toBeLessThan(0);
  });
});

describe('holdLifeDelta: life-bar deltas per HoldNoteScore', () => {
  it('rewards Held, punishes LetGo, and ignores Missed/None', () => {
    expect(holdLifeDelta(HoldNoteScore.Held)).toBeCloseTo(0.008, 9);
    expect(holdLifeDelta(HoldNoteScore.LetGo)).toBeCloseTo(-0.08, 9);
    expect(holdLifeDelta(HoldNoteScore.Missed)).toBe(0);
    expect(holdLifeDelta(HoldNoteScore.None)).toBe(0);
  });
});
