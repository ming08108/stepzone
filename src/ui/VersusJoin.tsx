/**
 * Versus join overlay — code entry only (hosting lives on PLAYER OPTIONS).
 * Opened from the pack grid's SELECT, the hint-bar button, or a ?join= share
 * link. Pad-operable (press the 6 arrows; SELECT backs out) and
 * mouse-clickable (arrow keypad, ✕). On success the song is resolved from the
 * local library by any-hash match and a PLAYER OPTIONS request goes up — the
 * live session itself lives in the versusSession store.
 */
import { useEffect, useRef, useState } from 'react';
import { keyboardRole } from '../input/inputBus';
import { resolveBackground } from '../io/bgVideo';
import { readSongAudio } from '../io/songFiles';
import { CODE_ARROWS, CODE_LENGTH, codeToArrows } from '../net/versus';
import { fetchRoom } from '../net/versusSignal';
import { addFiles, ensureLoaded, libraryState } from './libraryStore';
import type { PlayRequest } from './playRequest';
import { findSongByAnyHash } from './versusResolve';
import { abandonVersus, joinVersus, requestSongTransfer, versusState } from './versusSession';

const AC = '#ff5d47';
const ARROW_GLYPH: Record<string, string> = { L: '←', D: '↓', U: '↑', R: '→' };

/** Auto-join dedupe across StrictMode's dev double-mount — only the first
 *  instance starts the join; its store writes outlive the remount. */
const autoJoined = new Set<string>();

type Step =
  { k: 'enter'; code: string } | { k: 'busy'; message: string } | { k: 'error'; message: string };

export function VersusJoin({
  initialCode,
  onClose,
  onJoined,
}: {
  /** Room code from a ?join= share link — auto-joins on open. */
  initialCode?: string;
  onClose: () => void;
  /** Song resolved + channel connected: hand a PLAYER OPTIONS request up. */
  onJoined: (r: PlayRequest) => void;
}) {
  const [step, setStep] = useState<Step>({ k: 'enter', code: '' });
  const stepRef = useRef(step);
  stepRef.current = step;
  const joinedRef = useRef(false);

  // If the panel dies mid-join (close, navigation) the half-built session
  // must not leak; a handed-up session belongs to PLAYER OPTIONS instead.
  useEffect(
    () => () => {
      if (!joinedRef.current && versusState().k !== 'idle') abandonVersus();
    },
    [],
  );

  const join = async (code: string) => {
    setStep({ k: 'busy', message: 'LOOKING UP ROOM…' });
    const room = await fetchRoom(code);
    if (!room) {
      setStep({ k: 'error', message: 'ROOM NOT FOUND (OR EXPIRED)' });
      return;
    }
    setStep({ k: 'busy', message: `CONNECTING TO ${room.hostName}…` });
    if (!(await joinVersus(code, room))) {
      setStep({ k: 'error', message: 'COULD NOT CONNECT (ROOM TAKEN, OR NAT BLOCKED)' });
      return;
    }
    let local = findSongByAnyHash(libraryState().entries, room.song.charts);
    if (!local) {
      // No local copy — the song travels P2P from the host over the already
      // open data channel (original simfile + audio; no server involved).
      const got = await requestSongTransfer((f) =>
        setStep({
          k: 'busy',
          message: `GETTING THE SONG FROM ${room.hostName}… ${Math.round(f * 100)}%`,
        }),
      );
      if (!got) {
        abandonVersus();
        setStep({ k: 'error', message: 'SONG TRANSFER FAILED (HOST CANNOT SHARE IT)' });
        return;
      }
      // Feed the received files through the normal drop path: the song
      // becomes a real library entry (kept for this session — race again free).
      setStep({ k: 'busy', message: 'ADDING THE SONG TO YOUR LIBRARY…' });
      const dir = `Versus Received/${room.song.title.replace(/[/\\]/g, '-')}`;
      const at = (name: string, content: BlobPart) => {
        const f = new File([content], name);
        Object.defineProperty(f, 'webkitRelativePath', { value: `${dir}/${name}` });
        return f;
      };
      await addFiles([at(got.simfileName, got.simfile), at(got.audioName, got.audio)]);
      local = findSongByAnyHash(libraryState().entries, room.song.charts);
      if (!local) {
        abandonVersus();
        setStep({ k: 'error', message: 'TRANSFERRED SONG DID NOT MATCH (DIFFERENT REVISION?)' });
        return;
      }
    }
    setStep({ k: 'busy', message: 'LOADING SONG…' });
    const entry = await ensureLoaded(local.entry);
    const audio = await readSongAudio(entry);
    const bg = await resolveBackground(entry);
    joinedRef.current = true;
    onJoined({
      song: entry.song,
      chart: local.chart,
      encodedAudio: audio,
      backgroundFile: bg,
      entry,
    });
  };

  // A ?join= share link goes straight to connecting (once — see autoJoined).
  useEffect(() => {
    if (initialCode && !autoJoined.has(initialCode)) {
      autoJoined.add(initialCode);
      void join(initialCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pressArrow = (a: string) => {
    const s = stepRef.current;
    if (s.k !== 'enter') return;
    const code = s.code + a;
    if (code.length >= CODE_LENGTH) void join(code);
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
      const role = keyboardRole(e.code);
      const isConfirm = e.key === 'Enter' || role === 'confirm';
      const isBack = e.key === 'Escape' || e.key === 'Shift' || role === 'back';
      const arrow = ARROW_KEY[e.key];
      if (!isConfirm && !isBack && !arrow) return;
      e.preventDefault();
      const s = stepRef.current;
      if (isBack) {
        if (s.k === 'error') setStep({ k: 'enter', code: '' });
        else onClose();
      } else if (s.k === 'enter' && arrow) {
        pressArrow(arrow);
      } else if (s.k === 'error' && isConfirm) {
        setStep({ k: 'enter', code: '' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="absolute inset-0 z-[30] flex items-center justify-center bg-black/60">
      <div className="flex w-[520px] max-w-[92%] flex-col border border-white/15 bg-[#0b0c0e] shadow-2xl">
        <div className="flex flex-none items-baseline gap-3 border-b border-white/[0.09] px-5 py-3">
          <span className="text-[13px] font-bold tracking-[0.22em]" style={{ color: AC }}>
            VERSUS
          </span>
          <span className="min-w-0 flex-1 truncate text-[15px] font-bold">JOIN A ROOM</span>
          <button
            onClick={onClose}
            title="Close"
            className="flex-none px-1 text-[15px] text-[#ececec]/40 hover:text-[#ececec]"
          >
            ✕
          </button>
        </div>

        <div className="min-h-[150px] px-6 py-5">
          {step.k === 'enter' && (
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="text-[12px] tracking-[0.2em] text-[#ececec]/45">ENTER ROOM CODE</div>
              <div className="text-[42px] font-bold tracking-[0.18em]">
                {codeToArrows(step.code)}
                <span className="text-[#ececec]/25">
                  {' · '.repeat(Math.max(0, CODE_LENGTH - step.code.length)).trimEnd()}
                </span>
              </div>
              <div className="flex gap-2">
                {CODE_ARROWS.map((a) => (
                  <button
                    key={a}
                    onClick={() => pressArrow(a)}
                    className="border border-white/15 px-4 py-2 text-[20px] leading-none text-[#ececec]/80 hover:border-[#ff5d47] hover:text-[#ececec]"
                  >
                    {ARROW_GLYPH[a]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step.k === 'busy' && (
            <div className="py-10 text-center text-[13px] tracking-[0.16em] text-[#ececec]/60">
              {step.message}
            </div>
          )}

          {step.k === 'error' && (
            <div className="flex flex-col items-center gap-4 py-6">
              <div className="text-center text-[13px] tracking-[0.14em] text-[#ffd94b]">
                {step.message}
              </div>
              <button
                onClick={() => setStep({ k: 'enter', code: '' })}
                className="border px-5 py-1.5 text-[12px] tracking-[0.16em]"
                style={{ borderColor: AC }}
              >
                TRY AGAIN
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-none justify-end border-t border-white/[0.09] px-5 py-2">
          <span className="text-[11px] tracking-[0.14em]" style={{ color: AC }}>
            {step.k === 'enter' ? 'PRESS THE 6 ARROWS · SELECT — CLOSE' : 'SELECT — BACK'}
          </span>
        </div>
      </div>
    </div>
  );
}
