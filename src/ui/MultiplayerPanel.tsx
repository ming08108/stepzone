/**
 * The multiplayer ENTRY panel — host or join a persistent room from SONG
 * SELECT (docs/VERSUS.md). Opened from the pack grid's SELECT, the hint-bar
 * button, or a ?join= share link. Pad-operable throughout: ▲▼ picks HOST/JOIN,
 * START confirms, the join code is pressed as 6 arrows, SELECT backs out.
 * Mouse mirrors on everything.
 *
 * It handles ONLY the entry choice + code entry. The moment a room exists (or
 * a connect starts), the panel closes and the roster/status live in the global
 * room dock (App → RoomDock, pinned bottom-right) — so the party stays in one
 * place as you move between screens.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { keyboardRole } from '../input/inputBus';
import { CODE_ARROWS, CODE_LENGTH } from '../net/versus';
import { hostRoom, joinRoomByCode, roomState, subscribeRoom } from './roomStore';
import { CodeArrows, PadArrow } from './PadArrow';

const AC = '#ff5d47';

/** Auto-join dedupe across StrictMode's dev double-mount — only the first
 *  instance starts the join; its store writes outlive the remount. */
const autoJoined = new Set<string>();

type Step = { k: 'menu'; sel: number } | { k: 'enter'; code: string };

export function MultiplayerPanel({
  initialCode,
  onClose,
}: {
  /** Room code from a ?join= share link — auto-joins on open. */
  initialCode?: string;
  onClose: () => void;
}) {
  const vs = useSyncExternalStore(subscribeRoom, roomState);
  const [step, setStep] = useState<Step>({ k: 'menu', sel: 0 });
  const stepRef = useRef(step);
  stepRef.current = step;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // A ?join= share link goes straight to connecting (once — see autoJoined).
  useEffect(() => {
    if (initialCode && !autoJoined.has(initialCode)) {
      autoJoined.add(initialCode);
      void joinRoomByCode(initialCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once a room is being created / joined / live, hand off to the global dock.
  useEffect(() => {
    if (vs.k !== 'idle') onCloseRef.current();
  }, [vs.k]);

  const activate = (sel: number) => {
    if (sel === 0) void hostRoom();
    else setStep({ k: 'enter', code: '' });
  };

  const pressArrow = (a: string) => {
    const s = stepRef.current;
    if (s.k !== 'enter') return;
    const code = s.code + a;
    if (code.length >= CODE_LENGTH) void joinRoomByCode(code);
    else setStep({ k: 'enter', code });
  };

  useEffect(() => {
    const ARROW_KEY: Record<string, string> = {
      ArrowLeft: 'L',
      ArrowDown: 'D',
      ArrowUp: 'U',
      ArrowRight: 'R',
    };
    const onKey = (e: KeyboardEvent) => {
      // confirm/back honor custom keybinds (e.g. Slash → confirm), not just Enter.
      const role = keyboardRole(e.code);
      const isConfirm = e.key === 'Enter' || role === 'confirm';
      const isBack = e.key === 'Escape' || e.key === 'Shift' || role === 'back';
      const arrow = ARROW_KEY[e.key];
      if (!isConfirm && !isBack && !arrow) return;
      e.preventDefault();
      const s = stepRef.current;
      if (isBack) {
        if (s.k === 'enter') setStep({ k: 'menu', sel: 1 });
        else onCloseRef.current();
      } else if (s.k === 'menu') {
        if (arrow === 'U' || arrow === 'D') setStep({ k: 'menu', sel: s.sel === 0 ? 1 : 0 });
        else if (isConfirm) activate(s.sel);
      } else if (arrow) {
        pressArrow(arrow);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The panel only exists for the idle entry choice; once a room spins up the
  // handoff effect above closes it.
  if (vs.k !== 'idle') return null;

  const menuRows = [
    { label: 'HOST A ROOM', hint: 'Get a 6-arrow code + invite link friends join with.' },
    { label: 'JOIN WITH CODE', hint: 'Press the 6 arrows from the host’s screen.' },
  ];

  return (
    <div className="absolute inset-0 z-[30] flex items-center justify-center bg-black/60">
      <div className="flex w-[520px] max-w-[92%] flex-col border border-white/15 bg-[#0b0c0e] shadow-2xl">
        <div className="flex flex-none items-baseline gap-3 border-b border-white/[0.09] px-5 py-3">
          <span className="text-[13px] font-bold tracking-[0.22em]" style={{ color: AC }}>
            MULTIPLAYER
          </span>
          <span className="min-w-0 flex-1 truncate text-[15px] font-bold">PLAY WITH FRIENDS</span>
          <button
            onClick={onClose}
            title="Close"
            className="flex-none px-1 text-[15px] text-[#ececec]/50 hover:text-[#ececec]"
          >
            ✕
          </button>
        </div>

        <div className="min-h-[160px] px-6 py-5">
          {step.k === 'menu' && (
            <div className="flex flex-col gap-2 py-1">
              {menuRows.map((row, i) => {
                const on = step.sel === i;
                return (
                  <div
                    key={row.label}
                    onClick={() => activate(i)}
                    className="flex cursor-pointer items-center gap-4 border border-l-[3px] px-4 py-3"
                    style={{
                      borderColor: on ? AC : 'rgba(255,255,255,.12)',
                      borderLeftColor: on ? AC : 'transparent',
                      background: on ? AC + '14' : 'transparent',
                    }}
                  >
                    <span
                      className="flex-none text-[14px] font-bold tracking-[0.16em]"
                      style={{ color: on ? AC : '#ececec' }}
                    >
                      {row.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-right text-[12px] text-[#ececec]/55">
                      {row.hint}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {step.k === 'enter' && (
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="text-[12px] tracking-[0.2em] text-[#ececec]/55">ENTER ROOM CODE</div>
              <div className="flex h-[40px] items-center gap-2">
                {step.code.length > 0 && <CodeArrows code={step.code} size={34} gap={8} />}
                {Array.from({ length: CODE_LENGTH - step.code.length }).map((_, i) => (
                  <span
                    key={i}
                    className="inline-block h-[6px] w-[6px] rounded-full bg-[#ececec]/25"
                  />
                ))}
              </div>
              <div className="flex gap-2">
                {CODE_ARROWS.map((a) => (
                  <button
                    key={a}
                    onClick={() => pressArrow(a)}
                    className="flex items-center justify-center border border-white/15 px-4 py-2 text-[#ececec]/85 hover:border-[#ff5d47] hover:text-[#ececec]"
                  >
                    <PadArrow dir={a} size={22} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-none justify-end border-t border-white/[0.09] px-5 py-2">
          <span className="text-[11px] tracking-[0.14em]" style={{ color: AC }}>
            {step.k === 'enter'
              ? 'PRESS THE 6 ARROWS · SELECT — BACK'
              : '▲▼ CHOOSE · START — CONFIRM · SELECT — CLOSE'}
          </span>
        </div>
      </div>
    </div>
  );
}
