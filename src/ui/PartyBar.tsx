/**
 * The party bar (design 6a) — ONE docked surface for multiplayer, replacing
 * the entry modal (MultiplayerPanel), the floating roster dock (RoomDock) and
 * the full-screen connecting overlay (RoomJoinOverlay). It sits above the key
 * legend, full width, never covering content, and everything multiplayer is a
 * STATE of this bar:
 *
 *   · entry   — HOST / JOIN side by side; the join code is pressed as arrows
 *               right in the bar. No modal opens.
 *   · busy    — creating / connecting, with its message inline.
 *   · error   — the message plus TRY AGAIN / DISMISS.
 *   · in-room — every player is a card (name · picked difficulty · state), so
 *               the room's situation is legible at a glance, plus the code,
 *               COPY LINK, suggestions and LEAVE. A guest's song transfer
 *               shows as a progress strip in the same bar — browsing is never
 *               blocked.
 *
 * The bar reads roomStore directly, so any screen can mount it and the party
 * never jumps to a different place.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { keyboardRole } from '../input/inputBus';
import type { PlayerState } from '../net/roomPeer';
import { CODE_ARROWS, CODE_LENGTH, type VersusChartMeta } from '../net/versus';
import { difficultyToString } from '../song/difficulty';
import { difficultyColor } from './difficultyUi';
import { CodeArrows, PadArrow } from './PadArrow';
import {
  dismissRoomError,
  hostRoom,
  joinRoomByCode,
  leaveRoom,
  roomState,
  roomSuggestions,
  subscribeRoom,
  transferHostTo,
} from './roomStore';

const AC = '#ff5d47';
const READY = '#59f07f';
const DONE = '#37d5ff'; // the system cyan (difficulty slot 0)

/** Auto-join dedupe across StrictMode's dev double-mount. */
const autoJoined = new Set<string>();

export function CopyInviteButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() =>
        void navigator.clipboard
          ?.writeText(`${location.origin}/?join=${code}`)
          .then(() => setCopied(true))
          .catch(() => {})
      }
      className="flex-none border px-2.5 py-[3px] text-[10px] font-bold tracking-[0.1em] whitespace-nowrap transition-colors"
      style={{
        borderColor: copied ? READY : AC + '80',
        color: copied ? READY : '#ececec',
        background: copied ? READY + '14' : AC + '12',
      }}
    >
      {copied ? '✓ COPIED' : 'COPY LINK'}
    </button>
  );
}

function DiffChip({ pick }: { pick: VersusChartMeta | null }) {
  if (!pick)
    return (
      <span className="font-display text-[10px] tracking-[0.06em] text-[#ececec]/35">
        CHOOSING…
      </span>
    );
  const name = difficultyToString(pick.difficulty);
  const color = difficultyColor(name);
  return (
    <span
      className="border px-1.5 py-px font-display text-[10px] font-bold tracking-[0.06em] uppercase whitespace-nowrap"
      style={{ borderColor: color, color }}
    >
      {name} {pick.meter}
    </span>
  );
}

function PlayerCard({ p, you, canPromote }: { p: PlayerState; you: boolean; canPromote: boolean }) {
  const host = p.id === 0;
  const state = p.left ? 'LEFT' : p.done ? 'DONE' : p.ready ? 'READY' : 'NOT READY';
  const stateColor = state === 'READY' ? READY : state === 'DONE' ? DONE : 'rgba(236,236,236,.5)';
  const lit = state === 'READY' || state === 'DONE';
  return (
    <div
      className="flex min-w-0 flex-1 flex-col gap-[5px] px-3 py-[10px]"
      style={{
        background: lit ? `${stateColor}14` : 'rgba(255,255,255,.025)',
        boxShadow: lit
          ? `inset 0 0 0 1px ${stateColor}59`
          : 'inset 0 0 0 1px rgba(255,255,255,.07)',
      }}
    >
      <div className="flex items-center gap-[7px]">
        <span
          className="h-[7px] w-[7px] flex-none rounded-full"
          style={{ background: lit ? stateColor : 'rgba(236,236,236,.28)' }}
        />
        <span
          className={`min-w-0 flex-1 truncate text-[14px] ${p.left ? 'line-through opacity-45' : ''}`}
          style={{ fontWeight: you ? 700 : 400, color: you ? '#ececec' : 'rgba(236,236,236,.82)' }}
        >
          {p.name}
        </span>
        {(host || you) && (
          <span
            className="text-[9px] font-bold tracking-[0.16em]"
            style={{ color: host ? '#ffcf3d' : 'rgba(236,236,236,.35)' }}
          >
            {host && you ? 'HOST · YOU' : host ? 'HOST' : 'YOU'}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <DiffChip pick={p.pick} />
        <span className="flex-1" />
        {canPromote && !host && !you && !p.left && (
          <button
            onClick={() => transferHostTo(p.id)}
            title={`Make ${p.name} the host`}
            className="flex-none border px-1.5 py-px text-[9px] font-bold tracking-[0.12em] whitespace-nowrap text-[#ececec]/70 hover:text-[#ececec]"
            style={{ borderColor: AC + '80' }}
          >
            MAKE HOST
          </button>
        )}
        <span
          className="font-display text-[11px] font-bold tracking-[0.12em]"
          style={{ color: stateColor }}
        >
          {state}
        </span>
      </div>
    </div>
  );
}

export function PartyBar({
  open = false,
  onClose,
  joinCode,
  status,
}: {
  /** Show the idle ENTRY state (host/join). In-room/busy/error always show. */
  open?: boolean;
  onClose?: () => void;
  /** Room code from a ?join= share link — auto-joins on mount. */
  joinCode?: string;
  /** The owning screen's one-line situation report for the in-room state. */
  status?: string;
}) {
  const vs = useSyncExternalStore(subscribeRoom, roomState);
  const [entry, setEntry] = useState<{ k: 'menu'; sel: 0 | 1 } | { k: 'enter'; code: string }>({
    k: 'menu',
    sel: 0,
  });
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // A ?join= share link goes straight to connecting (once, StrictMode-safe).
  useEffect(() => {
    if (joinCode && !autoJoined.has(joinCode)) {
      autoJoined.add(joinCode);
      void joinRoomByCode(joinCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entryVisible = open && vs.k === 'idle';

  // While the ENTRY state is up, the bar owns the pad: ◀▶ switches HOST/JOIN,
  // arrows type the code, START confirms, SELECT closes. Capture-phase +
  // stopPropagation so the screen underneath doesn't also react.
  useEffect(() => {
    if (!entryVisible) return;
    const ARROW_KEY: Record<string, string> = {
      ArrowLeft: 'L',
      ArrowDown: 'D',
      ArrowUp: 'U',
      ArrowRight: 'R',
    };
    const onKey = (e: KeyboardEvent) => {
      // The bar is docked, not modal — the screen (and its search box) stays
      // live. Never steal keys aimed at a text field.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // confirm/back honor custom keybinds (e.g. a pad adapter), not just Enter.
      const role = keyboardRole(e.code);
      const isConfirm = e.key === 'Enter' || role === 'confirm';
      const isBack = e.key === 'Escape' || e.key === 'Shift' || e.key === 'Tab' || role === 'back';
      const arrow = ARROW_KEY[e.key];
      if (!isConfirm && !isBack && !arrow) return;
      if (roomState().k !== 'idle') return; // handing off — swallow strays
      e.preventDefault();
      e.stopPropagation();
      const s = entryRef.current;
      if (isBack) {
        // Code entry: SELECT deletes the last arrow (a mistyped code doesn't
        // cost the whole thing); empty → back to the menu; menu → close.
        if (s.k === 'enter') {
          if (s.code.length > 0) setEntry({ k: 'enter', code: s.code.slice(0, -1) });
          else setEntry({ k: 'menu', sel: 1 });
        } else {
          onCloseRef.current?.();
        }
        return;
      }
      if (s.k === 'menu') {
        if (arrow === 'L' || arrow === 'R') setEntry({ k: 'menu', sel: s.sel === 0 ? 1 : 0 });
        else if (isConfirm) {
          if (s.sel === 0) void hostRoom();
          else setEntry({ k: 'enter', code: '' });
        }
        return;
      }
      if (arrow) {
        const code = s.code + arrow;
        if (code.length >= CODE_LENGTH) void joinRoomByCode(code);
        else setEntry({ k: 'enter', code });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [entryVisible]);

  // While the bar is SUMMONED (open) in a non-idle state, START takes the
  // primary action — cancel/dismiss, or (twice, to be safe) leave the room —
  // and SELECT puts the pad back on the screen. This is the pad path the old
  // mouse-only dock never had.
  const [confirmLeave, setConfirmLeave] = useState(false);
  const focusedActions = open && vs.k !== 'idle';
  useEffect(() => {
    if (!focusedActions) {
      setConfirmLeave(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const role = keyboardRole(e.code);
      const isConfirm = e.key === 'Enter' || role === 'confirm';
      const isBack = e.key === 'Escape' || e.key === 'Shift' || e.key === 'Tab' || role === 'back';
      if (!isConfirm && !isBack) return;
      e.preventDefault();
      e.stopPropagation();
      if (isBack) {
        setConfirmLeave(false);
        onCloseRef.current?.();
        return;
      }
      const now = roomState();
      if (now.k === 'busy') leaveRoom();
      else if (now.k === 'error') dismissRoomError();
      else if (now.k === 'in-room') {
        if (confirmLeave) {
          leaveRoom();
          onCloseRef.current?.();
        } else {
          setConfirmLeave(true);
          window.setTimeout(() => setConfirmLeave(false), 2500);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focusedActions, confirmLeave]);

  if (vs.k === 'idle' && !open) return null;

  const accent = vs.k === 'error' ? '#ff5c5c' : vs.k === 'busy' ? '#ffcf3d' : AC;

  const suggestions = roomSuggestions();
  const transfer = vs.k === 'in-room' && vs.follow.k === 'resolving' ? vs.follow : null;
  // A guest's transfer/load FAILURE must be visible, not a silent flip back to
  // the suggestions panel (the old blocking overlay used to carry this).
  const followError = vs.k === 'in-room' && vs.follow.k === 'error' ? vs.follow : null;

  return (
    <div
      className="flex h-[112px] flex-none items-center gap-5 px-6"
      style={{ borderTop: `2px solid ${accent}`, background: '#0e0f12' }}
    >
      {/* ── idle: the whole entry, inline ─────────────────────────────────── */}
      {vs.k === 'idle' && (
        <>
          <div className="w-[200px] flex-none">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-white/30" />
              <span
                className="font-display text-[11px] font-bold tracking-[0.24em]"
                style={{ color: AC }}
              >
                MULTIPLAYER
              </span>
            </div>
            <div className="mt-2 font-display text-[17px] font-bold">PLAY TOGETHER</div>
            <div className="mt-1 text-[11px] tracking-[0.1em] text-[#ececec]/40">
              THE ROOM LASTS ACROSS SONGS
            </div>
          </div>

          {entry.k === 'menu' ? (
            <div className="flex min-w-0 flex-1 gap-[10px]">
              {(
                [
                  ['HOST A ROOM ▸', 'Get a 6-arrow code + invite link friends join with.'],
                  ['JOIN WITH CODE', 'Press the 6 arrows from the host’s screen.'],
                ] as const
              ).map(([label, hint], i) => {
                const on = entry.sel === i;
                return (
                  <button
                    key={label}
                    onClick={() => {
                      if (i === 0) void hostRoom();
                      else setEntry({ k: 'enter', code: '' });
                    }}
                    className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-4 py-2 text-left"
                    style={{
                      background: on
                        ? 'linear-gradient(90deg, rgba(255,93,71,.26), rgba(255,93,71,.05))'
                        : 'rgba(255,255,255,.025)',
                      boxShadow: on
                        ? 'inset 0 0 0 1px rgba(255,93,71,.55)'
                        : 'inset 0 0 0 1px rgba(255,255,255,.10)',
                    }}
                  >
                    <span
                      className="font-display text-[14px] font-bold tracking-[0.14em]"
                      style={{ color: on ? AC : '#ececec' }}
                    >
                      {label}
                    </span>
                    <span className="truncate text-[12px] text-[#ececec]/55">{hint}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-5">
              <span className="font-display text-[12px] tracking-[0.2em] text-[#ececec]/55">
                ENTER ROOM CODE
              </span>
              <div className="flex h-[36px] items-center gap-2">
                {entry.code.length > 0 && <CodeArrows code={entry.code} size={28} gap={7} />}
                {Array.from({ length: CODE_LENGTH - entry.code.length }).map((_, i) => (
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
                    onClick={() => {
                      const code = entry.code + a;
                      if (code.length >= CODE_LENGTH) void joinRoomByCode(code);
                      else setEntry({ k: 'enter', code });
                    }}
                    className="flex items-center justify-center border border-white/15 px-3 py-1.5 text-[#ececec]/85 hover:border-[#ff5d47] hover:text-[#ececec]"
                  >
                    <PadArrow dir={a} size={18} />
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex w-[190px] flex-none flex-col items-end gap-2">
            <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 font-display text-[11px] tracking-[0.12em] text-[#ececec]/40">
              {/* Keycap + verb pairs stay atomic so the 190px column wraps
                  BETWEEN hints, never inside one. */}
              {entry.k === 'enter' ? (
                <>
                  <span className="whitespace-nowrap">PRESS THE 6 ARROWS</span>
                  <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    <span className="inline-flex h-[18px] min-w-[24px] items-center justify-center border border-white/[0.18] px-1 text-[10px] text-[#ececec]">
                      SELECT
                    </span>
                    UNDO
                  </span>
                </>
              ) : (
                <>
                  <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    <span className="inline-flex h-[18px] min-w-[24px] items-center justify-center border border-white/[0.18] px-1 text-[10px] text-[#ececec]">
                      ◀▶
                    </span>
                    CHOOSE
                  </span>
                  <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    <span className="inline-flex h-[18px] min-w-[24px] items-center justify-center border border-white/[0.18] px-1 text-[10px] text-[#ececec]">
                      START
                    </span>
                    CONFIRM
                  </span>
                </>
              )}
            </span>
            <button
              onClick={() => onCloseRef.current?.()}
              className="flex h-[30px] items-center px-3 font-display text-[11px] tracking-[0.12em] text-[#ececec]/60 hover:text-[#ececec]"
              style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.16)' }}
            >
              CLOSE ✕
            </button>
          </div>
        </>
      )}

      {/* ── busy / error ──────────────────────────────────────────────────── */}
      {(vs.k === 'busy' || vs.k === 'error') && (
        <>
          <div className="w-[200px] flex-none">
            <div className="flex items-center gap-2">
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  background: accent,
                  animation: vs.k === 'busy' ? 'blinkStart 1.4s infinite' : undefined,
                }}
              />
              <span
                className="font-display text-[11px] font-bold tracking-[0.24em]"
                style={{ color: accent }}
              >
                {vs.k === 'busy' ? 'CONNECTING' : 'ROOM ERROR'}
              </span>
            </div>
            <div className="mt-2 font-display text-[17px] font-bold">
              {vs.k === 'busy' ? 'ONE MOMENT' : 'THAT DIDN’T WORK'}
            </div>
          </div>
          <div
            className="min-w-0 flex-1 text-[14px] leading-[1.5]"
            style={{ color: vs.k === 'error' ? '#ff5c5c' : 'rgba(236,236,236,.7)' }}
          >
            {vs.message}
          </div>
          <div className="flex w-[190px] flex-none flex-col items-end gap-2">
            {focusedActions && (
              <span className="font-display text-[11px] tracking-[0.12em] text-[#ececec]/40">
                <span className="mr-1 inline-flex h-[18px] min-w-[24px] items-center justify-center border border-white/[0.18] px-1 text-[10px] text-[#ececec]">
                  START
                </span>
                {vs.k === 'error' ? 'DISMISS' : 'CANCEL'}
              </span>
            )}
            <button
              onClick={vs.k === 'error' ? dismissRoomError : leaveRoom}
              className="flex h-[34px] w-[160px] items-center justify-center font-display text-[12px] tracking-[0.12em] text-[#ececec]/70 hover:text-[#ececec]"
              style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.16)' }}
            >
              {vs.k === 'error' ? 'DISMISS ✕' : 'CANCEL ✕'}
            </button>
          </div>
        </>
      )}

      {/* ── in-room: the roster, legible at a glance ──────────────────────── */}
      {vs.k === 'in-room' && (
        <>
          <div className="w-[200px] flex-none">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: READY }} />
              <span
                className="font-display text-[11px] font-bold tracking-[0.24em]"
                style={{ color: AC }}
              >
                ROOM
              </span>
            </div>
            <div className="mt-[9px] text-[#ececec]">
              <CodeArrows code={vs.room.code} size={20} gap={7} />
            </div>
            <div className="mt-[7px] flex items-center gap-2">
              <CopyInviteButton code={vs.room.code} />
              <span className="text-[11px] tracking-[0.1em] text-[#ececec]/40">
                {vs.room.players.filter((p) => !p.left).length}P
              </span>
            </div>
          </div>

          {(() => {
            // Rooms hold up to 8; the bar fits 4 cards. YOU must always be one
            // of them (a 6th joiner has to see their own state), and the rest
            // are summarized in a +N chip so nobody silently vanishes.
            const active = vs.room.players.filter((p) => !p.left);
            let shown = active.slice(0, 4);
            const selfIdx = active.findIndex((p) => p.id === vs.room.selfId);
            if (selfIdx >= 4) shown = [...active.slice(0, 3), active[selfIdx]];
            const hidden = active.length - shown.length;
            return (
              <div className="flex min-w-0 flex-1 items-stretch gap-[10px]">
                {shown.map((p) => (
                  <PlayerCard
                    key={p.id}
                    p={p}
                    you={p.id === vs.room.selfId}
                    canPromote={vs.room.isHost && vs.room.phase === 'lobby'}
                  />
                ))}
                {hidden > 0 && (
                  <div className="flex w-[52px] flex-none items-center justify-center font-display text-[13px] font-bold text-[#ececec]/50">
                    +{hidden}
                  </div>
                )}
              </div>
            );
          })()}

          <div className="flex w-[280px] flex-none flex-col gap-[6px]">
            {followError ? (
              <>
                <div className="font-display text-[10px] tracking-[0.2em] text-[#ff5c5c]">
                  COULDN&apos;T GET THE SONG
                </div>
                <div className="text-[12px] leading-[1.4] text-[#ff5c5c]">
                  {followError.message}
                </div>
                <div className="text-[11px] tracking-[0.08em] text-[#ececec]/45">
                  You&apos;ll rejoin on the host&apos;s next pick.
                </div>
              </>
            ) : transfer ? (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="font-display text-[10px] tracking-[0.2em] text-[#ffcf3d]">
                    GETTING THE SONG
                  </span>
                  <span className="flex-1" />
                  {transfer.progress !== undefined && (
                    <span className="text-[11px] font-bold text-[#ffcf3d] tabular-nums">
                      {Math.round(Math.max(0, Math.min(1, transfer.progress)) * 100)}%
                    </span>
                  )}
                </div>
                {transfer.progress !== undefined ? (
                  <div className="relative h-2 overflow-hidden bg-white/10">
                    <div
                      className="absolute top-0 bottom-0 left-0 transition-[width] duration-150"
                      style={{
                        width: `${Math.round(Math.max(0, Math.min(1, transfer.progress)) * 100)}%`,
                        background: '#ffcf3d',
                      }}
                    />
                  </div>
                ) : (
                  <div
                    className="text-[12px] tracking-[0.3em] text-[#ffcf3d]/70"
                    style={{ animation: 'blinkStart 1.4s infinite' }}
                  >
                    • • •
                  </div>
                )}
                <div className="truncate text-[11px] tracking-[0.08em] text-[#ececec]/55">
                  {transfer.message} — browsing stays open
                </div>
              </>
            ) : (
              <>
                <div className="font-display text-[10px] tracking-[0.2em] text-[#ececec]/35">
                  SUGGESTIONS
                </div>
                {suggestions.length === 0 ? (
                  <div className="text-[12px] text-[#ececec]/35">
                    Guests can suggest songs with START.
                  </div>
                ) : (
                  suggestions.slice(0, 3).map((s) => (
                    <div key={s.id} className="flex items-baseline gap-2 text-[12px]">
                      <span className="min-w-0 flex-1 truncate text-[#ececec]/80">{s.title}</span>
                      <span className="text-[10px] tracking-[0.1em] text-[#ececec]/40">
                        {s.name}
                      </span>
                    </div>
                  ))
                )}
              </>
            )}
          </div>

          <div className="flex w-[220px] flex-none flex-col gap-2">
            {status && <div className="text-[12px] leading-[1.4] text-[#ffcf3d]">{status}</div>}
            {focusedActions && (
              <span className="font-display text-[11px] tracking-[0.12em] text-[#ececec]/40">
                <span className="mr-1 inline-flex h-[18px] min-w-[24px] items-center justify-center border border-white/[0.18] px-1 text-[10px] text-[#ececec]">
                  START
                </span>
                {confirmLeave ? 'AGAIN TO LEAVE!' : 'LEAVE'}
                <span className="mx-1 ml-2 inline-flex h-[18px] min-w-[24px] items-center justify-center border border-white/[0.18] px-1 text-[10px] text-[#ececec]">
                  SELECT
                </span>
                DONE
              </span>
            )}
            <button
              onClick={leaveRoom}
              className="flex h-[32px] items-center justify-center font-display text-[12px] tracking-[0.12em] hover:text-[#ff5d47]"
              style={{
                boxShadow: confirmLeave
                  ? `inset 0 0 0 1px ${AC}`
                  : 'inset 0 0 0 1px rgba(255,255,255,.16)',
                color: confirmLeave ? AC : 'rgba(236,236,236,.7)',
              }}
            >
              {confirmLeave ? 'PRESS START AGAIN ✕' : 'LEAVE ROOM ✕'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
