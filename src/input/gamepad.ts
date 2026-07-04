/**
 * Gamepad reader for controllers/dance pads that present via the Gamepad API.
 * Poll-only, so gameplay timing is frame-quantized (coarser than keyboard) —
 * inherent to the platform. Dance-pad panel layouts vary; this uses the dpad /
 * left-stick axes for the four columns, which covers most controllers and
 * gamepad-mode pads. Keyboard-encoder pads (e.g. many L-Tek) use the keymap.
 *
 * Note: many L-Tek pads emit KEY presses, not gamepad buttons — those are
 * handled by the (rebindable) keyboard path, not this reader.
 */

export interface GamepadRead {
  /** Dance columns L, D, U, R (0..3). */
  columns: [boolean, boolean, boolean, boolean];
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  /** Menu confirm / back. */
  confirm: boolean;
  back: boolean;
  /** True if any gamepad is connected. */
  connected: boolean;
}

const AXIS_THRESHOLD = 0.5;

export function readGamepad(): GamepadRead {
  const pads =
    typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = Array.from(pads).find((p): p is Gamepad => p != null);
  if (!gp) {
    return {
      columns: [false, false, false, false],
      up: false,
      down: false,
      left: false,
      right: false,
      confirm: false,
      back: false,
      connected: false,
    };
  }

  const btn = (i: number) => gp.buttons[i]?.pressed ?? false;
  const ax = gp.axes;
  const axLeft = (ax[0] ?? 0) < -AXIS_THRESHOLD;
  const axRight = (ax[0] ?? 0) > AXIS_THRESHOLD;
  const axUp = (ax[1] ?? 0) < -AXIS_THRESHOLD;
  const axDown = (ax[1] ?? 0) > AXIS_THRESHOLD;

  // Standard-mapping dpad: 12=up 13=down 14=left 15=right.
  const up = btn(12) || axUp;
  const down = btn(13) || axDown;
  const left = btn(14) || axLeft;
  const right = btn(15) || axRight;

  return {
    columns: [left, down, up, right],
    up,
    down,
    left,
    right,
    confirm: btn(0) || btn(9), // A / Start
    back: btn(1) || btn(8), // B / Back
    connected: true,
  };
}
