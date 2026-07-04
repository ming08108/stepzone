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
  const axLeft = (ax[0] ?? 0) < -AXIS_THRESHOLD;
  const axRight = (ax[0] ?? 0) > AXIS_THRESHOLD;
  const axUp = (ax[1] ?? 0) < -AXIS_THRESHOLD;
  const axDown = (ax[1] ?? 0) > AXIS_THRESHOLD;
  const bound = (role: GpRole) => {
    const b = gpBindings[role];
    return b != null && btn(b);
  };

  // Columns: standard dpad (12-15) or left stick, plus any rebound button.
  const up = btn(12) || axUp || bound('up');
  const down = btn(13) || axDown || bound('down');
  const left = btn(14) || axLeft || bound('left');
  const right = btn(15) || axRight || bound('right');

  // Confirm/back: an explicit binding wins; otherwise A/Start and B/Back — but
  // never a button that's been rebound to a column (so pressing a panel that
  // lives on button 0/1 doesn't also fire menu confirm/back).
  const colButtons = new Set(
    [gpBindings.left, gpBindings.down, gpBindings.up, gpBindings.right].filter(
      (v): v is number => v != null,
    ),
  );
  const confirm =
    gpBindings.confirm != null
      ? btn(gpBindings.confirm)
      : (btn(0) && !colButtons.has(0)) || (btn(9) && !colButtons.has(9));
  const back =
    gpBindings.back != null
      ? btn(gpBindings.back)
      : (btn(1) && !colButtons.has(1)) || (btn(8) && !colButtons.has(8));

  return {
    columns: [left, down, up, right],
    up,
    down,
    left,
    right,
    confirm,
    back,
    connected: true,
  };
}
