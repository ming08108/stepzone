import { beforeEach, describe, expect, it } from 'vitest';
import { defaultBindings, type ControlRole } from '../src/input/controls';
import type { GamepadRead } from '../src/input/gamepad';
import { InputBus, type ControlEvent, type KeyEventLike } from '../src/input/inputBus';

/** A fake pad the tests mutate between polls. `timestamp` mimics
 *  Gamepad.timestamp (the device-sample time); 0 = platform didn't provide it. */
function makePad() {
  const state = { connected: false, timestamp: 0, down: new Set<ControlRole>() };
  const read = (): GamepadRead => ({
    connected: state.connected,
    timestamp: state.timestamp,
    left: state.down.has('left'),
    down: state.down.has('down'),
    up: state.down.has('up'),
    right: state.down.has('right'),
    confirm: state.down.has('confirm'),
    back: state.down.has('back'),
  });
  return { state, read };
}

function key(code: string, timeStamp = 100, repeat = false): KeyEventLike {
  return { code, timeStamp, repeat, preventDefault: () => {} };
}

let pad: ReturnType<typeof makePad>;
let bus: InputBus;
let events: ControlEvent[];

beforeEach(() => {
  pad = makePad();
  // No listener target / scheduler: tests drive keyDown/keyUp/pollGamepad directly.
  bus = new InputBus({ target: null, schedule: null, readPad: () => pad.read() });
  events = [];
  bus.subscribe((e) => events.push(e));
});

const brief = (e: ControlEvent) => `${e.device}:${e.role}:${e.pressed ? 'dn' : 'up'}`;

describe('InputBus keyboard path', () => {
  it('resolves codes to roles with the real event timestamps', () => {
    bus.keyDown(key('ArrowLeft', 123.5));
    bus.keyUp(key('ArrowLeft', 200.25));
    expect(events.map(brief)).toEqual(['keyboard:left:dn', 'keyboard:left:up']);
    expect(events[0].timeStampMs).toBe(123.5);
    expect(events[1].timeStampMs).toBe(200.25);
    expect(events[0].repeat).toBe(false);
    expect(events[0].nativeEvent?.code).toBe('ArrowLeft');
  });

  it('ignores unbound codes', () => {
    bus.keyDown(key('KeyZ'));
    bus.keyUp(key('KeyZ'));
    expect(events).toEqual([]);
  });

  it('flags auto-repeats without changing state', () => {
    bus.keyDown(key('Enter'));
    bus.keyDown(key('Enter', 150, true));
    bus.keyDown(key('Enter', 160, true));
    bus.keyUp(key('Enter', 170));
    expect(events.map((e) => `${brief(e)}${e.repeat ? ':rpt' : ''}`)).toEqual([
      'keyboard:confirm:dn',
      'keyboard:confirm:dn:rpt',
      'keyboard:confirm:dn:rpt',
      'keyboard:confirm:up',
    ]);
  });

  it('two codes on one role: one press, release only after both are up', () => {
    bus.keyDown(key('ArrowLeft')); // left
    bus.keyDown(key('KeyD')); // also left
    bus.keyUp(key('ArrowLeft'));
    expect(events.map(brief)).toEqual(['keyboard:left:dn']); // still held via KeyD
    bus.keyUp(key('KeyD'));
    expect(events.map(brief)).toEqual(['keyboard:left:dn', 'keyboard:left:up']);
  });

  it('a keyup for a key held before subscribing still releases its role', () => {
    bus.keyUp(key('ArrowUp'));
    expect(events.map(brief)).toEqual(['keyboard:up:up']);
  });

  it('a rebind mid-hold still releases the originally pressed role', () => {
    bus.keyDown(key('ArrowLeft'));
    const b = defaultBindings();
    delete b.keyboard.ArrowLeft;
    bus.setBindings(b);
    bus.keyUp(key('ArrowLeft'));
    expect(events.map(brief)).toEqual(['keyboard:left:dn', 'keyboard:left:up']);
  });
});

describe('InputBus gamepad path (single shared poll)', () => {
  it('seeds on connect: an already-held button is not a press', () => {
    pad.state.connected = true;
    pad.state.down.add('confirm');
    bus.pollGamepad(1000);
    bus.pollGamepad(1016);
    expect(events).toEqual([]);
  });

  it('emits frame-quantized press/release edges', () => {
    pad.state.connected = true;
    bus.pollGamepad(1000); // seed
    pad.state.down.add('left');
    bus.pollGamepad(1016);
    pad.state.down.delete('left');
    bus.pollGamepad(1033);
    expect(events.map(brief)).toEqual(['gamepad:left:dn', 'gamepad:left:up']);
    expect(events[0].timeStampMs).toBe(1016);
    expect(events[1].timeStampMs).toBe(1033);
    expect(events[0].nativeEvent).toBeUndefined();
  });

  it('stamps a press with the pad sample time (Gamepad.timestamp) when available', () => {
    pad.state.connected = true;
    bus.pollGamepad(1000); // seed
    pad.state.timestamp = 1012; // the browser sampled the press at 1012...
    pad.state.down.add('left');
    bus.pollGamepad(1016); // ...but our poll frame is 1016
    expect(events.map(brief)).toEqual(['gamepad:left:dn']);
    expect(events[0].timeStampMs).toBe(1012); // sample time, not the poll time
  });

  it('falls back to the poll time when the sample time is missing or bogus', () => {
    pad.state.connected = true;
    bus.pollGamepad(1000); // seed
    pad.state.timestamp = 9999; // future / different epoch -> not trusted
    pad.state.down.add('right');
    bus.pollGamepad(1016);
    pad.state.timestamp = 0; // platform doesn't provide it
    pad.state.down.delete('right');
    bus.pollGamepad(1033);
    expect(events.map((e) => e.timeStampMs)).toEqual([1016, 1033]);
  });

  it('a seeded-held button releasing does not emit a stray release', () => {
    pad.state.connected = true;
    pad.state.down.add('up');
    bus.pollGamepad(1000); // seed while held — never tracked as down
    pad.state.down.delete('up');
    bus.pollGamepad(1016);
    expect(events).toEqual([]);
  });

  it('disconnect releases pad-held roles so nothing sticks', () => {
    pad.state.connected = true;
    bus.pollGamepad(1000);
    pad.state.down.add('down');
    bus.pollGamepad(1016);
    pad.state.connected = false;
    bus.pollGamepad(1033);
    expect(events.map(brief)).toEqual(['gamepad:down:dn', 'gamepad:down:up']);
  });
});

describe('InputBus combined-device state', () => {
  it('a role is pressed once even when both devices hold it', () => {
    pad.state.connected = true;
    bus.pollGamepad(1000);
    pad.state.down.add('left');
    bus.pollGamepad(1016); // pad press
    bus.keyDown(key('ArrowLeft', 1020)); // keyboard joins — no second press
    bus.keyUp(key('ArrowLeft', 1030)); // pad still holds — no release
    expect(events.map(brief)).toEqual(['gamepad:left:dn']);
    expect(bus.isRoleDown('left')).toBe(true);
    pad.state.down.delete('left');
    bus.pollGamepad(1050); // last device up -> release
    expect(events.map(brief)).toEqual(['gamepad:left:dn', 'gamepad:left:up']);
    expect(bus.isRoleDown('left')).toBe(false);
  });
});

describe('InputBus lifecycle and capture', () => {
  it('polls only while there are subscribers (schedule/cancel bracket the loop)', () => {
    const scheduled: Array<() => void> = [];
    let cancels = 0;
    const b = new InputBus({
      target: null,
      readPad: () => pad.read(),
      schedule: (cb) => scheduled.push(cb),
      cancel: () => {
        cancels++;
      },
      now: () => 0,
    });
    expect(scheduled.length).toBe(0);
    const un1 = b.subscribe(() => {});
    expect(scheduled.length).toBe(1); // started with the first subscriber
    scheduled[0](); // one frame: polls and reschedules
    expect(scheduled.length).toBe(2);
    const un2 = b.subscribe(() => {});
    expect(scheduled.length).toBe(2); // no second loop for a second subscriber
    un1();
    un2();
    expect(cancels).toBe(1); // stopped with the last unsubscribe
    scheduled[1]();
    expect(scheduled.length).toBe(2); // a stale frame does not reschedule
  });

  it('unsubscribing everyone resets state; the pad re-seeds on the next subscribe', () => {
    pad.state.connected = true;
    bus.pollGamepad(1000);
    pad.state.down.add('confirm');
    bus.pollGamepad(1016);
    expect(events.map(brief)).toEqual(['gamepad:confirm:dn']);
    // Screen change: everyone unsubscribes, a new screen subscribes.
    // (beforeEach kept the unsubscribe; simulate via a fresh subscribe cycle)
    const b2 = new InputBus({ target: null, schedule: null, readPad: () => pad.read() });
    const got: ControlEvent[] = [];
    const un = b2.subscribe((e) => got.push(e));
    b2.pollGamepad(2000); // confirm still held — seeded, not a press
    expect(got).toEqual([]);
    un();
    const got2: ControlEvent[] = [];
    b2.subscribe((e) => got2.push(e));
    b2.pollGamepad(3000); // re-seeded after the stop
    expect(got2).toEqual([]);
  });

  it('capture mode swallows events (for the press-to-bind UI)', () => {
    bus.setCaptureActive(true);
    bus.keyDown(key('Enter'));
    expect(events).toEqual([]);
    bus.setCaptureActive(false);
    expect(bus.isRoleDown('confirm')).toBe(true); // state still tracked
    bus.keyUp(key('Enter'));
    expect(events.map(brief)).toEqual(['keyboard:confirm:up']);
  });
});
