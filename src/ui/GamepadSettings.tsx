/**
 * Gamepad / dance-pad button binding for the Options screen (Gamepad API only —
 * no permission prompt). Bind each column + Start/Select to any pad button, so
 * pads whose panels aren't on the standard dpad (e.g. L-Tek in gamepad mode)
 * work. Bindings live in gamepad.ts (localStorage); this only drives the UI.
 */
import { useEffect, useReducer, useState } from 'react';
import {
  clearGamepadBinding,
  GP_ROLES,
  gamepadName,
  getGamepadBindings,
  pressedGamepadButtons,
  resetGamepadBindings,
  setGamepadBinding,
  type GpRole,
} from '../input/gamepad';

const AC = '#ff4d3d';
const LABELS: Record<GpRole, string> = {
  left: '← Left',
  down: '↓ Down',
  up: '↑ Up',
  right: '→ Right',
  confirm: '✓ Start',
  back: '⤺ Select',
};

export function GamepadSettings() {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [capturing, setCapturing] = useState<GpRole | null>(null);

  // Reflect connect/disconnect.
  useEffect(() => {
    const on = () => force();
    window.addEventListener('gamepadconnected', on);
    window.addEventListener('gamepaddisconnected', on);
    return () => {
      window.removeEventListener('gamepadconnected', on);
      window.removeEventListener('gamepaddisconnected', on);
    };
  }, []);

  // Bind flow: capture the next newly-pressed button (Escape cancels).
  useEffect(() => {
    if (!capturing) return;
    const role = capturing;
    const baseline = new Set(pressedGamepadButtons()); // ignore already-held buttons
    let raf = 0;
    const poll = () => {
      const pressed = pressedGamepadButtons();
      const fresh = pressed.find((b) => !baseline.has(b));
      if (fresh != null) {
        setGamepadBinding(role, fresh);
        setCapturing(null);
        force();
        return;
      }
      for (const b of [...baseline]) if (!pressed.includes(b)) baseline.delete(b);
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setCapturing(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    };
  }, [capturing]);

  const name = gamepadName();
  const bindings = getGamepadBindings();

  return (
    <div className="mb-5">
      <div className="mb-2 text-[11px] tracking-[0.2em] text-[#ececec]/40">GAMEPAD / DANCE PAD</div>
      <div className="mb-2 border border-white/10 px-4 py-2.5 text-[12px] tracking-[0.06em] text-[#ececec]/60">
        {name ? `Connected: ${name}` : 'No gamepad detected — plug one in and press a button.'}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {GP_ROLES.map((role) => (
          <div key={role} className="border border-white/10 p-3">
            <div className="text-[12px] tracking-[0.1em] text-[#ececec]/60">{LABELS[role]}</div>
            <div className="mt-1.5 text-[12px] text-[#ececec]/80 [font-variant-numeric:tabular-nums]">
              {capturing === role ? (
                <span style={{ color: AC }}>press a button…</span>
              ) : bindings[role] != null ? (
                `Button ${bindings[role]}`
              ) : (
                'default'
              )}
            </div>
            <div className="mt-2 flex gap-1">
              <button
                onClick={() => setCapturing(capturing === role ? null : role)}
                className="flex-1 border border-white/10 py-1 text-[12px] tracking-wide text-[#ececec]/60 hover:border-[#ff4d3d] hover:text-[#ececec]"
              >
                {capturing === role ? 'cancel' : 'bind'}
              </button>
              {bindings[role] != null && (
                <button
                  onClick={() => {
                    clearGamepadBinding(role);
                    force();
                  }}
                  title="clear"
                  className="border border-white/10 px-2 py-1 text-[12px] text-[#ececec]/60 hover:border-[#ff4d3d] hover:text-[#ff4d3d]"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={() => {
          resetGamepadBindings();
          force();
        }}
        className="mt-3 border border-white/10 px-4 py-1.5 text-[12px] tracking-wide text-[#ececec]/60 hover:text-[#ececec]"
      >
        Reset gamepad bindings
      </button>
      <p className="mt-2 text-[12px] text-[#ececec]/40">
        Standard dpad/stick pads work with no binding. For pads whose panels are on other buttons,
        bind each here. L-Tek pads that emit keyboard keys use the KEYS section above instead.
      </p>
    </div>
  );
}
