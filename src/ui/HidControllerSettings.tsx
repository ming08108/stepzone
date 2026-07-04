/**
 * Self-contained WebHID controller panel for the Options screen. Drop it into
 * the Options scroll container:
 *
 *   import { HidControllerSettings } from './HidControllerSettings';
 *   ...
 *   <HidControllerSettings />
 *
 * It renders its own titled block styled to match the surrounding STEPLINE
 * sections, so no other Options wiring is needed. All state lives in webhid.ts;
 * this component only reflects it and drives the per-column bind flow.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import {
  captureNextHid,
  clearHidBinding,
  connectedHidName,
  getHidBindings,
  initWebHid,
  isHidConnected,
  isWebHidSupported,
  onHidChange,
  requestHidDevice,
  resetHidBindings,
  setHidBinding,
} from '../input/webhid';
import type { HidButtonBinding, HidRole } from '../input/hidMapping';

const AC = '#ff4d3d';

const ROLES: Array<{ role: HidRole; label: string; glyph: string }> = [
  { role: 'left', label: 'Left', glyph: '←' },
  { role: 'down', label: 'Down', glyph: '↓' },
  { role: 'up', label: 'Up', glyph: '↑' },
  { role: 'right', label: 'Right', glyph: '→' },
  { role: 'confirm', label: 'Confirm', glyph: '✓' },
  { role: 'back', label: 'Back', glyph: '⤺' },
];

function bindingLabel(b: HidButtonBinding | undefined): string {
  if (!b) return 'unbound';
  const hex = (n: number) => '0x' + n.toString(16).padStart(2, '0');
  return `r${b.reportId}·b${b.byteIndex}·${hex(b.mask)}=${hex(b.value)}`;
}

export function HidControllerSettings() {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [capturing, setCapturing] = useState<HidRole | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  // Reflect connection / binding changes coming from webhid.ts.
  useEffect(() => {
    initWebHid();
    const off = onHidChange(force);
    return off;
  }, []);

  // Bind flow: capture the next pressed control (Escape cancels).
  useEffect(() => {
    if (capturing === null) return;
    const role = capturing;
    const cancel = captureNextHid((binding) => {
      setHidBinding(role, binding);
      setCapturing(null);
    });
    cancelRef.current = cancel;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        setCapturing(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancel();
      window.removeEventListener('keydown', onKey);
    };
  }, [capturing]);

  const supported = isWebHidSupported();
  const connected = isHidConnected();
  const name = connectedHidName();
  const bindings = getHidBindings();

  return (
    <div className="mb-5">
      <div className="mb-2 text-[11px] tracking-[0.2em] text-[#ececec]/40">CONTROLLER (WEBHID)</div>

      {!supported ? (
        <div className="border border-white/10 px-4 py-3 text-[12px] text-[#ececec]/50">
          WebHID isn&apos;t available in this browser. Use a Chromium browser over HTTPS (or
          localhost) to bind a raw-HID dance pad. Gamepad-mapped controllers still work.
        </div>
      ) : (
        <>
          <div className="mb-2 flex min-h-[52px] items-center gap-4 border border-l-[3px] border-white/10 border-l-transparent px-4 py-2.5">
            <button
              onClick={() => void requestHidDevice()}
              className="border px-4 py-1.5 text-[13px] tracking-wide"
              style={{ borderColor: AC, background: AC + '1a', color: '#ececec' }}
            >
              Connect controller ▸
            </button>
            <span className="text-[12px] tracking-[0.06em] text-[#ececec]/60">
              {connected ? `Connected: ${name ?? 'HID device'}` : 'No HID device connected'}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {ROLES.map(({ role, label, glyph }) => (
              <div key={role} className="border border-white/10 p-3">
                <div className="text-[12px] tracking-[0.1em] text-[#ececec]/60">
                  {glyph} {label.toUpperCase()}
                </div>
                <div className="mt-1.5 truncate text-[12px] [font-variant-numeric:tabular-nums] text-[#ececec]/80">
                  {capturing === role ? (
                    <span style={{ color: AC }}>press a panel…</span>
                  ) : (
                    bindingLabel(bindings[role])
                  )}
                </div>
                <div className="mt-2 flex gap-1">
                  <button
                    onClick={() => setCapturing(capturing === role ? null : role)}
                    className="flex-1 border border-white/10 py-1 text-[12px] tracking-wide text-[#ececec]/60 hover:border-[#ff4d3d] hover:text-[#ececec]"
                  >
                    {capturing === role ? 'cancel' : 'bind'}
                  </button>
                  {bindings[role] && (
                    <button
                      onClick={() => clearHidBinding(role)}
                      title="clear binding"
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
            onClick={() => resetHidBindings()}
            className="mt-3 border border-white/10 px-4 py-1.5 text-[12px] tracking-wide text-[#ececec]/60 hover:text-[#ececec]"
          >
            Clear all controller bindings
          </button>
        </>
      )}
    </div>
  );
}
