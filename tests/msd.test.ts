import { describe, expect, it } from 'vitest';
import { tokenizeMsd, param, tagName } from '../src/parse/msd';

describe('MSD tokenizer', () => {
  it('splits #TAG:v1:v2; into params (tag name has # stripped)', () => {
    const values = tokenizeMsd('#TITLE:Foo;#BPMS:0=120,4=60;');
    expect(values).toHaveLength(2);
    expect(values[0].params).toEqual(['TITLE', 'Foo']);
    expect(values[1].params).toEqual(['BPMS', '0=120,4=60']);
    expect(tagName(values[1])).toBe('BPMS');
    expect(param(values[1], 1)).toBe('0=120,4=60');
  });

  it('recovers from missing semicolons (# at line start ends the value)', () => {
    // TITLE has no `;`; the ARTIST tag at line start ends it, trimming trailing
    // whitespace (the recovery path trims; a value flushed at EOF does not).
    const values = tokenizeMsd('#TITLE:Foo\n#ARTIST:Bar;');
    expect(values).toHaveLength(2);
    expect(values[0].params).toEqual(['TITLE', 'Foo']);
    expect(values[1].params).toEqual(['ARTIST', 'Bar']);
  });

  it('strips // line comments', () => {
    const values = tokenizeMsd('#TITLE:Foo//secret\n;');
    expect(param(values[0], 1).trim()).toBe('Foo');
    expect(param(values[0], 1)).not.toContain('secret');
  });

  it('unescapes backslash escapes', () => {
    const values = tokenizeMsd('#TITLE:A\\:B;');
    expect(param(values[0], 1)).toBe('A:B');
  });

  it('returns "" for out-of-range params', () => {
    const values = tokenizeMsd('#NOTEDATA:;');
    expect(param(values[0], 5)).toBe('');
  });
});
