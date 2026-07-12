import { describe, expect, it } from 'vitest';
import { parseSimfile } from '../src/parse/loader';

const HEADER = '#TITLE:t;\n#MUSIC:t.ogg;\n#OFFSET:0.000;\n#BPMS:0.000=120.000;\n';
const NOTES = '#NOTES:\ndance-single:\n:\nChallenge:\n10:\n:\n0000\n;\n';

describe('#BGCHANGES background-video start beat', () => {
  it('picks the beat of the first movie change', () => {
    const sm = `${HEADER}#BGCHANGES:4.000=clip.avi=1.000=0=0=1=====,;\n${NOTES}`;
    const song = parseSimfile(sm, 't.sm');
    expect(song.bgVideoStartBeat).toBe(4);
    // 120bpm, offset 0 → beat 4 is 2.0s in.
    expect(song.timing.getElapsedTimeFromBeat(song.bgVideoStartBeat)).toBeCloseTo(2, 3);
  });

  it('skips image changes and finds the movie', () => {
    const sm = `${HEADER}#BGCHANGES:0.000=intro.png=1=0=0=0=====,8.000=clip.mp4=1=0=0=1=====,;\n${NOTES}`;
    expect(parseSimfile(sm, 't.sm').bgVideoStartBeat).toBe(8);
  });

  it('defaults to 0 when there is no movie change', () => {
    const sm = `${HEADER}#BGCHANGES:0.000=still.png=1=0=0=0=====,;\n${NOTES}`;
    expect(parseSimfile(sm, 't.sm').bgVideoStartBeat).toBe(0);
  });
});
