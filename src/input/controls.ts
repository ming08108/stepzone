/**
 * The shared control vocabulary. A dance cab has four panels (L/D/U/R) plus
 * Start/Select — those are the ROLES both input devices resolve to: keyboard
 * codes via `Bindings.keyboard`, gamepad buttons via `Bindings.gamepad` (see
 * inputBus.ts). In menus the directional roles move focus; in gameplay they are
 * note columns via ROLE_COLUMNS — the (tiny) dance-single Style table (spec
 * doc 7). One bindings model, one vocabulary, so no consumer cares which
 * physical device fired.
 */

export const CONTROL_ROLES = ['left', 'down', 'up', 'right', 'confirm', 'back'] as const;
export type ControlRole = (typeof CONTROL_ROLES)[number];

export function isControlRole(v: unknown): v is ControlRole {
  return typeof v === 'string' && (CONTROL_ROLES as readonly string[]).includes(v);
}

/** Dance-single note columns L D U R = 0 1 2 3 by role (menu-only roles: none). */
export const ROLE_COLUMNS: Readonly<Partial<Record<ControlRole, number>>> = {
  left: 0,
  down: 1,
  up: 2,
  right: 3,
};

/** Note column for a role (dance-single), or undefined for confirm/back. */
export function roleToColumn(role: ControlRole): number | undefined {
  return ROLE_COLUMNS[role];
}

/** Column index -> directional role (inverse of ROLE_COLUMNS; used to migrate
 *  the old code->column keybindings store). */
export const COLUMN_ROLES: readonly ControlRole[] = ['left', 'down', 'up', 'right'];

/**
 * Default keyboard map (KeyboardEvent.code -> role): arrows plus the home-row
 * D F J K for the panels, Enter/Escape (and Backspace) for menus. Keyboard
 * stays first-class because many dance pads (e.g. L-Tek keyboard encoders)
 * emit KEY presses, not gamepad buttons.
 */
export const DEFAULT_KEYBOARD_BINDINGS: Readonly<Record<string, ControlRole>> = {
  ArrowLeft: 'left',
  ArrowDown: 'down',
  ArrowUp: 'up',
  ArrowRight: 'right',
  // Secondary home-row layout (D F J K).
  KeyD: 'left',
  KeyF: 'down',
  KeyJ: 'up',
  KeyK: 'right',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
  Slash: 'confirm', // "/" as a handy select key everywhere
  Escape: 'back',
  Backspace: 'back',
};

/**
 * ALL input binds, in one place (persisted inside notefield.settings.v1):
 * - keyboard: code -> role (a code drives exactly one role; several codes may
 *   drive the same role).
 * - gamepad: per-role button-index OVERRIDES. Roles without an override use
 *   the dance-pad-friendly defaults in gamepad.ts (buttons 0-3 / Start /
 *   Select, with dpad + stick fallbacks).
 */
export interface Bindings {
  keyboard: Record<string, ControlRole>;
  gamepad: Partial<Record<ControlRole, number>>;
}

/** A fresh copy of the default bindings (safe to mutate). */
export function defaultBindings(): Bindings {
  return { keyboard: { ...DEFAULT_KEYBOARD_BINDINGS }, gamepad: {} };
}
