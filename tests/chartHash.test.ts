/**
 * Chart content identity (src/song/chartHash.ts): cosmetic simfile edits must
 * not move a chart to a different leaderboard; changes to what is played must.
 */

import { describe, expect, it } from 'vitest';
import { parseSimfile } from '../src/parse/loader';
import { chartHash, chartIdentity } from '../src/song/chartHash';

const NOTES = `#NOTES:
     dance-single:
     :
     Medium:
     5:
     0,0,0,0,0:
1000
0100
0010
0001
;`;

const sm = (headers: string, notes = NOTES) => `${headers}\n#BPMS:0.000=120.000;\n${notes}`;

async function hashOf(content: string): Promise<string> {
  const song = parseSimfile(content, 'test.sm');
  return chartHash(song, song.charts[0]);
}

describe('chartHash', () => {
  it('is 16 lowercase hex chars', async () => {
    expect(await hashOf(sm('#TITLE:A;#ARTIST:B;#OFFSET:0;'))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ignores cosmetic differences: title, artist, offset, banner, file name', async () => {
    const a = await hashOf(sm('#TITLE:Song A;#ARTIST:X;#OFFSET:0.000;#BANNER:a.png;'));
    const b = await hashOf(sm('#TITLE:Renamed (v2);#ARTIST:Y;#OFFSET:-0.062;#BANNER:b.png;'));
    expect(a).toBe(b);
  });

  it('changes when the steps change', async () => {
    const moved = NOTES.replace('1000', '0001');
    const a = await hashOf(sm('#TITLE:A;'));
    const b = await hashOf(sm('#TITLE:A;', moved));
    expect(a).not.toBe(b);
  });

  it('changes when the tempo map changes', async () => {
    const a = await hashOf('#TITLE:A;\n#BPMS:0.000=120.000;\n' + NOTES);
    const b = await hashOf('#TITLE:A;\n#BPMS:0.000=150.000;\n' + NOTES);
    expect(a).not.toBe(b);
  });

  it('ignores the difficulty label and meter (charts get re-rated)', async () => {
    const rerated = NOTES.replace('Medium:', 'Hard:').replace('5:', '9:');
    const a = await hashOf(sm('#TITLE:A;'));
    const b = await hashOf(sm('#TITLE:A;', rerated));
    expect(a).toBe(b);
  });

  it('identity string covers type, tracks, notes, and tempo', () => {
    const song = parseSimfile(sm('#TITLE:A;'), 'test.sm');
    const id = chartIdentity(song, song.charts[0]);
    expect(id).toContain('dance-single');
    expect(id).toContain('tracks=4');
    expect(id).toContain('bpms');
  });
});
