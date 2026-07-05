/**
 * Gamepad reader for controllers/dance pads that present via the Gamepad API.
 * Poll-only, so gameplay timing is frame-quantized (coarser than keyboard) —
 * inherent to the platform. By default the four columns come from the dpad /
 * left-stick axes, which covers OS-mapped pads; but panel layouts vary wildly
 * (e.g. many L-Tek pads put panels on arbitrary buttons), so each role can be
 * rebound to any button — see setGamepadBinding + the GAMEPAD section in Options.
 *
 * Keyboard-encoder pads (many L-Tek) emit KEY presses, not gamepad buttons —
 * those are handled by the (rebindable) keyboard path instead.
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

export type GpRole = 'left' | 'down' | 'up' | 'right' | 'confirm' | 'back';
export const GP_ROLES: readonly GpRole[] = ['left', 'down', 'up', 'right', 'confirm', 'back'];

// Default pad button(s) per role when the user hasn't rebound it. Dance-pad
// friendly: arrows on buttons 0-3 (left 0, right 1, up 2, down 3), Start 10 /
// Select 11. The dpad (12-15) and standard Start/Back (9/8) stay as fallbacks so
// ordinary gamepads still work; the left stick also drives the columns.
const DEFAULT_BUTTONS: Record<GpRole, number[]> = {
  left: [0, 14],
  down: [3, 13],
  up: [2, 12],
  right: [1, 15],
  confirm: [10, 9],
  back: [11, 8],
};

// --- rebindable button map (button index per role), persisted --------------

const GP_KEY = 'notefield.gamepadBindings.v1';

function loadGpBindings(): Partial<Record<GpRole, number>> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(GP_KEY) : null;
    return raw ? (JSON.parse(raw) as Partial<Record<GpRole, number>>) : {};
  } catch {
    return {};
  }
}
let gpBindings = loadGpBindings();
function persistGp(): void {
  try {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(GP_KEY, JSON.stringify(gpBindings));
  } catch {
    // ignore (private mode / quota)
  }
}
export function getGamepadBindings(): Partial<Record<GpRole, number>> {
  return { ...gpBindings };
}
export function setGamepadBinding(role: GpRole, button: number): void {
  gpBindings = { ...gpBindings, [role]: button };
  persistGp();
}
export function clearGamepadBinding(role: GpRole): void {
  const next = { ...gpBindings };
  delete next[role];
  gpBindings = next;
  persistGp();
}
export function resetGamepadBindings(): void {
  gpBindings = {};
  persistGp();
}

// --- reading ----------------------------------------------------------------

function firstPad(): Gamepad | null {
  const pads =
    typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  return Array.from(pads).find((p): p is Gamepad => p != null) ?? null;
}

/** Which pad the reader is using (product id), or null. */
export function gamepadName(): string | null {
  return firstPad()?.id ?? null;
}

/** Button indices currently pressed on the first pad — for the bind-capture flow. */
export function pressedGamepadButtons(): number[] {
  const gp = firstPad();
  if (!gp) return [];
  const out: number[] = [];
  gp.buttons.forEach((b, i) => {
    if (b?.pressed) out.push(i);
  });
  return out;
}

export function readGamepad(): GamepadRead {
  const gp = firstPad();
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
  const axFor: Record<GpRole, boolean> = {
    left: (ax[0] ?? 0) < -AXIS_THRESHOLD,
    right: (ax[0] ?? 0) > AXIS_THRESHOLD,
    up: (ax[1] ?? 0) < -AXIS_THRESHOLD,
    down: (ax[1] ?? 0) > AXIS_THRESHOLD,
    confirm: false,
    back: false,
  };

  // Buttons the user rebound to a column — excluded from the default confirm/back
  // so a panel press on one of those buttons doesn't also fire a menu action.
  const userCols = new Set(
    [gpBindings.left, gpBindings.down, gpBindings.up, gpBindings.right].filter(
      (v): v is number => v != null,
    ),
  );
  // An explicit user binding wins; otherwise the DEFAULT_BUTTONS for the role
  // (dance-pad arrows / Start / Select, with dpad + standard Start/Back as
  // fallbacks); columns also accept the left stick.
  const read = (role: GpRole): boolean => {
    const b = gpBindings[role];
    if (b != null) return btn(b);
    for (const i of DEFAULT_BUTTONS[role]) {
      if ((role === 'confirm' || role === 'back') && userCols.has(i)) continue;
      if (btn(i)) return true;
    }
    return axFor[role];
  };

  const left = read('left');
  const down = read('down');
  const up = read('up');
  const right = read('right');

  return {
    columns: [left, down, up, right],
    up,
    down,
    left,
    right,
    confirm: read('confirm'),
    back: read('back'),
    connected: true,
  };
}
