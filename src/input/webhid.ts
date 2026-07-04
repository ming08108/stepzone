/**
 * WebHID input source. Some real dance pads / arcade controllers (and keyboard-
 * encoder pads) present as raw HID devices the Gamepad API doesn't expose, or
 * maps unusably. This adds `navigator.hid` as an extra input source and exposes
 * a `readGamepad()`-shaped snapshot (`readHid`) so the play loop and menus can
 * OR it with the gamepad + keyboard.
 *
 * Every `navigator.hid` access is feature-detected: with no WebHID (non-secure
 * context, unsupported browser, SSR/tests) the module degrades to "not
 * connected" and never throws. The pure mapping/capture logic lives in
 * hidMapping.ts; this file owns the device lifecycle, the latest-report cache,
 * and binding persistence.
 */

import type { GamepadRead } from './gamepad';
import {
  captureBinding,
  emptyHidState,
  hidStateFromReports,
  type HidBindings,
  type HidButtonBinding,
  type HidRole,
} from './hidMapping';

const STORAGE_KEY = 'notefield.hidBindings.v1';

function hidApi(): HID | undefined {
  return typeof navigator !== 'undefined' ? navigator.hid : undefined;
}

/** True if the browser exposes WebHID (still needs a secure context + gesture). */
export function isWebHidSupported(): boolean {
  return !!hidApi();
}

interface DeviceEntry {
  device: HIDDevice;
  onReport: (e: HIDInputReportEvent) => void;
}

let bindings: HidBindings = loadBindings();
const attached = new Set<DeviceEntry>();
/** Latest bytes per report id (id byte excluded). */
const latest = new Map<number, number[]>();
let connectedName: string | null = null;
let initialized = false;

// --- persistence -----------------------------------------------------------

function loadBindings(): HidBindings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as HidBindings) : {};
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
    }
  } catch {
    // ignore (private mode / quota)
  }
}

// --- change notification (for the settings UI) -----------------------------

const changeListeners = new Set<() => void>();

/** Subscribe to connection / binding changes. Returns an unsubscribe function. */
export function onHidChange(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

function notify(): void {
  for (const cb of changeListeners) cb();
}

// --- report ingestion ------------------------------------------------------

type CaptureCb = (reportId: number, bytes: number[]) => void;
const captureListeners = new Set<CaptureCb>();

function readBytes(data: DataView): number[] {
  const out = new Array<number>(data.byteLength);
  for (let i = 0; i < data.byteLength; i++) out[i] = data.getUint8(i);
  return out;
}

function handleReport(e: HIDInputReportEvent): void {
  const bytes = readBytes(e.data);
  latest.set(e.reportId, bytes);
  for (const cb of [...captureListeners]) cb(e.reportId, bytes);
}

// --- device lifecycle ------------------------------------------------------

async function attach(device: HIDDevice): Promise<void> {
  for (const d of attached) if (d.device === device) return; // already attached
  try {
    if (!device.opened) await device.open();
  } catch {
    return; // device busy / not permitted
  }
  const onReport = (e: HIDInputReportEvent) => handleReport(e);
  device.addEventListener('inputreport', onReport);
  attached.add({ device, onReport });
  connectedName = device.productName || 'HID device';
  notify();
}

function detach(device: HIDDevice): void {
  for (const d of [...attached]) {
    if (d.device === device) {
      d.device.removeEventListener('inputreport', d.onReport);
      attached.delete(d);
    }
  }
  if (attached.size === 0) {
    connectedName = null;
    latest.clear();
  }
  notify();
}

/**
 * Wire up connect/disconnect events and re-open any devices the user already
 * granted in a previous session. Safe to call repeatedly and when WebHID is
 * absent (no-op). Call once at app startup so gameplay picks up a known pad
 * without opening the settings screen.
 */
export function initWebHid(): void {
  const hid = hidApi();
  if (!hid || initialized) return;
  initialized = true;
  hid.addEventListener('connect', (e) => {
    void attach(e.device);
  });
  hid.addEventListener('disconnect', (e) => {
    detach(e.device);
  });
  hid
    .getDevices()
    .then((devices) => {
      for (const d of devices) void attach(d);
    })
    .catch(() => {});
}

/**
 * Prompt the user to pick a HID device and open it. Must be called from a user
 * gesture (click). Resolves true if a device ended up attached. No-op (false)
 * when WebHID is unavailable.
 */
export async function requestHidDevice(): Promise<boolean> {
  const hid = hidApi();
  if (!hid) return false;
  initWebHid();
  try {
    const granted = await hid.requestDevice({ filters: [] });
    for (const d of granted) await attach(d);
    return attached.size > 0;
  } catch {
    return false;
  }
}

// --- snapshot read ---------------------------------------------------------

/** Poll the current WebHID state, shaped exactly like `readGamepad()`. */
export function readHid(): GamepadRead {
  if (attached.size === 0) return emptyHidState();
  const state = hidStateFromReports(bindings, latest);
  state.connected = true;
  return state;
}

/** True while at least one HID device is open. */
export function isHidConnected(): boolean {
  return attached.size > 0;
}

/** Product name of the most recently attached device (or null). */
export function connectedHidName(): string | null {
  return connectedName;
}

// --- binding management (for the settings UI) ------------------------------

/** A shallow copy of the current bindings. */
export function getHidBindings(): HidBindings {
  return { ...bindings };
}

export function setHidBinding(role: HidRole, binding: HidButtonBinding): void {
  bindings = { ...bindings, [role]: binding };
  persist();
  notify();
}

export function clearHidBinding(role: HidRole): void {
  const next = { ...bindings };
  delete next[role];
  bindings = next;
  persist();
  notify();
}

export function resetHidBindings(): void {
  bindings = {};
  persist();
  notify();
}

/**
 * Capture the next pressed control. Snapshots the current report(s) as a resting
 * baseline, then resolves (via `onBind`) as soon as a later report shows a newly
 * activated control. Returns a cancel function. Fires at most once; if no device
 * is streaming it never fires, so the caller should offer a cancel affordance.
 */
export function captureNextHid(onBind: (binding: HidButtonBinding) => void): () => void {
  // Seed per-stream baselines from the last-seen resting reports.
  const baselines = new Map<number, number[]>();
  for (const [id, bytes] of latest) baselines.set(id, [...bytes]);
  let done = false;

  const cb: CaptureCb = (reportId, bytes) => {
    if (done) return;
    const base = baselines.get(reportId);
    if (!base) {
      // First sight of this stream during capture — treat it as the baseline.
      baselines.set(reportId, [...bytes]);
      return;
    }
    const binding = captureBinding({ reportId, bytes: base }, { reportId, bytes });
    if (binding) {
      done = true;
      captureListeners.delete(cb);
      onBind(binding);
    }
  };

  captureListeners.add(cb);
  return () => {
    done = true;
    captureListeners.delete(cb);
  };
}
