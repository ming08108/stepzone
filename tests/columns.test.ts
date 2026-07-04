import { describe, expect, it } from 'vitest';
import { columnAnglesFor } from '../src/render/columns';

describe('columnAnglesFor (todo #15)', () => {
  it('dance-single is Left, Down, Up, Right', () => {
    expect(columnAnglesFor('dance-single', 4)).toEqual([-Math.PI / 2, Math.PI, 0, Math.PI / 2]);
  });

  it('dance-solo has 6 columns with the two upper diagonals', () => {
    const a = columnAnglesFor('dance-solo', 6);
    expect(a).toHaveLength(6);
    expect(a[1]).toBeCloseTo(-Math.PI / 4); // ↖ up-left
    expect(a[4]).toBeCloseTo(Math.PI / 4); // ↗ up-right
  });

  it('dance-double mirrors single across two pads', () => {
    expect(columnAnglesFor('dance-double', 8)).toHaveLength(8);
  });

  it('unknown types cycle L D U R to fill the tracks', () => {
    expect(columnAnglesFor('techno-single8', 8)).toHaveLength(8);
  });
});
