import { useEffect, useRef } from 'react';
import { readGamepad } from '../input/gamepad';

/**
 * Makes a screen fully navigable with the 4 arrows + Enter (select) + Escape/
 * Backspace (back) — and the same via a gamepad's dpad + A/B (todo #1, #3). No
 * mouse required. Arrows move DOM focus; sliders keep Left/Right for value and
 * use Up/Down to move on.
 */

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function visibleFocusables(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null,
  );
}

function moveFocus(dir: number): void {
  const items = visibleFocusables();
  if (items.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const idx = active ? items.indexOf(active) : -1;
  let next = idx + dir;
  if (next < 0) next = items.length - 1;
  if (next >= items.length) next = 0;
  items[next]?.focus();
}

export function useMenuNav(onBack?: () => void): void {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (document.activeElement === document.body || document.activeElement === null) {
      visibleFocusables()[0]?.focus();
    }

    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      const isRange = tag === 'INPUT' && (active as HTMLInputElement).type === 'range';
      const isField = (tag === 'INPUT' && !isRange) || tag === 'SELECT' || tag === 'TEXTAREA';

      if (e.key === 'Escape' || (e.key === 'Backspace' && !isField)) {
        if (onBackRef.current) {
          e.preventDefault();
          onBackRef.current();
        }
        return;
      }

      let dir = 0;
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') dir = -1;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') dir = 1;
      else return;

      if (isField) return;
      if (isRange && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;

      e.preventDefault();
      moveFocus(dir);
    };
    window.addEventListener('keydown', handler);

    // Gamepad navigation (rising-edge only, so no auto-repeat storm).
    let raf = 0;
    let prev = { u: false, d: false, l: false, r: false, c: false, b: false };
    const poll = () => {
      const g = readGamepad();
      if (g.connected) {
        if ((g.left && !prev.l) || (g.up && !prev.u)) moveFocus(-1);
        if ((g.right && !prev.r) || (g.down && !prev.d)) moveFocus(1);
        if (g.confirm && !prev.c) (document.activeElement as HTMLElement | null)?.click();
        if (g.back && !prev.b) onBackRef.current?.();
      }
      prev = { u: g.up, d: g.down, l: g.left, r: g.right, c: g.confirm, b: g.back };
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);

    return () => {
      window.removeEventListener('keydown', handler);
      cancelAnimationFrame(raf);
    };
  }, []);
}
