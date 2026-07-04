/**
 * Bridges a gamepad/dance-pad to the arrow-key navigation the STEPLINE menus
 * already handle: on each button's rising edge it dispatches the matching
 * synthetic keydown (▲▼◀▶ / Enter / Escape), so a controller drives song select
 * and Player Options through their existing keyboard logic — no duplication.
 * Seeded edge-detect so a button already held when the screen opens isn't a
 * press. Use only on menu screens (gameplay reads the pad directly).
 */
import { useEffect } from 'react';
import { type GamepadRead, readGamepad } from '../input/gamepad';

const MAP: Array<[keyof GamepadRead, string]> = [
  ['up', 'ArrowUp'],
  ['down', 'ArrowDown'],
  ['left', 'ArrowLeft'],
  ['right', 'ArrowRight'],
  ['confirm', 'Enter'],
  ['back', 'Escape'],
];

export function useGamepadKeys(): void {
  useEffect(() => {
    let raf = 0;
    let seeded = false;
    let prev: Partial<Record<keyof GamepadRead, boolean>> = {};
    const poll = () => {
      const g = readGamepad();
      if (g.connected) {
        if (seeded) {
          for (const [role, key] of MAP) {
            if (g[role] && !prev[role]) {
              window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            }
          }
        }
        prev = {
          up: g.up,
          down: g.down,
          left: g.left,
          right: g.right,
          confirm: g.confirm,
          back: g.back,
        };
        seeded = true;
      } else {
        seeded = false;
      }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, []);
}
