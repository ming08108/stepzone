/**
 * The DOM HUD positions itself against the note field by mirroring the
 * renderer's layout math (gpuNoteField.computeMetrics + GpuSkin.fieldLeft /
 * receptorOffset). This pins the mirrored values at the two reference sizes so
 * a change to either side is caught instead of silently drifting apart.
 */
import { describe, expect, it } from 'vitest';
import { fieldMetrics } from '../src/ui/hud/fieldMetrics';

describe('fieldMetrics mirrors the GPU field layout', () => {
  it('1920×1080 arcade (the mock reference): ds 1.5, 132px lanes, fieldLeft 158.4', () => {
    const m = fieldMetrics(1920, 1080, 4, 'arcade', false);
    expect(m.ds).toBeCloseTo(1.5);
    expect(m.k).toBeCloseTo(1); // the mock is authored at ds 1.5
    expect(m.colW).toBeCloseTo(132);
    expect(m.fieldWidth).toBeCloseTo(528);
    expect(m.fieldLeft).toBeCloseTo(158.4); // max(24ds, 0.22·w − fieldW/2)
    expect(m.fieldRight).toBeCloseTo(686.4);
    expect(m.receptorY).toBeCloseTo(177); // RECEPTOR_OFFSET 118 × ds
  });

  it('1280×720 arcade: ds 1, receptors at 118, reverse flips to the bottom', () => {
    const m = fieldMetrics(1280, 720, 4, 'arcade', false);
    expect(m.ds).toBeCloseTo(1);
    expect(m.colW).toBeCloseTo(88);
    expect(m.fieldLeft).toBeCloseTo(Math.max(24, 0.22 * 1280 - 176));
    expect(m.receptorY).toBeCloseTo(118);
    const rev = fieldMetrics(1280, 720, 4, 'arcade', true);
    expect(rev.receptorY).toBeCloseTo(720 - 118);
  });

  it('itg centres the field and uses its own receptor offset', () => {
    const m = fieldMetrics(1920, 1080, 4, 'itg', false);
    expect(m.fieldLeft).toBeCloseTo((1920 - m.fieldWidth) / 2);
    expect(m.receptorY).toBeCloseTo(78 * 1.5);
  });

  it('narrow canvas: width term clamps ds and fieldLeft floors at 24ds', () => {
    const m = fieldMetrics(600, 1080, 4, 'arcade', false);
    expect(m.ds).toBeCloseTo(600 / 720);
    expect(m.fieldLeft).toBeCloseTo(24 * m.ds); // 0.22·600 − fieldW/2 < 24ds
  });
});
