/**
 * Unified controller read: the OR of every *polled* input source — the Gamepad
 * API (readGamepad) plus WebHID (readHid). Keyboard input is event-driven and
 * merged separately at its call sites (press/release, keydown nav). The result
 * has the same `GamepadRead` shape as `readGamepad`, so existing consumers can
 * swap `readGamepad()` -> `readControllers()` with no other change.
 */

import { readGamepad, type GamepadRead } from './gamepad';
import { readHid } from './webhid';

export function readControllers(): GamepadRead {
  const g = readGamepad();
  const h = readHid();
  if (!h.connected) return g;
  if (!g.connected) return h;
  return {
    columns: [
      g.columns[0] || h.columns[0],
      g.columns[1] || h.columns[1],
      g.columns[2] || h.columns[2],
      g.columns[3] || h.columns[3],
    ],
    up: g.up || h.up,
    down: g.down || h.down,
    left: g.left || h.left,
    right: g.right || h.right,
    confirm: g.confirm || h.confirm,
    back: g.back || h.back,
    connected: true,
  };
}
