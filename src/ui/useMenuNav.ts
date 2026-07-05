import { useEffect, useRef } from 'react';
import { subscribeControls } from '../input/inputBus';

/**
 * Makes a screen fully navigable with the unified controls: directional roles
 * move DOM focus, confirm activates the focused element, back leaves — the
 * same whether they came from arrow keys / D F J K, a dance pad, or a gamepad
 * (one input bus; see src/input/inputBus.ts). No mouse required. Sliders keep
 * keyboard Left/Right for value and use Up/Down to move on; text fields keep
 * their typing keys.
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

    // The bus seeds gamepad edge detection from the first connected read, so a
    // button already held when the screen opens isn't treated as a fresh press
    // (that was bouncing straight back out of the screen), and re-seeds after
    // any disconnect. Keyboard auto-repeats pass through so a held arrow keeps
    // scrolling. Typing guards apply to keyboard events only.
    return subscribeControls((e) => {
      if (!e.pressed) return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      const isRange = tag === 'INPUT' && (active as HTMLInputElement).type === 'range';
      const isField = (tag === 'INPUT' && !isRange) || tag === 'SELECT' || tag === 'TEXTAREA';

      if (e.role === 'back') {
        // Backspace stays a text-editing key inside fields.
        if (e.device === 'keyboard' && isField && e.nativeEvent?.code === 'Backspace') return;
        if (onBackRef.current) {
          e.nativeEvent?.preventDefault();
          onBackRef.current();
        }
        return;
      }

      if (e.role === 'confirm') {
        if (e.device === 'keyboard') {
          if (isField) return; // Enter in a field stays native
          // A focused button/link already activates on the native Enter press.
          if (tag === 'BUTTON' || tag === 'A') return;
          e.nativeEvent?.preventDefault();
        }
        active?.click();
        return;
      }

      const dir = e.role === 'up' || e.role === 'left' ? -1 : 1;
      if (e.device === 'keyboard') {
        if (isField) return;
        if (isRange && (e.role === 'left' || e.role === 'right')) return; // native slider adjust
        e.nativeEvent?.preventDefault();
      }
      moveFocus(dir);
    });
  }, []);
}
