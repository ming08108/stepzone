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

describe('gamepad button rebinding (L-Tek etc.)', () => {
  it('maps a rebound button to its column', () => {
    setPad([7]); // an arbitrary pad button, not the dpad
    setGamepadBinding('up', 7);
    const g = readGamepad();
    expect(g.up).toBe(true);
    expect(g.columns[2]).toBe(true); // column 2 = Up
    expect(g.columns[0]).toBe(false);
  });

  it('a button rebound to a column no longer fires confirm/back', () => {
    setPad([1]); // button 1 is the default "back"
    setGamepadBinding('right', 1); // ...but the pad uses it for the Right panel
    const g = readGamepad();
    expect(g.right).toBe(true);
    expect(g.back).toBe(false);
  });

  it('falls back to the dpad + A/B when unbound', () => {
    setPad([12, 0]); // dpad-up + A
    const g = readGamepad();
    expect(g.up).toBe(true);
    expect(g.confirm).toBe(true);
  });
});
