import { describe, expect, it } from 'vitest';
import { NoteData } from '../src/notes/noteData';
import { makeTap, TapNoteType } from '../src/notes/noteTypes';
import { remapTracks, turnPermutation } from '../src/notes/transforms';

describe('turn mods', () => {
  it('mirror reverses columns', () => {
    expect(turnPermutation('mirror', 4, '')).toEqual([3, 2, 1, 0]);
  });

  it('shuffle is a stable, full permutation', () => {
    const p1 = turnPermutation('shuffle', 4, 'seed');
    const p2 = turnPermutation('shuffle', 4, 'seed');
    expect(p1).toEqual(p2); // deterministic per seed
    expect([...p1].sort()).toEqual([0, 1, 2, 3]); // uses every column once
  });

  it('remapTracks moves a note to its mapped column', () => {
    const nd = new NoteData(4);
    nd.setTapNote(0, 48, makeTap());
    const out = remapTracks(nd, [3, 2, 1, 0]); // mirror
    expect(out.getTapNote(3, 48).type).toBe(TapNoteType.Tap);
    expect(out.getTapNote(0, 48).type).toBe(TapNoteType.Empty);
  });
});
