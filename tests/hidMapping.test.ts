import { describe, expect, it } from 'vitest';
import {
  captureBinding,
  emptyHidState,
  HID_ROLES,
  hidStateFromReports,
  isPressed,
  type HidBindings,
  type HidButtonBinding,
  type HidReport,
} from '../src/input/hidMapping';

const report = (bytes: number[], reportId = 0): HidReport => ({ reportId, bytes });

describe('isPressed', () => {
  it('matches a digital button bit', () => {
    const b: HidButtonBinding = { reportId: 0, byteIndex: 1, mask: 0x04, value: 0x04 };
    expect(isPressed(b, report([0x00, 0x04]))).toBe(true);
    expect(isPressed(b, report([0x00, 0x00]))).toBe(false);
    // Other bits in the same byte don't affect the masked test.
    expect(isPressed(b, report([0xff, 0x04 | 0x10]))).toBe(true);
  });

  it('requires the report id to match', () => {
    const b: HidButtonBinding = { reportId: 2, byteIndex: 0, mask: 0x01, value: 0x01 };
    expect(isPressed(b, report([0x01], 2))).toBe(true);
    expect(isPressed(b, report([0x01], 1))).toBe(false);
  });

  it('is false when the byte is out of range', () => {
    const b: HidButtonBinding = { reportId: 0, byteIndex: 9, mask: 0x01, value: 0x01 };
    expect(isPressed(b, report([0x01]))).toBe(false);
  });

  it('matches an active-low control (value 0)', () => {
    const b: HidButtonBinding = { reportId: 0, byteIndex: 0, mask: 0x01, value: 0x00 };
    expect(isPressed(b, report([0x00]))).toBe(true);
    expect(isPressed(b, report([0x01]))).toBe(false);
  });

  it('matches a hat-switch direction (nibble value)', () => {
    const up: HidButtonBinding = { reportId: 0, byteIndex: 3, mask: 0x0f, value: 0x00 };
    const right: HidButtonBinding = { reportId: 0, byteIndex: 3, mask: 0x0f, value: 0x02 };
    expect(isPressed(up, report([0, 0, 0, 0x00]))).toBe(true);
    expect(isPressed(up, report([0, 0, 0, 0x0f]))).toBe(false); // neutral
    expect(isPressed(right, report([0, 0, 0, 0x02]))).toBe(true);
  });
});

describe('captureBinding', () => {
  it('captures a bit that turned on (digital button)', () => {
    const b = captureBinding(report([0x00, 0x00]), report([0x00, 0x08]));
    expect(b).toEqual({ reportId: 0, byteIndex: 1, mask: 0x08, value: 0x08 });
  });

  it('ignores bits already set in the baseline', () => {
    const b = captureBinding(report([0x01, 0x00]), report([0x01, 0x20]));
    expect(b).toEqual({ reportId: 0, byteIndex: 1, mask: 0x20, value: 0x20 });
  });

  it('returns null when nothing changed', () => {
    expect(captureBinding(report([0x01, 0x02]), report([0x01, 0x02]))).toBeNull();
  });

  it('captures a hat direction as a low-nibble value match', () => {
    // Neutral hat = 0x0f, pressing "up" drives the low nibble to 0 (no bit on).
    const b = captureBinding(report([0x0f]), report([0x00]));
    expect(b).toEqual({ reportId: 0, byteIndex: 0, mask: 0x0f, value: 0x00 });
  });

  it('narrows a changed low nibble even when the high nibble holds buttons', () => {
    // High nibble carries an unrelated held button (0x10); only the hat moves.
    const b = captureBinding(report([0x1f]), report([0x12]));
    expect(b).toEqual({ reportId: 0, byteIndex: 0, mask: 0x0f, value: 0x02 });
  });

  it('captures an active-low button as a value match', () => {
    // Bit 0 goes 1 -> 0 on press; no bit turns on, so it is a value binding.
    // Only the low nibble changed, so the mask narrows to 0x0f.
    const rest = report([0xff]);
    const held = report([0xfe]);
    const b = captureBinding(rest, held);
    expect(b).toEqual({ reportId: 0, byteIndex: 0, mask: 0x0f, value: 0x0e });
    expect(isPressed(b!, held)).toBe(true);
    expect(isPressed(b!, rest)).toBe(false);
  });

  it('round-trips: a captured binding reads pressed on the pressed report only', () => {
    const rest = report([0x00, 0x00, 0x0f]);
    const held = report([0x00, 0x02, 0x0f]);
    const b = captureBinding(rest, held);
    expect(b).not.toBeNull();
    expect(isPressed(b!, held)).toBe(true);
    expect(isPressed(b!, rest)).toBe(false);
  });
});

describe('hidStateFromReports', () => {
  const bindings: HidBindings = {
    left: { reportId: 0, byteIndex: 0, mask: 0x01, value: 0x01 },
    down: { reportId: 0, byteIndex: 0, mask: 0x02, value: 0x02 },
    up: { reportId: 0, byteIndex: 0, mask: 0x04, value: 0x04 },
    right: { reportId: 0, byteIndex: 0, mask: 0x08, value: 0x08 },
    confirm: { reportId: 0, byteIndex: 1, mask: 0x01, value: 0x01 },
    back: { reportId: 0, byteIndex: 1, mask: 0x02, value: 0x02 },
  };

  const latestOf = (...entries: Array<[number, number[]]>) =>
    new Map<number, readonly number[]>(entries);

  it('maps pressed bits to columns and menu actions', () => {
    // Left + Up held; confirm held.
    const state = hidStateFromReports(bindings, latestOf([0, [0x05, 0x01]]));
    expect(state.columns).toEqual([true, false, true, false]);
    expect(state.left).toBe(true);
    expect(state.up).toBe(true);
    expect(state.down).toBe(false);
    expect(state.right).toBe(false);
    expect(state.confirm).toBe(true);
    expect(state.back).toBe(false);
  });

  it('columns line up with the L D U R menu directions', () => {
    const state = hidStateFromReports(bindings, latestOf([0, [0x0a, 0x00]])); // down + right
    expect(state.columns).toEqual([false, true, false, true]);
    expect(state.down).toBe(true);
    expect(state.right).toBe(true);
  });

  it('unbound roles and absent report streams read as not pressed', () => {
    expect(hidStateFromReports({}, latestOf([0, [0xff, 0xff]]))).toEqual(emptyHidState());
    // Bindings on report id 0 but the only stream present is id 3.
    const state = hidStateFromReports(bindings, latestOf([3, [0xff]]));
    expect(state.columns).toEqual([false, false, false, false]);
  });

  it('exposes every role name in HID_ROLES', () => {
    expect(HID_ROLES).toEqual(['left', 'down', 'up', 'right', 'confirm', 'back']);
  });
});
