import { describe, expect, it } from 'vitest';
import { chartContentHash } from '../src/song/chartHash';
import { Song } from '../src/song/song';
import { Steps } from '../src/song/steps';
import { Difficulty } from '../src/song/difficulty';
import { TimingData } from '../src/timing/timingData';

function mkSong(bpms: Array<{ row: number; bps: number }> = [{ row: 0, bps: 2 }]): Song {
  const s = new Song();
  s.title = 'Song';
  s.artist = 'Artist';
  s.timing.bpms = bpms;
  return s;
}

function mkChart(notes: string, over: Partial<Steps> = {}): Steps {
  const c = new Steps();
  c.stepsType = 'dance-single';
  c.difficulty = Difficulty.Hard;
  c.meter = 9;
  c.noteDataString = notes;
  return Object.assign(c, over);
}

describe('chartContentHash', () => {
  it('is stable and 16 hex chars', () => {
    const song = mkSong();
    const h = chartContentHash(song, mkChart('1000\n0100'));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(chartContentHash(song, mkChart('1000\n0100'))).toBe(h);
  });

  it('ignores metadata: title/artist/difficulty/meter changes keep the hash', () => {
    const a = chartContentHash(mkSong(), mkChart('1000\n0100'));
    const renamed = mkSong();
    renamed.title = 'Other';
    renamed.subtitle = '[EDIT]';
    renamed.artist = 'Someone';
    const b = chartContentHash(
      renamed,
      mkChart('1000\n0100', { difficulty: Difficulty.Beginner, meter: 1 }),
    );
    expect(b).toBe(a);
  });

  it('ignores formatting noise: CRLF, indentation, comments, blank lines', () => {
    const clean = chartContentHash(mkSong(), mkChart('1000\n0100'));
    const noisy = chartContentHash(mkSong(), mkChart('\r\n  1000  // lead-in\r\n\r\n\t0100\r\n'));
    expect(noisy).toBe(clean);
  });

  it('ignores subdivision padding: 8-row measure with empty odd rows = 4-row', () => {
    const four = chartContentHash(mkSong(), mkChart('1000\n0100\n0010\n0001'));
    const eight = chartContentHash(
      mkSong(),
      mkChart('1000\n0000\n0100\n0000\n0010\n0000\n0001\n0000'),
    );
    expect(eight).toBe(four);
    // ...but real notes on the off-rows are a different chart.
    const dense = chartContentHash(
      mkSong(),
      mkChart('1000\n1000\n0100\n0000\n0010\n0000\n0001\n0000'),
    );
    expect(dense).not.toBe(four);
  });

  it('changes when the notes change', () => {
    expect(chartContentHash(mkSong(), mkChart('1000\n0100'))).not.toBe(
      chartContentHash(mkSong(), mkChart('0100\n1000')),
    );
  });

  it('changes with gameplay timing (BPMs) but not with sync offset', () => {
    const base = chartContentHash(mkSong([{ row: 0, bps: 2 }]), mkChart('1000'));
    expect(chartContentHash(mkSong([{ row: 0, bps: 3 }]), mkChart('1000'))).not.toBe(base);
    const resynced = mkSong([{ row: 0, bps: 2 }]);
    resynced.timing.offsetSeconds = 0.42;
    expect(chartContentHash(resynced, mkChart('1000'))).toBe(base);
  });

  it('uses the chart’s own split timing when present', () => {
    const song = mkSong([{ row: 0, bps: 2 }]);
    const split = new TimingData();
    split.bpms = [{ row: 0, bps: 4 }];
    const withSplit = chartContentHash(song, mkChart('1000', { timing: split }));
    expect(withSplit).not.toBe(chartContentHash(song, mkChart('1000')));
  });

  it('distinguishes steps types', () => {
    expect(chartContentHash(mkSong(), mkChart('1000', { stepsType: 'dance-double' }))).not.toBe(
      chartContentHash(mkSong(), mkChart('1000')),
    );
  });
});
