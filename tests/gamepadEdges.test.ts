import { describe, expect, it } from 'vitest';
import {
  createEdgeDetector,
  createGamepadEdgeDetector,
  createTransitionDetector,
} from '../src/input/gamepadEdges';

const ROLES = ['up', 'down', 'confirm'] as const;

describe('createEdgeDetector (named states)', () => {
  it('seeds on the first connected sample: a held button is not a press', () => {
    const detect = createEdgeDetector(ROLES);
    expect(detect(true, { confirm: true })).toEqual([]);
    // still held on the next frame — no edge either
    expect(detect(true, { confirm: true })).toEqual([]);
  });

  it('reports a rising edge exactly once, and again after release', () => {
    const detect = createEdgeDetector(ROLES);
    detect(true, {}); // seed
    expect(detect(true, { up: true })).toEqual(['up']);
    expect(detect(true, { up: true })).toEqual([]); // held, no repeat
    expect(detect(true, {})).toEqual([]); // released
    expect(detect(true, { up: true })).toEqual(['up']); // pressed again
  });

  it('returns simultaneous edges in key order', () => {
    const detect = createEdgeDetector(ROLES);
    detect(true, {});
    expect(detect(true, { confirm: true, up: true, down: true })).toEqual([
      'up',
      'down',
      'confirm',
    ]);
  });

  it('re-seeds after a disconnect: a button held across reconnect is not a press', () => {
    const detect = createEdgeDetector(ROLES);
    detect(true, {}); // seed
    expect(detect(true, { down: true })).toEqual(['down']);
    expect(detect(false, {})).toEqual([]); // disconnect
    expect(detect(true, { down: true })).toEqual([]); // reconnect sample only seeds
    expect(detect(true, { down: true, up: true })).toEqual(['up']);
  });

  it('treats missing keys as unpressed', () => {
    const detect = createEdgeDetector(ROLES);
    detect(true, { up: true });
    // `up` omitted = released; pressing again is a fresh edge
    detect(true, {});
    expect(detect(true, { up: true })).toEqual(['up']);
  });
});

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

function pad(pressed: number[], length = 8): { buttons: { pressed: boolean }[] } {
  return { buttons: Array.from({ length }, (_, i) => ({ pressed: pressed.includes(i) })) };
}

describe('createGamepadEdgeDetector (button indices)', () => {
  it('seeds on the first pad sample: held buttons are not presses', () => {
    const detect = createGamepadEdgeDetector();
    expect(detect(pad([0, 3]))).toEqual([]);
    expect(detect(pad([0, 3]))).toEqual([]);
  });

  it('yields rising-edge button indices', () => {
    const detect = createGamepadEdgeDetector();
    detect(pad([]));
    expect(detect(pad([2]))).toEqual([2]);
    expect(detect(pad([2, 5]))).toEqual([5]); // 2 still held, only 5 is new
    expect(detect(pad([]))).toEqual([]);
    expect(detect(pad([2]))).toEqual([2]);
  });

  it('re-seeds when the pad disappears (null)', () => {
    const detect = createGamepadEdgeDetector();
    detect(pad([]));
    expect(detect(pad([1]))).toEqual([1]);
    expect(detect(null)).toEqual([]);
    expect(detect(pad([1]))).toEqual([]); // held across reconnect — seed only
    expect(detect(pad([1, 4]))).toEqual([4]);
  });

  it('handles sparse/missing button entries', () => {
    const detect = createGamepadEdgeDetector();
    const sparse = { buttons: [{ pressed: false }, undefined, { pressed: false }] };
    detect(sparse);
    expect(detect({ buttons: [{ pressed: false }, undefined, { pressed: true }] })).toEqual([2]);
  });
});
