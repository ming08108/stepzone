import { describe, expect, it } from 'vitest';
import {
  COLUMN_ROLES,
  CONTROL_ROLES,
  DEFAULT_KEYBOARD_BINDINGS,
  defaultBindings,
  isControlRole,
  ROLE_COLUMNS,
  roleToColumn,
} from '../src/input/controls';

describe('control roles and the role<->column style table', () => {
  it('maps the directional roles to dance-single columns L D U R = 0 1 2 3', () => {
    expect(roleToColumn('left')).toBe(0);
    expect(roleToColumn('down')).toBe(1);
    expect(roleToColumn('up')).toBe(2);
    expect(roleToColumn('right')).toBe(3);
  });

  it('menu-only roles have no column', () => {
    expect(roleToColumn('confirm')).toBeUndefined();
    expect(roleToColumn('back')).toBeUndefined();
  });

  it('COLUMN_ROLES is the exact inverse of ROLE_COLUMNS', () => {
    COLUMN_ROLES.forEach((role, col) => expect(ROLE_COLUMNS[role]).toBe(col));
    expect(COLUMN_ROLES).toHaveLength(4);
  });

  it('isControlRole accepts exactly the role union', () => {
    for (const r of CONTROL_ROLES) expect(isControlRole(r)).toBe(true);
    expect(isControlRole('start')).toBe(false);
    expect(isControlRole(0)).toBe(false);
    expect(isControlRole(null)).toBe(false);
  });
});

describe('default bindings', () => {
  it('keyboard defaults keep the historical gameplay keys (arrows + D F J K)', () => {
    const kb = DEFAULT_KEYBOARD_BINDINGS;
    expect(kb.ArrowLeft).toBe('left');
    expect(kb.ArrowDown).toBe('down');
    expect(kb.ArrowUp).toBe('up');
    expect(kb.ArrowRight).toBe('right');
    expect(kb.KeyD).toBe('left');
    expect(kb.KeyF).toBe('down');
    expect(kb.KeyJ).toBe('up');
    expect(kb.KeyK).toBe('right');
  });

  it('keyboard defaults cover the menu roles', () => {
    expect(DEFAULT_KEYBOARD_BINDINGS.Enter).toBe('confirm');
    expect(DEFAULT_KEYBOARD_BINDINGS.Escape).toBe('back');
  });

  it('defaultBindings returns fresh copies (no shared mutable state)', () => {
    const a = defaultBindings();
    a.keyboard.KeyZ = 'left';
    a.gamepad.up = 9;
    const b = defaultBindings();
    expect(b.keyboard.KeyZ).toBeUndefined();
    expect(b.gamepad.up).toBeUndefined();
    expect(DEFAULT_KEYBOARD_BINDINGS.KeyZ).toBeUndefined();
  });

  it('gamepad defaults are empty overrides (reader defaults apply)', () => {
    expect(defaultBindings().gamepad).toEqual({});
  });
});
