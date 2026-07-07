/**
 * One-time hint: if the event-driven Gamepad API isn't enabled and a controller
 * is present, suggest turning on the browser flag for lower-latency, complete
 * input (see docs/LATENCY.md). Only shows when it's actually relevant — a
 * gamepad/dance pad is connected — and never again once dismissed. Rendered
 * over the menus (not gameplay).
 */
import { useEffect, useRef, useState } from 'react';
import { RAW_GAMEPAD_EVENTS } from '../input/inputBus';
import { loadJson, saveJson } from '../app/storage';
import { STEP_AC as AC } from './Stage';

const DISMISS_KEY = 'notefield.rawGamepadHint.dismissed.v1';
const SUPPORTED =
  typeof window !== 'undefined' && RAW_GAMEPAD_EVENTS.some((n) => `on${n}` in window);

export function RawGamepadHint() {
  const [show, setShow] = useState(false);
  const dismissed = useRef(false);

  useEffect(() => {
    if (SUPPORTED || loadJson<boolean>(DISMISS_KEY)) return;
    // Browsers hide a pad from getGamepads() until it gets input, so poll (like
    // the controls list) — the hint appears the moment a controller is actually
    // used, and never for a keyboard-only player.
    const check = () => {
      if (dismissed.current) return;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      if (Array.from(pads).some(Boolean)) setShow(true);
    };
    check();
    const id = window.setInterval(check, 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!show) return null;

  const dismiss = () => {
    dismissed.current = true;
    saveJson(DISMISS_KEY, true);
    setShow(false);
  };

  return (
    <div
      className="fixed left-1/2 top-[68px] z-[80] flex max-w-[92vw] -translate-x-1/2 items-start gap-3 border border-white/[0.16] bg-[#0b0c0e]/95 px-4 py-2.5 font-grotesk text-[12px] leading-relaxed tracking-[0.02em] text-[#ececec]/80 shadow-[0_6px_24px_rgba(0,0,0,0.5)]"
      role="status"
    >
      <span style={{ color: AC }}>⚡</span>
      <span className="max-w-[560px]">
        Lower-latency controller input is available. Enable{' '}
        <code className="text-[#ececec]">chrome://flags/#gamepad-raw-input-change-event</code> (or
        the <code className="text-[#ececec]">edge://</code> equivalent) and relaunch. Test it under
        Options → Display → Test input quantization.
      </span>
      <button
        onClick={dismiss}
        title="Dismiss"
        className="ml-1 flex-none px-1 text-[#ececec]/45 hover:text-[#ececec]"
      >
        ✕
      </button>
    </div>
  );
}
