import { describe, expect, it } from 'vitest';
import { parseNoteGrid } from '../src/notes/noteGrid';
import { beatToNoteRow, TapNoteType, TapNoteSubType } from '../src/notes/noteTypes';

describe('note grid decode (spec doc 3 §3.7)', () => {
  // The worked-example chart body (dance-single, 4 columns L D U R).
  const grid = ['1000', '0100', '0010', '0002', ',', '0000', '0003', 'M000', '0000'].join('\n');
  const nd = parseNoteGrid(grid, 4);

  it('places taps at the right rows', () => {
    expect(nd.getTapNote(0, beatToNoteRow(0)).type).toBe(TapNoteType.Tap); // L @ beat 0
    expect(nd.getTapNote(1, beatToNoteRow(1)).type).toBe(TapNoteType.Tap); // D @ beat 1
    expect(nd.getTapNote(2, beatToNoteRow(2)).type).toBe(TapNoteType.Tap); // U @ beat 2
  });

  it('decodes a hold head with the correct duration and subtype', () => {
    const head = nd.getTapNote(3, beatToNoteRow(3)); // R @ beat 3
    expect(head.type).toBe(TapNoteType.HoldHead);
    expect(head.subType).toBe(TapNoteSubType.Hold);
    // tail at beat 5 -> duration = (240 - 144) rows = 2 beats.
    expect(head.durationRows).toBe(beatToNoteRow(5) - beatToNoteRow(3));
  });

  it('decodes a mine', () => {
    expect(nd.getTapNote(0, beatToNoteRow(6)).type).toBe(TapNoteType.Mine); // L @ beat 6
  });

  it('collapses adjacent commas (,, is not empty measures)', () => {
    // "1000,,0001": the empty middle token is dropped, so measure indices are
    // 0 and 1 (beats 0 and 4), NOT 0 and 8.
    const nd2 = parseNoteGrid('1000,,0001', 4);
    expect(nd2.getTapNote(0, beatToNoteRow(0)).type).toBe(TapNoteType.Tap);
    expect(nd2.getTapNote(3, beatToNoteRow(4)).type).toBe(TapNoteType.Tap);
    expect(nd2.getTapNote(3, beatToNoteRow(8)).type).toBe(TapNoteType.Empty);
  });

  it('warns on an unmatched hold head and drops it', () => {
    const warnings: string[] = [];
    const nd3 = parseNoteGrid('0002\n0000', 4, warnings);
    expect(nd3.getTapNote(3, beatToNoteRow(0)).type).toBe(TapNoteType.Empty);
    expect(warnings.some((w) => w.includes('Unmatched hold head'))).toBe(true);
  });
});
