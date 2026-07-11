import { describe, expect, it } from 'vitest';
import { createTransitionDetector } from '../src/input/gamepadEdges';

const ROLES = ['up', 'down', 'confirm'] as const;

describe('createTransitionDetector (presses AND releases)', () => {
  it('seeds on the first connected sample: a held button is neither pressed nor released', () => {
    const detect = createTransitionDetector(ROLES);
    expect(detect(true, { confirm: true })).toEqual({ pressed: [], released: [] });
    expect(detect(true, { confirm: true })).toEqual({ pressed: [], released: [] });
  });

  it('reports rising and falling edges exactly once', () => {
    const detect = createTransitionDetector(ROLES);
    detect(true, {}); // seed
    expect(detect(true, { up: true })).toEqual({ pressed: ['up'], released: [] });
    expect(detect(true, { up: true })).toEqual({ pressed: [], released: [] }); // held
    expect(detect(true, {})).toEqual({ pressed: [], released: ['up'] });
    expect(detect(true, {})).toEqual({ pressed: [], released: [] }); // stays up
    expect(detect(true, { up: true })).toEqual({ pressed: ['up'], released: [] }); // again
  });

  it('reports simultaneous transitions in key order', () => {
    const detect = createTransitionDetector(ROLES);
    detect(true, {});
    detect(true, { up: true, confirm: true });
    expect(detect(true, { down: true })).toEqual({
      pressed: ['down'],
      released: ['up', 'confirm'],
    });
  });

  it('a disconnect releases everything previously down, then re-seeds', () => {
    const detect = createTransitionDetector(ROLES);
    detect(true, {}); // seed
    detect(true, { down: true, confirm: true });
    expect(detect(false, {})).toEqual({ pressed: [], released: ['down', 'confirm'] });
    expect(detect(false, {})).toEqual({ pressed: [], released: [] }); // stays quiet
    // Reconnect sample only seeds — a button held across reconnect is not a press.
    expect(detect(true, { down: true })).toEqual({ pressed: [], released: [] });
    expect(detect(true, { down: true, up: true })).toEqual({ pressed: ['up'], released: [] });
  });

  it('a seeded-held button that goes up IS reported as released', () => {
    const detect = createTransitionDetector(ROLES);
    detect(true, { confirm: true }); // seeded holding confirm
    expect(detect(true, {})).toEqual({ pressed: [], released: ['confirm'] });
  });
});
