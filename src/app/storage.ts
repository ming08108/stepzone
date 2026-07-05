/**
 * Tiny guarded localStorage JSON helpers — the single place that touches
 * localStorage for persisted app state (settings, scores, favorites, gamepad
 * bindings). Guards against environments without localStorage (Node tests,
 * SSR) and swallows quota / private-mode / corrupt-JSON errors: loads return
 * null, saves silently no-op. Callers keep their own storage keys.
 */

/** Parse the JSON stored at `key`, or null (missing / bad JSON / no storage). */
export function loadJson<T>(key: string): T | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** JSON-stringify `value` into `key`; ignores quota / private-mode errors. */
export function saveJson(key: string, value: unknown): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore (private mode / quota)
  }
}

/** Remove `key` (e.g. a legacy store after migration); errors ignored. */
export function removeJson(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** True if `v` is a plain-object-shaped value (for validating parsed JSON). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
