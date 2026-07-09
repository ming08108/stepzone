/**
 * The ONE input subsystem both devices feed. Keyboard keydown/keyup (real
 * event timestamps, auto-repeats flagged) and a single shared rAF gamepad poll
 * (frame-quantized performance.now() timestamps, seeded edge detection) both
 * resolve to ControlRole press/release events — subscribers never care which
 * physical device fired. The poll and key listeners run only while there is at
 * least one subscriber (screens subscribe on mount, unsubscribe on unmount).
 *
 * Semantics:
 * - A role is "down" if ANY device holds it; events fire on the combined
 *   0->1 / 1->0 transitions, attributed to the device that caused them.
 * - A pad button already held when polling starts is seeded, not a press
 *   (see gamepadEdges.ts); disconnecting releases everything pad-held.
 * - Keyboard auto-repeat emits `repeat: true` presses (menus may scroll on
 *   them; gameplay must ignore them). Keyboard events carry the native event
 *   so consumers can preventDefault / apply typing guards — the bus itself
 *   never preventDefaults.
 * - While a bind-capture UI is active (setCaptureActive), events are swallowed
 *   (down-state still tracked) so capturing a button doesn't drive the menu.
 *
 * Framework-free; the React side is the thin useControls hook in src/ui.
 * Everything is injectable for tests (fake pads, synthetic key events, manual
 * scheduling) via the InputBus constructor; the app uses the singleton below.
 */

import { CONTROL_ROLES, defaultBindings, type Bindings, type ControlRole } from './controls';
import { readGamepad, type GamepadRead, type PadSample } from './gamepad';
import { createTransitionDetector } from './gamepadEdges';

export type { PadSample } from './gamepad';

export type InputDevice = 'keyboard' | 'gamepad';

/**
 * Event name(s) for Chrome/Edge's experimental event-driven Gamepad API. The
 * shipping demo dispatches `gamepadrawinputchanged` on window; the earlier
 * proposal used `rawgamepadinputchange`, so we listen for both (attaching a
 * listener for an event that never fires is harmless). It's behind a flag —
 * chrome://flags/#gamepad-raw-input-change-event — not an origin trial, so we
 * simply attach the listeners and they light up when the user enables it; no
 * (unreliable) interface-presence check gates the wiring.
 */
export const RAW_GAMEPAD_EVENTS = ['gamepadrawinputchanged', 'rawgamepadinputchange'] as const;

/** The subset of KeyboardEvent the bus reads (tests can pass plain objects). */
export interface KeyEventLike {
  code: string;
  timeStamp: number;
  repeat: boolean;
  preventDefault(): void;
}

export interface ControlEvent {
  role: ControlRole;
  /** true = press, false = release. */
  pressed: boolean;
  /** performance.now()-based: keyboard = the real event timeStamp (judging
   *  axis), gamepad = the poll frame's time (frame-quantized). */
  timeStampMs: number;
  device: InputDevice;
  /** Keyboard auto-repeat of an already-held role (never set on releases). */
  repeat: boolean;
  /** Present on keyboard events for preventDefault / code-specific guards. */
  nativeEvent?: KeyEventLike;
}

type KeyListener = (e: KeyEventLike) => void;

/** window, structurally — injectable for tests. */
interface KeyEventTarget {
  addEventListener(type: 'keydown' | 'keyup', listener: KeyListener): void;
  removeEventListener(type: 'keydown' | 'keyup', listener: KeyListener): void;
}

export interface InputBusOptions {
  /** Keyboard listener target (default: window; null = no keyboard wiring). */
  target?: KeyEventTarget | null;
  /** Gamepad reader (default: readGamepad; inject a fake for tests). */
  readPad?: (overrides: Bindings['gamepad']) => GamepadRead;
  /** Poll scheduler (default: requestAnimationFrame; null = no polling). */
  schedule?: ((cb: () => void) => number) | null;
  cancel?: (handle: number) => void;
  /** Gamepad frame clock (default: performance.now). */
  now?: () => number;
}

export class InputBus {
  private bindings: Bindings = defaultBindings();
  private readonly handlers = new Set<(e: ControlEvent) => void>();
  /** Raw per-pad sample observers (diagnostics) — fed each gamepad poll. */
  private readonly sampleHandlers = new Set<(pads: PadSample[]) => void>();
  /** Codes physically held -> the role they resolved to at press time (so a
   *  rebind mid-hold still releases the original role). */
  private readonly heldCodes = new Map<string, ControlRole>();
  private readonly kbCount = new Map<ControlRole, number>();
  private readonly padDown = new Set<ControlRole>();
  private detect = createTransitionDetector(CONTROL_ROLES);
  private captureActive = false;
  private rafHandle: number | null = null;
  /** True once the event-driven Gamepad API has fired — the loop then stops the
   *  timer poll entirely; events carry input and connect/disconnect handle the
   *  rest, so nothing is polled. */
  private rawActive = false;

  private readonly target: KeyEventTarget | null;
  private readonly readPad: (overrides: Bindings['gamepad']) => GamepadRead;
  private readonly schedule: ((cb: () => void) => number) | null;
  private readonly cancelFn: (handle: number) => void;
  private readonly now: () => number;
  /** window (for the event-driven Gamepad API listeners); null outside a DOM. */
  private readonly rawGamepadTarget: Window | null;

  constructor(opts: InputBusOptions = {}) {
    this.target =
      opts.target !== undefined ? opts.target : typeof window !== 'undefined' ? window : null;
    this.readPad = opts.readPad ?? readGamepad;
    // Fallback poll on requestAnimationFrame: a stable, vsync-aligned cadence
    // (steadier than a busy setTimeout loop) that stops once the event-driven
    // API proves live. Judging accuracy doesn't depend on the poll rate — the
    // press is stamped from Gamepad.timestamp (the device sample time), finer
    // than the frame — so rAF only bounds visual-feedback latency, not timing.
    // Tests inject their own scheduler.
    this.schedule =
      opts.schedule !== undefined
        ? opts.schedule
        : typeof requestAnimationFrame !== 'undefined'
          ? (cb) => requestAnimationFrame(() => cb())
          : null;
    this.cancelFn =
      opts.cancel ??
      (typeof cancelAnimationFrame !== 'undefined' ? (h) => cancelAnimationFrame(h) : () => {});
    this.now = opts.now ?? (() => performance.now());
    this.rawGamepadTarget = typeof window !== 'undefined' ? window : null;
  }

  /** Swap in the current bindings (SettingsContext calls this on load/update). */
  setBindings(b: Bindings): void {
    this.bindings = b;
  }

  /** Role a keyboard code resolves to under the current bindings. */
  keyRole(code: string): ControlRole | undefined {
    return this.bindings.keyboard[code];
  }

  /** While true (press-to-bind capture UI), events are swallowed. */
  setCaptureActive(active: boolean): void {
    this.captureActive = active;
  }

  /** True if any device currently holds the role. */
  isRoleDown(role: ControlRole): boolean {
    return (this.kbCount.get(role) ?? 0) > 0 || this.padDown.has(role);
  }

  /** Total live subscribers (control + sample) — the poll/listeners run while > 0. */
  private get subscriberCount(): number {
    return this.handlers.size + this.sampleHandlers.size;
  }

  /** Subscribe to control events; returns the unsubscribe function. */
  subscribe(handler: (e: ControlEvent) => void): () => void {
    const wasIdle = this.subscriberCount === 0;
    this.handlers.add(handler);
    if (wasIdle) this.start();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.handlers.delete(handler);
      if (this.subscriberCount === 0) this.stop();
    };
  }

  /** Observe the raw per-pad samples the gamepad poll reads (index, id,
   *  Gamepad.timestamp), for diagnostics — the same reads gameplay consumes, so
   *  nothing runs a second poll. Returns the unsubscribe function. */
  subscribeGamepadSamples(handler: (pads: PadSample[]) => void): () => void {
    const wasIdle = this.subscriberCount === 0;
    this.sampleHandlers.add(handler);
    if (wasIdle) this.start();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.sampleHandlers.delete(handler);
      if (this.subscriberCount === 0) this.stop();
    };
  }

  /** Keyboard entry points (wired to the target's keydown/keyup while active). */
  readonly keyDown: KeyListener = (e) => {
    if (e.repeat) {
      // Auto-repeat of a held key: no state change, flagged event only.
      const role = this.heldCodes.get(e.code) ?? this.bindings.keyboard[e.code];
      if (role) this.emit(role, true, e.timeStamp, 'keyboard', true, e);
      return;
    }
    const role = this.bindings.keyboard[e.code];
    if (!role || this.heldCodes.has(e.code)) return;
    const was = this.isRoleDown(role);
    this.heldCodes.set(e.code, role);
    this.kbCount.set(role, (this.kbCount.get(role) ?? 0) + 1);
    if (!was) this.emit(role, true, e.timeStamp, 'keyboard', false, e);
  };

  readonly keyUp: KeyListener = (e) => {
    // Fall back to the bindings for keys held before we started listening, so
    // their release still reaches consumers (matches the old keyup wiring).
    const role = this.heldCodes.get(e.code) ?? this.bindings.keyboard[e.code];
    if (!role) return;
    if (this.heldCodes.delete(e.code)) {
      const n = (this.kbCount.get(role) ?? 1) - 1;
      if (n > 0) this.kbCount.set(role, n);
      else this.kbCount.delete(role);
    }
    if (!this.isRoleDown(role)) this.emit(role, false, e.timeStamp, 'keyboard', false, e);
  };

  /** One gamepad sample -> role transitions (public so tests can drive it). */
  pollGamepad(nowMs = this.now()): void {
    const g = this.readPad(this.bindings.gamepad);
    // Surface the raw per-pad samples this poll read (diagnostics observe the
    // exact reads gameplay judges on — no second input path).
    if (this.sampleHandlers.size > 0 && g.pads)
      for (const cb of [...this.sampleHandlers]) cb(g.pads);
    // Attribute the transition to the pad's device-sample time when it's sane
    // (>0 and not after the poll) — finer than the poll-frame time; otherwise
    // fall back to the poll time. See GamepadRead.timestamp.
    const ts = g.timestamp;
    const at = ts != null && ts > 0 && ts <= nowMs ? ts : nowMs;
    const { pressed, released } = this.detect(g.connected, g);
    for (const role of released) {
      const was = this.isRoleDown(role);
      this.padDown.delete(role);
      // Seeded-held buttons were never tracked down — releasing them is a no-op.
      if (was && !this.isRoleDown(role)) this.emit(role, false, at, 'gamepad', false);
    }
    for (const role of pressed) {
      const was = this.isRoleDown(role);
      this.padDown.add(role);
      if (!was) this.emit(role, true, at, 'gamepad', false);
    }
  }

  private start(): void {
    this.target?.addEventListener('keydown', this.keyDown);
    this.target?.addEventListener('keyup', this.keyUp);
    if (this.schedule) this.rafHandle = this.schedule(this.loop);
    // Event-driven gamepad input (behind chrome://flags): poll the instant new
    // pad data lands, and stop the timer poll once it does (pollGamepad dedups).
    for (const name of RAW_GAMEPAD_EVENTS)
      this.rawGamepadTarget?.addEventListener(name, this.onRawGamepad);
    this.rawGamepadTarget?.addEventListener('gamepadconnected', this.onGamepadHotplug);
    this.rawGamepadTarget?.addEventListener('gamepaddisconnected', this.onGamepadHotplug);
  }

  private stop(): void {
    this.target?.removeEventListener('keydown', this.keyDown);
    this.target?.removeEventListener('keyup', this.keyUp);
    for (const name of RAW_GAMEPAD_EVENTS)
      this.rawGamepadTarget?.removeEventListener(name, this.onRawGamepad);
    this.rawGamepadTarget?.removeEventListener('gamepadconnected', this.onGamepadHotplug);
    this.rawGamepadTarget?.removeEventListener('gamepaddisconnected', this.onGamepadHotplug);
    if (this.rafHandle != null) {
      this.cancelFn(this.rafHandle);
      this.rafHandle = null;
    }
    // Forget transient state so the next subscriber starts clean (and the pad
    // re-seeds — a button held across a screen change is not a fresh press).
    this.heldCodes.clear();
    this.kbCount.clear();
    this.padDown.clear();
    this.detect = createTransitionDetector(CONTROL_ROLES);
    // Re-arm the fallback poll for the next subscriber: without this, once a raw
    // gamepad event has fired, `rawActive` stays true and the next start()'s
    // loop polls a single frame then never reschedules. A raw event re-proves
    // the event API is live and stops the poll again.
    this.rawActive = false;
  }

  private readonly loop = (): void => {
    this.pollGamepad();
    // Stop the rAF poll once the event-driven API is live — events + the
    // connect/disconnect handlers cover everything, so there's nothing to poll.
    if (!this.rawActive && this.schedule && this.handlers.size > 0)
      this.rafHandle = this.schedule(this.loop);
  };

  /** Poll driven by the event-driven Gamepad API (when the flag is on). Its
   *  first fire proves the API is live, so the loop stops the timer poll and
   *  events carry input from here on. */
  private readonly onRawGamepad = (): void => {
    if (this.handlers.size === 0) return;
    this.rawActive = true;
    this.pollGamepad();
  };

  /** A pad connected/disconnected: poll once to seed the new pad or flush a
   *  gone one's held roles — the edge cases a periodic poll used to cover, so
   *  going fully event-driven doesn't strand a stuck button. */
  private readonly onGamepadHotplug = (): void => {
    if (this.handlers.size > 0) this.pollGamepad();
  };

  private emit(
    role: ControlRole,
    pressed: boolean,
    timeStampMs: number,
    device: InputDevice,
    repeat: boolean,
    nativeEvent?: KeyEventLike,
  ): void {
    if (this.captureActive) return;
    const ev: ControlEvent = { role, pressed, timeStampMs, device, repeat, nativeEvent };
    for (const h of [...this.handlers]) h(ev);
  }
}

// --- app-wide singleton ------------------------------------------------------

export const inputBus = new InputBus();

/** Subscribe to unified control events; returns the unsubscribe function. */
export function subscribeControls(handler: (e: ControlEvent) => void): () => void {
  return inputBus.subscribe(handler);
}

/** Observe the raw per-pad gamepad samples the bus's poll reads (diagnostics). */
export function subscribeGamepadSamples(handler: (pads: PadSample[]) => void): () => void {
  return inputBus.subscribeGamepadSamples(handler);
}

/** Point the bus at the current bindings (called by the settings layer). */
export function setControlBindings(b: Bindings): void {
  inputBus.setBindings(b);
}

/** Swallow bus events while a press-to-bind capture UI is active. */
export function setBindCaptureActive(active: boolean): void {
  inputBus.setCaptureActive(active);
}

/** True if any device currently holds the role. */
export function isControlDown(role: ControlRole): boolean {
  return inputBus.isRoleDown(role);
}

/** Resolve a KeyboardEvent.code to its bound role (or undefined). For menus that
 *  handle raw keydown but should still honor custom keybinds (e.g. Slash →
 *  confirm) — not just the hard-coded Enter/Escape. */
export function keyboardRole(code: string): ControlRole | undefined {
  return inputBus.keyRole(code);
}
