import { afterEach, describe, expect, it } from 'vitest';
import { readGamepad, resetGamepadBindings, setGamepadBinding } from '../src/input/gamepad';

function setPad(pressed: number[]): void {
  const pad = {
    connected: true,
    buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i) })),
    axes: [0, 0, 0, 0],
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => [pad] },
    configurable: true,
    writable: true,
  });
}

afterEach(() => resetGamepadBindings());

describe('gamepad defaults + rebinding (dance pads)', () => {
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

  it('maps a rebound button to its column', () => {
    setPad([7]); // an arbitrary pad button, not a default
    setGamepadBinding('up', 7);
    const g = readGamepad();
    expect(g.up).toBe(true);
    expect(g.columns[2]).toBe(true); // column 2 = Up
    expect(g.columns[0]).toBe(false);
  });

  it('a button rebound to a column no longer fires the default confirm/back', () => {
    setPad([10]); // button 10 is the default Start (confirm)
    setGamepadBinding('up', 10); // ...but the user maps it to the Up panel
    const g = readGamepad();
    expect(g.up).toBe(true);
    expect(g.confirm).toBe(false);
  });
});
