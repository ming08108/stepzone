import { describe, expect, it } from 'vitest';
import { parseSimfile } from '../src/parse/loader';

describe('parse warnings reach the loader boundary', () => {
  it('collects .sm chart warnings through parseSimfile', () => {
    const sm = '#TITLE:Bad;\n#BPMS:0=120;\n#NOTES:dance-single:desc:Hard:5;\n';
    const warnings: string[] = [];
    const song = parseSimfile(sm, 'bad.sm', warnings);
    expect(song.charts).toHaveLength(0);
    expect(warnings).toContain('#NOTES with fewer than 6 fields skipped.');
  });

  it('collects .ssc warnings for an unterminated #NOTEDATA block', () => {
    const ssc = '#TITLE:Bad;\n#BPMS:0=120;\n#NOTEDATA:;\n#STEPSTYPE:dance-single;\n';
    const warnings: string[] = [];
    const song = parseSimfile(ssc, 'bad.ssc', warnings);
    expect(song.charts).toHaveLength(1); // chart is kept, just empty
    expect(warnings.some((w) => w.includes('#NOTEDATA'))).toBe(true);
  });

  it('stays backward compatible: the warnings argument is optional', () => {
    const sm = '#TITLE:Fine;\n#BPMS:0=120;\n';
    expect(parseSimfile(sm, 'fine.sm').title).toBe('Fine');
  });
});
