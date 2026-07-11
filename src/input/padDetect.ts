/**
 * Heuristic: does a Gamepad.id look like a real dance pad (rather than an
 * ordinary hand controller)? Used only to tag a submitted play with
 * `padKnown` — the leaderboard still ACCEPTS any gamepad as a pad play (an
 * unknown id is `padKnown: false`, not rejected), so this list only needs to
 * catch the common names, never every pad ever made. Pure string matching, no
 * DOM: unit-testable and safe in the engine layer.
 *
 * Gamepad.id strings vary by browser/OS but usually embed the USB product
 * name. The markers below are lowercase substrings drawn from the dance-pad
 * hardware players actually plug in; matching is case-insensitive `includes`.
 */

/**
 * Lowercase substrings that mark a Gamepad.id as a known dance pad. Documented
 * so the list is auditable; extend it as new hardware shows up:
 *  - L-Tek / LTEK        — popular premium metal pads
 *  - StepManiaX / SMX    — StepManiaX platforms
 *  - RE:Flex / REFLEX    — RE:Flex dance pads
 *  - Cobalt Flux         — classic soft/hard pads
 *  - FSR                 — force-sensing-resistor DIY pads (often named "FSR ...")
 *  - DDR / Dance Dance   — official DanceDanceRevolution controllers
 *  - dance pad / mat     — generic USB pads that self-describe
 *  - PIUIO / Pump It Up  — Pump It Up (PIUIO interface) pads
 *  - GHETT               — "Ghetto"/GHETT community pad interfaces
 */
export const DANCE_PAD_ID_MARKERS: readonly string[] = [
  'l-tek',
  'ltek',
  'stepmaniax',
  'smx',
  're:flex',
  'reflex',
  'cobalt flux',
  'fsr',
  'ddr',
  'dance dance',
  'dance pad',
  'dance mat',
  'piuio',
  'pump it up',
  'ghett',
];

/** True when the id matches a known dance-pad name (case-insensitive). */
export function looksLikeDancePad(id: string): boolean {
  const lower = id.toLowerCase();
  return DANCE_PAD_ID_MARKERS.some((marker) => lower.includes(marker));
}
