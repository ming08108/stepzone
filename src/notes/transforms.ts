/**
 * Column-remapping play modifiers (mirror / left / right / shuffle), à la
 * StepMania's turn mods. A turn permutes which source track feeds each on-screen
 * column, so the arrow directions still match their columns — the *pattern* is
 * transformed. Applied to a copy at play time; the parsed chart is untouched.
 */

import { NoteData } from './noteData';

export type Turn = 'none' | 'mirror' | 'left' | 'right' | 'shuffle';

export const TURNS: readonly Turn[] = ['none', 'mirror', 'left', 'right', 'shuffle'];

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** perm[destCol] = srcTrack. Seed makes 'shuffle' stable per chart. */
export function turnPermutation(turn: Turn, numTracks: number, seedStr = ''): number[] {
  const id = Array.from({ length: numTracks }, (_, i) => i);
  switch (turn) {
    case 'mirror':
      return id.map((_, i) => numTracks - 1 - i);
    case 'left':
      return numTracks === 4 ? [2, 0, 3, 1] : id;
    case 'right':
      return numTracks === 4 ? [1, 3, 0, 2] : id;
    case 'shuffle': {
      const rng = mulberry32(hashString(seedStr) || 1);
      const p = [...id];
      for (let i = p.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
      }
      return p;
    }
    case 'none':
    default:
      return id;
  }
}

/** A new NoteData with tracks remapped: out[dest] = in[perm[dest]]. */
export function remapTracks(nd: NoteData, perm: number[]): NoteData {
  const out = new NoteData(nd.numTracks);
  for (let dest = 0; dest < nd.numTracks; dest++) {
    const src = perm[dest] ?? dest;
    for (const { row, note } of nd.getTrack(src)) out.setTapNote(dest, row, note);
  }
  return out;
}
