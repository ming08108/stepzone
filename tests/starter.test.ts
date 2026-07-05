import { describe, expect, it } from 'vitest';

import { expandNotes, measureCount, STARTER_CHARTS } from '../src/starter/charts';
import { STARTER_SONG_DEFS } from '../src/starter/songs';
import { renderSamples, samplesToWav } from '../src/starter/trackSynth';
import { starterEntries, starterSsc, STARTER_PACK } from '../src/starter';

const ROWS_PER_BEAT = 48;

describe('starter charts', () => {
  it('expands measure runs into comma-separated row blocks', () => {
    const body = expandNotes([
      ['1000 0000 0100 0000', 2],
      ['0001 0010 0100 1000', 1],
    ]);
    const measures = body.split(',');
    expect(measures).toHaveLength(3);
    expect(measures[0].trim().split('\n')).toEqual(['1000', '0000', '0100', '0000']);
    expect(measures[2].trim().split('\n')[0]).toBe('0001');
  });

  it('every chart covers exactly its song, in valid rows', () => {
    for (const def of STARTER_SONG_DEFS) {
      const charts = STARTER_CHARTS[def.title];
      expect(charts.length).toBeGreaterThanOrEqual(3);
      for (const chart of charts) {
        expect(measureCount(chart.measures), `${def.title} ${chart.difficulty}`).toBe(def.bars);
        for (const [measure] of chart.measures) {
          for (const row of measure.split(' ')) {
            expect(row).toMatch(/^[0123M]{4}$/);
          }
        }
        // Holds balance per column within the chart.
        const rows = expandNotes(chart.measures)
          .split(/,?\n/)
          .filter((r) => r.length === 4);
        for (let col = 0; col < 4; col++) {
          let open = false;
          for (const row of rows) {
            const ch = row[col];
            if (ch === '2') {
              expect(open, `${def.title} ${chart.difficulty} col ${col}`).toBe(false);
              open = true;
            } else if (ch === '3') {
              expect(open, `${def.title} ${chart.difficulty} col ${col}`).toBe(true);
              open = false;
            }
          }
          expect(open, `${def.title} ${chart.difficulty} col ${col} unclosed`).toBe(false);
        }
      }
    }
  });
});

describe('starter simfiles', () => {
  it('parse with the expected charts, meters, and timing', () => {
    for (const entry of starterEntries()) {
      const def = STARTER_SONG_DEFS.find((d) => d.file === entry.sourceName)!;
      expect(def).toBeDefined();
      expect(entry.pack).toBe(STARTER_PACK);
      expect(entry.song.title).toBe(def.title);
      expect(entry.song.artist).toBe('Stepzone');
      const meters = STARTER_CHARTS[def.title].map((c) => c.meter).sort((a, b) => a - b);
      expect(entry.song.charts.map((c) => c.meter).sort((a, b) => a - b)).toEqual(meters);
      for (const chart of entry.song.charts) {
        expect(chart.stepsType).toBe('dance-single');
        const nd = chart.getNoteData();
        expect(nd.numTracks).toBe(4);
        // All steps land inside the composed song (charts share its bar count).
        expect(nd.lastRow()).toBeLessThanOrEqual(def.bars * 4 * ROWS_PER_BEAT);
        expect(nd.lastRow()).toBeGreaterThan(0);
      }
    }
  });

  it('embeds a preview window at the chorus', () => {
    for (const def of STARTER_SONG_DEFS) {
      expect(starterSsc(def)).toContain(`#SAMPLESTART:${def.sampleStart.toFixed(3)};`);
    }
  });
});

describe('starter audio synth', () => {
  it('renders the composed length, audibly and deterministically', () => {
    const def = STARTER_SONG_DEFS[0];
    const spec = def.spec();
    const a = renderSamples(spec);
    // beats × seconds-per-beat plus the 1.5 s release tail.
    expect(a.length).toBe(Math.ceil((spec.beats * (60 / spec.bpm) + 1.5) * 44100));
    let peak = 0;
    for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]));
    expect(peak).toBeGreaterThan(0.2); // not silence
    expect(peak).toBeLessThanOrEqual(1); // soft-clipped
    const b = renderSamples(def.spec());
    for (let i = 0; i < a.length; i += 9973) expect(b[i]).toBe(a[i]); // same every render
  });

  it('emits a well-formed 16-bit mono WAV', () => {
    const wav = samplesToWav(new Float32Array([0, 0.5, -0.5, 1]));
    const dv = new DataView(wav);
    const tag = (off: number) =>
      String.fromCharCode(
        dv.getUint8(off),
        dv.getUint8(off + 1),
        dv.getUint8(off + 2),
        dv.getUint8(off + 3),
      );
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(dv.getUint16(22, true)).toBe(1); // mono
    expect(dv.getUint32(24, true)).toBe(44100);
    expect(dv.getUint32(40, true)).toBe(8); // 4 samples × 2 bytes
    expect(dv.getInt16(44 + 6, true)).toBe(32767); // full-scale sample
  });

  it('lazily renders and caches each entry audio', () => {
    const entry = starterEntries()[0];
    const first = entry.synthAudio!();
    expect(first.byteLength).toBeGreaterThan(44);
    expect(entry.synthAudio!()).toBe(first); // cached, not re-rendered
  });
});
