/**
 * Seeded rising-edge detection for polled gamepad state (framework-free).
 *
 * The Gamepad API is poll-only, so "was this button just pressed?" needs a
 * prev-state diff. Two subtleties every call site used to hand-roll:
 *  - Seeding: the first sample after (re)connecting only primes prev-state —
 *    a button already held when polling starts is NOT a press (otherwise a
 *    held Confirm bounces straight through a newly opened screen).
 *  - Disconnect re-seed: when the pad disappears, forget prev-state so the
 *    next connected sample seeds again instead of diffing stale data.
 */

/**
 * Edge detector over a fixed set of named boolean states (e.g. GamepadRead
 * roles) that reports rising AND falling edges — the input bus needs releases
 * (holds/rolls) as well as presses. The first connected sample only primes
 * prev-state (a held button is not a press), and a disconnect reports every
 * previously-down key as released (so nothing is left stuck held) and re-seeds.
 */
export function createTransitionDetector<K extends string>(
  keys: readonly K[],
): (
  connected: boolean,
  current: Readonly<Partial<Record<K, boolean>>>,
) => { pressed: K[]; released: K[] } {
  let seeded = false;
  let prev: Partial<Record<K, boolean>> = {};
  return (connected, current) => {
    const pressed: K[] = [];
    const released: K[] = [];
    if (!connected) {
      for (const k of keys) if (prev[k]) released.push(k);
      seeded = false;
      prev = {};
      return { pressed, released };
    }
    if (seeded) {
      for (const k of keys) {
        if (current[k] && !prev[k]) pressed.push(k);
        else if (!current[k] && prev[k]) released.push(k);
      }
    }
    const next: Partial<Record<K, boolean>> = {};
    for (const k of keys) next[k] = !!current[k];
    prev = next;
    seeded = true;
    return { pressed, released };
  };
}
