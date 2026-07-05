import { describe, expect, it } from 'vitest';
import { connectedPadInfo, pressedGamepadButtons, readGamepad } from '../src/input/gamepad';
import { roleToColumn } from '../src/input/controls';

function makePad(pressed: number[], axes: number[] = [0, 0, 0, 0], index = 0, id = 'Test Pad') {
  return {
    connected: true,
    index,
    id,
    mapping: 'standard',
    buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i) })),
    axes,
  };
}

/** Install pads into the mocked Gamepad API (nulls mimic the sparse array). */
function setPads(...pads: Array<ReturnType<typeof makePad> | null>): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => pads },
    configurable: true,
    writable: true,
  });
}

function setPad(pressed: number[], axes: number[] = [0, 0, 0, 0]): void {
  setPads(makePad(pressed, axes));
}

describe('gamepad defaults + per-role overrides (dance pads)', () => {
  it('uses dance-pad button defaults (arrows 0-3, Start 10, Select 11)', () => {
    setPad([0]);
    expect(readGamepad().left).toBe(true);
    setPad([1]);
    expect(readGamepad().right).toBe(true);
    setPad([2]);
    expect(readGamepad().up).toBe(true);
    setPad([3]);
    expect(readGamepad().down).toBe(true);
    setPad([10]);
    expect(readGamepad().confirm).toBe(true);
    setPad([11]);
    expect(readGamepad().back).toBe(true);
  });

  it('keeps the dpad + standard Start/Back as fallbacks', () => {
    setPad([12, 9]); // dpad-up + standard Start
    const g = readGamepad();
    expect(g.up).toBe(true);
    expect(g.confirm).toBe(true);
  });

  it('falls back to the left stick for the panels', () => {
    setPad([], [-1, 0]);
    expect(readGamepad().left).toBe(true);
    setPad([], [0, 1]);
    expect(readGamepad().down).toBe(true);
  });

  it('maps an overridden button to its role (and its note column)', () => {
    setPad([7]); // an arbitrary pad button, not a default
    const g = readGamepad({ up: 7 });
    expect(g.up).toBe(true);
    expect(roleToColumn('up')).toBe(2); // column 2 = Up
    expect(g.left).toBe(false);
  });

  it('a button rebound to a panel no longer fires the default confirm/back', () => {
    setPad([10]); // button 10 is the default Start (confirm)
    const g = readGamepad({ up: 10 }); // ...but the user maps it to the Up panel
    expect(g.up).toBe(true);
    expect(g.confirm).toBe(false);
  });

  it('an explicit override wins over the default buttons for that role', () => {
    setPad([2]); // default Up button held
    expect(readGamepad({ up: 7 }).up).toBe(false); // Up now lives on button 7 only
  });

  it('reports disconnected when no pad is present', () => {
    setPads();
    const g = readGamepad();
    expect(g.connected).toBe(false);
    expect(g.left).toBe(false);
    expect(g.confirm).toBe(false);
  });
});

describe('multiple gamepads (input merged across all pads)', () => {
  it('takes input from any connected pad', () => {
    setPads(makePad([0]), makePad([10])); // pad 1 presses Left, pad 2 presses Start
    const g = readGamepad();
    expect(g.connected).toBe(true);
    expect(g.left).toBe(true);
    expect(g.confirm).toBe(true);
    expect(g.right).toBe(false);
  });

  it('skips null slots in the sparse Gamepad API array', () => {
    setPads(null, makePad([2]), null); // only slot 1 is a real pad
    const g = readGamepad();
    expect(g.connected).toBe(true);
    expect(g.up).toBe(true);
  });

  it('merges the left-stick fallback from a second pad', () => {
    setPads(makePad([]), makePad([], [1, 0])); // pad 2 pushes the stick right
    expect(readGamepad().right).toBe(true);
  });

  it('applies a button override on every pad', () => {
    setPads(makePad([]), makePad([7])); // button 7 held on the SECOND pad only
    expect(readGamepad({ up: 7 }).up).toBe(true);
    // ...and the override still disables the role's default buttons everywhere.
    setPads(makePad([2]), makePad([]));
    expect(readGamepad({ up: 7 }).up).toBe(false);
  });

  it('bind capture sees pressed buttons from all pads, deduped and sorted', () => {
    setPads(makePad([5, 1]), makePad([1, 9]));
    expect(pressedGamepadButtons()).toEqual([1, 5, 9]);
  });

  it('connectedPadInfo snapshots every pad with its live buttons and hot axes', () => {
    setPads(makePad([5], [0, 0], 0, 'Pad A'), null, makePad([1, 2], [0, -0.96], 2, 'Pad B'));
    expect(connectedPadInfo()).toEqual([
      { index: 0, id: 'Pad A', mapping: 'standard', pressed: [5], hotAxes: [] },
      { index: 2, id: 'Pad B', mapping: 'standard', pressed: [1, 2], hotAxes: [[1, -1]] },
    ]);
    setPads();
    expect(connectedPadInfo()).toEqual([]);
  });
});
