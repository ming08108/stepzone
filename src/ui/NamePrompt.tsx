/**
 * First-load name prompt — asks once for the online display name (shown on
 * leaderboards and to versus rivals). Naming is optional, so the pad path is
 * skip: START saves whatever is typed (or skips when empty), SELECT skips —
 * typing itself is a legitimate keyboard-only convenience (skill:
 * pad-controls), and the name stays editable in Options → ONLINE.
 */
import { useEffect, useRef, useState } from 'react';
import { keyboardRole } from '../input/inputBus';
import { getIdentity, markNamePrompted, setPlayerName } from '../net/identity';

const AC = '#ff5d47';

export function NamePrompt({ onDone }: { onDone: () => void }) {
  // Pre-fill with the auto-assigned arcade name; selected on mount so typing
  // replaces it. SKIP keeps it, SAVE commits whatever's shown.
  const [assigned] = useState(() => getIdentity().name);
  const [name, setName] = useState(assigned);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (save && nameRef.current.trim().length > 0) setPlayerName(nameRef.current);
    markNamePrompted();
    onDone();
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    const finish = (save: boolean) => finishRef.current(save);
    const onKey = (e: KeyboardEvent) => {
      const role = keyboardRole(e.code);
      // The input has focus, so letters/arrows must reach it — only the
      // confirm/back chords act here.
      const isBack = e.key === 'Escape' || e.key === 'Shift' || role === 'back';
      if (e.key === 'Enter' || (role === 'confirm' && e.target !== inputRef.current)) {
        e.preventDefault();
        finish(true);
      } else if (isBack) {
        e.preventDefault();
        finish(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);

  return (
    <div className="absolute inset-0 z-[40] flex items-center justify-center bg-black/70">
      <div className="flex w-[480px] max-w-[92%] flex-col items-center gap-4 border border-white/15 bg-[#0b0c0e] px-8 py-8 shadow-2xl">
        <div className="text-[13px] font-bold tracking-[0.22em]" style={{ color: AC }}>
          WELCOME TO STEPZONE
        </div>
        <div className="text-[15px] tracking-[0.08em] text-[#ececec]/80">
          We named you <span style={{ color: AC }}>{assigned}</span> — keep it or pick your own
        </div>
        <input
          ref={inputRef}
          type="text"
          maxLength={24}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="PLAYER"
          className="w-[260px] border border-white/[0.18] bg-transparent px-3 py-2 text-center text-[18px] font-bold tracking-[0.1em] text-[#ececec] outline-none focus:border-[#ff5d47]"
        />
        <div className="text-[12px] leading-relaxed text-[#ececec]/40">
          Optional — you can change it any time in OPTIONS.
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => finish(true)}
            className="border px-5 py-1.5 text-[12px] font-bold tracking-[0.16em]"
            style={{ borderColor: AC, background: AC + '1a' }}
          >
            SAVE
          </button>
          <button
            onClick={() => finish(false)}
            className="border border-white/15 px-5 py-1.5 text-[12px] tracking-[0.16em] text-[#ececec]/60 hover:text-[#ececec]"
          >
            SKIP
          </button>
        </div>
        <div className="text-[11px] tracking-[0.14em]" style={{ color: AC }}>
          START — SAVE · SELECT — SKIP
        </div>
      </div>
    </div>
  );
}
