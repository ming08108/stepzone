/**
 * Compat adapter: gamepad-role presses from the unified input bus are
 * re-dispatched as synthetic keydowns (▲▼◀▶ / Enter / Escape) for screens
 * whose keyboard handlers are entrenched (SongSelectStepline, PlayerOptions) —
 * a controller drives them through their existing keyboard logic with no
 * duplication. Real keyboard input reaches those handlers directly, so ONLY
 * gamepad events are bridged (the synthetic events carry no `code`, so the
 * bus ignores them — no feedback loop). Edge seeding/disconnect handling
 * lives in the bus. Use only on menu screens.
 */
import type { ControlRole } from '../input/controls';
import { useControls } from './useControls';

const KEY_FOR: Record<ControlRole, string> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  confirm: 'Enter',
  back: 'Escape',
};

export function useGamepadKeys(): void {
  useControls((e) => {
    if (e.device !== 'gamepad' || !e.pressed) return;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: KEY_FOR[e.role], bubbles: true }));
  });
}
