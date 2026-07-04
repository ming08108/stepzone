/**
 * Per-column arrow directions (radians) for each steps-type, so 6/8-panel modes
 * draw the right arrows (fixes dance-solo/double looking wrong). The base "up"
 * arrow is rotated by these angles. See the Style column tables in spec doc 7.
 */

const L = -Math.PI / 2; // ←
const D = Math.PI; // ↓
const U = 0; // ↑
const R = Math.PI / 2; // →
const UL = -Math.PI / 4; // ↖
const UR = Math.PI / 4; // ↗
const DL = (-3 * Math.PI) / 4; // ↙
const DR = (3 * Math.PI) / 4; // ↘

export function columnAnglesFor(stepsType: string, numTracks: number): number[] {
  switch (stepsType) {
    case 'dance-single':
    case 'techno-single4':
      return [L, D, U, R];
    case 'dance-double':
    case 'dance-couple':
    case 'dance-routine':
      return [L, D, U, R, L, D, U, R];
    case 'dance-solo':
      return [L, UL, D, U, UR, R];
    case 'dance-threepanel':
      return [UL, D, UR];
    case 'pump-single':
      return [DL, UL, U, UR, DR];
    case 'pump-double':
    case 'pump-couple':
    case 'pump-routine':
      return [DL, UL, U, UR, DR, DL, UL, U, UR, DR];
    default: {
      const base = [L, D, U, R];
      return Array.from({ length: numTracks }, (_, i) => base[i % 4] ?? U);
    }
  }
}
