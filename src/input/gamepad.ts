/**
 * Stateless gamepad reader for controllers/dance pads that present via the
 * Gamepad API. Poll-only, so gameplay timing is frame-quantized (coarser than
 * keyboard) — inherent to the platform. Input is merged across EVERY connected
 * pad (a role is pressed if any pad presses it), so a dance pad and a hand
 * controller can be used side by side without picking one. By default the four
 * panels come from dance-pad buttons 0-3 (with the dpad / left stick as
 * fallbacks for OS-mapped pads); but panel layouts vary wildly (e.g. many
 * L-Tek pads put panels on arbitrary buttons), so each role accepts a button
 * OVERRIDE — the `Bindings.gamepad` map persisted in settings and passed in by
 * the caller (the input bus). Overrides are button indices and apply to every
 * pad. This module owns NO persistence.
 *
 * Keyboard-encoder pads (many L-Tek) emit KEY presses, not gamepad buttons —
 * those go through the (rebindable) keyboard path instead.
 */

import type { ControlRole } from './controls';

/** Per-role pressed state, plus whether any pad is connected. */
export type GamepadRead = Record<ControlRole, boolean> & {
  connected: boolean;
  /**
   * Newest `Gamepad.timestamp` across the connected pads — when the browser
   * last sampled the device, on the same clock as `performance.now()`. The
   * input bus attributes a transition seen this poll to this sample time
   * instead of the (coarser) poll-frame time, cutting frame-quantization
   * jitter. 0/undefined when the platform doesn't provide it (older Firefox).
   */
  timestamp?: number;
};

const AXIS_THRESHOLD = 0.5;

// Default pad button(s) per role when the user hasn't rebound it. Dance-pad
// friendly: arrows on buttons 0-3 (left 0, right 1, up 2, down 3), Start 10 /
// Select 11. The dpad (12-15) and standard Start/Back (9/8) stay as fallbacks so
// ordinary gamepads still work; the left stick also drives the panels.
export const DEFAULT_GAMEPAD_BUTTONS: Readonly<Record<ControlRole, readonly number[]>> = {
  left: [0, 14],
  down: [3, 13],
  up: [2, 12],
  right: [1, 15],
  confirm: [10, 9],
  back: [11, 8],
};

/** Every connected pad (the Gamepad API array is sparse; nulls are skipped). */
function connectedPads(): Gamepad[] {
  const pads =
    typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  const out: Gamepad[] = [];
  for (const p of pads) if (p) out.push(p);
  return out;
}

/** Live snapshot of one connected pad, for the controls screen's device list. */
export interface PadInfo {
  index: number;
  id: string;
  /** 'standard' when the browser recognized the layout; '' otherwise. */
  mapping: string;
  /** Button indices currently pressed on this pad. */
  pressed: number[];
  /** [axis index, value rounded to 1dp] for axes pushed past the threshold —
   *  surfaces pads whose panels arrive as hat-switch axes (common in Firefox). */
  hotAxes: Array<[number, number]>;
}

/** Snapshot every connected pad (diagnostics: proves what the browser sees). */
export function connectedPadInfo(): PadInfo[] {
  return connectedPads().map((gp) => ({
    index: gp.index,
    id: gp.id || 'Gamepad',
    mapping: gp.mapping,
    pressed: gp.buttons.flatMap((b, i) => (b?.pressed ? [i] : [])),
    hotAxes: gp.axes.flatMap((v, i): Array<[number, number]> => {
      return Math.abs(v) >= AXIS_THRESHOLD ? [[i, Math.round(v * 10) / 10]] : [];
    }),
  }));
}

/** Button indices currently pressed on ANY pad — for the bind-capture flow. */
export function pressedGamepadButtons(): number[] {
  const seen = new Set<number>();
  for (const gp of connectedPads()) {
    gp.buttons.forEach((b, i) => {
      if (b?.pressed) seen.add(i);
    });
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Read every role's pressed state, honoring the given per-role button
 * overrides. States are OR-merged across all connected pads.
 */
export function readGamepad(overrides: Partial<Record<ControlRole, number>> = {}): GamepadRead {
  const out: GamepadRead = {
    left: false,
    down: false,
    up: false,
    right: false,
    confirm: false,
    back: false,
    connected: false,
  };
  const pads = connectedPads();
  if (pads.length === 0) return out;
  out.connected = true;
  // The freshest device-sample time across pads (see GamepadRead.timestamp).
  let ts = 0;
  for (const gp of pads) if (gp.timestamp > ts) ts = gp.timestamp;
  out.timestamp = ts;

  // Buttons the user rebound to a panel — excluded from the default confirm/back
  // so a panel press on one of those buttons doesn't also fire a menu action.
  const userCols = new Set(
    [overrides.left, overrides.down, overrides.up, overrides.right].filter(
      (v): v is number => v != null,
    ),
  );

  for (const gp of pads) {
    const btn = (i: number) => gp.buttons[i]?.pressed ?? false;
    const ax = gp.axes;
    const axFor: Record<ControlRole, boolean> = {
      left: (ax[0] ?? 0) < -AXIS_THRESHOLD,
      right: (ax[0] ?? 0) > AXIS_THRESHOLD,
      up: (ax[1] ?? 0) < -AXIS_THRESHOLD,
      down: (ax[1] ?? 0) > AXIS_THRESHOLD,
      confirm: false,
      back: false,
    };

    // An explicit user binding wins; otherwise the DEFAULT_GAMEPAD_BUTTONS for
    // the role (dance-pad arrows / Start / Select, with dpad + standard
    // Start/Back as fallbacks); panels also accept the left stick.
    const read = (role: ControlRole): boolean => {
      const b = overrides[role];
      if (b != null) return btn(b);
      for (const i of DEFAULT_GAMEPAD_BUTTONS[role]) {
        if ((role === 'confirm' || role === 'back') && userCols.has(i)) continue;
        if (btn(i)) return true;
      }
      return axFor[role];
    };

    out.left ||= read('left');
    out.down ||= read('down');
    out.up ||= read('up');
    out.right ||= read('right');
    out.confirm ||= read('confirm');
    out.back ||= read('back');
  }
  return out;
}
