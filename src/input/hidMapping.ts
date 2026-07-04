/**
 * Pure mapping logic for raw-HID controllers (WebHID). A HID input report is an
 * opaque byte array whose layout varies per device, so rather than hardcode
 * per-device layouts we (a) *capture* a binding by diffing a resting report
 * against one taken while a control is held, and (b) *evaluate* a binding
 * against a later report with a masked-equality test. Everything here is
 * side-effect free and unit-tested; the stateful WebHID plumbing (opening the
 * device, `inputreport` events, localStorage) lives in webhid.ts.
 */

import type { GamepadRead } from './gamepad';

/** A single bindable control: the four dance columns plus the two menu actions. */
export type HidRole = 'left' | 'down' | 'up' | 'right' | 'confirm' | 'back';

/** All roles, in a stable order (columns first, L D U R, then menu actions). */
export const HID_ROLES: readonly HidRole[] = ['left', 'down', 'up', 'right', 'confirm', 'back'];

/**
 * How to detect one control in a HID input report: the control is "pressed"
 * when the report's id matches and `(bytes[byteIndex] & mask) === value`.
 * This masked-equality form covers the common cases with one shape:
 *  - a digital button on bit b:   mask = 1<<b, value = 1<<b
 *  - an active-low button:        mask = 1<<b, value = 0
 *  - a hat-switch direction:      mask = 0x0f, value = <direction code>
 */
export interface HidButtonBinding {
  /** Report id the control lives in (0 when the device uses no report ids). */
  reportId: number;
  /** Index into the report's data bytes (report id byte excluded). */
  byteIndex: number;
  /** Bits to isolate before comparing. */
  mask: number;
  /** Expected masked value that counts as "pressed". */
  value: number;
}

/** Role -> binding table (roles may be unbound). */
export type HidBindings = Partial<Record<HidRole, HidButtonBinding>>;

/** A raw HID input report: its id and the report bytes (id byte excluded). */
export interface HidReport {
  reportId: number;
  bytes: readonly number[];
}

/** True if `binding`'s control reads as pressed in `report`. */
export function isPressed(binding: HidButtonBinding, report: HidReport): boolean {
  if (binding.reportId !== report.reportId) return false;
  const b = report.bytes[binding.byteIndex];
  if (b === undefined) return false;
  return (b & binding.mask) === binding.value;
}

/**
 * Derive a binding for the control that was activated between a resting
 * (`baseline`) report and one taken while the control is held (`pressed`), or
 * `null` if nothing changed.
 *
 * Two passes, in order of confidence:
 *  1. A bit that turned **on** — ordinary buttons and pads that expose panels as
 *     individual bits. Binds the newly-on bits of the first such byte.
 *  2. A byte whose value merely changed (no bit turned on) — hat switches moving
 *     to a lower code, or active-low controls. Binds a whole-byte (or nibble)
 *     value match. The nibble narrowing keeps sibling buttons in the other
 *     nibble from disturbing the match.
 *
 * When the two reports come from different id streams the baseline is treated as
 * all-zero (first-ever sighting of that stream).
 */
export function captureBinding(baseline: HidReport, pressed: HidReport): HidButtonBinding | null {
  const sameStream = baseline.reportId === pressed.reportId;
  const n = Math.max(baseline.bytes.length, pressed.bytes.length);

  // Pass 1: a bit that turned on.
  for (let i = 0; i < n; i++) {
    const base = sameStream ? (baseline.bytes[i] ?? 0) : 0;
    const cur = pressed.bytes[i] ?? 0;
    const turnedOn = cur & ~base & 0xff;
    if (turnedOn !== 0) {
      return { reportId: pressed.reportId, byteIndex: i, mask: turnedOn, value: turnedOn };
    }
  }

  // Pass 2: a byte that changed without any bit turning on.
  for (let i = 0; i < n; i++) {
    const base = sameStream ? (baseline.bytes[i] ?? 0) : 0;
    const cur = pressed.bytes[i] ?? 0;
    if (cur === base) continue;
    const changed = (cur ^ base) & 0xff;
    let mask = 0xff;
    if ((changed & 0xf0) === 0) mask = 0x0f;
    else if ((changed & 0x0f) === 0) mask = 0xf0;
    return { reportId: pressed.reportId, byteIndex: i, mask, value: cur & mask };
  }

  return null;
}

/** A GamepadRead with every field cleared (and `connected: false`). */
export function emptyHidState(): GamepadRead {
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

/**
 * Evaluate every binding against the latest report bytes (keyed by report id)
 * and produce a GamepadRead-shaped snapshot. `connected` is left false for the
 * caller (webhid.ts) to set once it knows a device is attached.
 */
export function hidStateFromReports(
  bindings: HidBindings,
  latest: ReadonlyMap<number, readonly number[]>,
): GamepadRead {
  const test = (role: HidRole): boolean => {
    const b = bindings[role];
    if (!b) return false;
    const bytes = latest.get(b.reportId);
    if (!bytes) return false;
    return isPressed(b, { reportId: b.reportId, bytes });
  };

  const left = test('left');
  const down = test('down');
  const up = test('up');
  const right = test('right');

  return {
    columns: [left, down, up, right],
    up,
    down,
    left,
    right,
    confirm: test('confirm'),
    back: test('back'),
    connected: false,
  };
}
