/**
 * The room dock — the persistent party strip shown wherever a room is live:
 * above the START button on PLAYER OPTIONS, and floating over SONG SELECT
 * between songs. Non-modal: players keep driving the screen underneath while
 * the roster fills, readies, and cycles. Pad input is handled by the OWNING
 * screen (START = ready, SELECT = leave/back); the buttons here are mouse
 * mirrors, plus COPY LINK (legitimately mouse-only — the arrow code is the
 * pad path).
 */
import { useState } from 'react';
import type { PlayerState } from '../net/roomPeer';
import { type VersusChartMeta } from '../net/versus';
import { CodeArrows } from './PadArrow';
import { difficultyToString } from '../song/difficulty';
import { difficultyColor } from './difficultyUi';
import { STEP_AC as AC } from './Stage';
import { dismissRoomError, leaveRoom, type RoomUiState } from './roomStore';

const READY = '#59f07f';
const DONE = '#38f0ff';

function DiffChip({ pick }: { pick: VersusChartMeta | null }) {
  if (!pick)
    return <span className="text-[10px] tracking-[0.1em] text-[#ececec]/40">CHOOSING…</span>;
  const name = difficultyToString(pick.difficulty);
  const color = difficultyColor(name);
  return (
    <span
      className="whitespace-nowrap border px-1.5 py-[1px] text-[10px] font-bold uppercase tracking-[0.06em]"
      style={{ borderColor: color, color }}
    >
      {name} {pick.meter}
    </span>
  );
}

type RowState = 'ready' | 'not' | 'done' | 'left';

function RosterRow({ p, you }: { p: PlayerState; you: boolean }) {
  const host = p.id === 0;
  const state: RowState = p.left ? 'left' : p.done ? 'done' : p.ready ? 'ready' : 'not';
  const dot = state === 'ready' ? READY : state === 'done' ? DONE : 'rgba(236,236,236,.28)';
  const label = { left: 'LEFT', done: 'DONE', ready: 'READY', not: 'NOT READY' }[state];
  const labelColor = state === 'ready' ? READY : state === 'done' ? DONE : 'rgba(236,236,236,.5)';
  const lit = state === 'ready' || state === 'done';
  return (
    <div
      className="flex items-center gap-2.5 rounded-[3px] px-2 py-[6px]"
      style={{ background: lit ? dot + '14' : 'rgba(255,255,255,.025)' }}
    >
      <span
        className="h-[7px] w-[7px] flex-none rounded-full"
        style={{ background: dot, boxShadow: lit ? `0 0 6px ${dot}` : undefined }}
      />
      <span
        className={`min-w-0 flex-1 truncate text-[13px] tracking-[0.03em] ${p.left ? 'line-through opacity-45' : ''} ${you ? 'font-bold text-[#ececec]' : 'text-[#ececec]/80'}`}
      >
        {p.name}
        {host && (
          <span className="ml-2 text-[9px] font-bold tracking-[0.16em] text-[#ffcf3d]">HOST</span>
        )}
        {you && !host && (
          <span className="ml-2 text-[9px] tracking-[0.16em] text-[#ececec]/40">YOU</span>
        )}
        {you && host && (
          <span className="ml-1.5 text-[9px] tracking-[0.16em] text-[#ececec]/40">· YOU</span>
        )}
      </span>
      <DiffChip pick={p.pick} />
      <span
        className="w-[68px] flex-none text-right text-[10px] font-bold tracking-[0.1em]"
        style={{ color: labelColor }}
      >
        {label}
      </span>
    </div>
  );
}

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
      className="flex-none whitespace-nowrap rounded-[3px] border px-2.5 py-[3px] text-[10px] font-bold tracking-[0.1em] transition-colors"
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

/**
 * The dock body for an in-room state. `status` is the owning screen's one-line
 * situation report (WAITING FOR A SONG… / PICK A SONG… / transfer progress) —
 * ready/leave actions live on the owning screen (the START button + the SELECT
 * footer), not here, so the dock stays a pure roster display.
 */
export function RoomDock({ vs, status }: { vs: RoomUiState; status?: string }) {
  if (vs.k === 'idle') return null;
  const present = vs.k === 'in-room' ? vs.room.players.filter((p) => !p.left).length : 0;
  return (
    <div
      className="flex-none overflow-hidden rounded-[4px] border border-l-[3px]"
      style={{ borderColor: AC + '3a', borderLeftColor: AC, background: '#0e0f12f5' }}
    >
      {/* Header: ROOM · code · copy · leave */}
      <div
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: 'rgba(255,255,255,.06)', background: AC + '0f' }}
      >
        <span className="flex-none text-[10px] font-bold tracking-[0.24em]" style={{ color: AC }}>
          ROOM
        </span>
        {vs.k === 'in-room' && (
          <span className="flex-none text-[#ececec]">
            <CodeArrows code={vs.room.code} size={12} gap={4} />
          </span>
        )}
        {vs.k === 'in-room' && (
          <span className="flex-none text-[10px] tracking-[0.1em] text-[#ececec]/40">
            {present}P
          </span>
        )}
        <span className="h-px min-w-1 flex-1 bg-white/[0.06]" />
        {vs.k === 'in-room' && <CopyInviteButton code={vs.room.code} />}
        <button
          onClick={vs.k === 'error' ? dismissRoomError : leaveRoom}
          className="flex-none text-[10px] tracking-[0.12em] text-[#ececec]/50 hover:text-[#ff5d47]"
        >
          {vs.k === 'in-room' ? 'LEAVE' : vs.k === 'error' ? 'DISMISS' : 'CANCEL'} ✕
        </button>
      </div>

      <div className="px-3 py-2.5">
        {vs.k === 'busy' && (
          <div className="py-2 text-center text-[12px] tracking-[0.14em] text-[#ececec]/70">
            {vs.message}
          </div>
        )}

        {vs.k === 'error' && (
          <div className="py-1 text-[12px] tracking-[0.1em] text-[#ff5d47]">{vs.message}</div>
        )}

        {vs.k === 'in-room' && (
          <div className="flex flex-col gap-1.5">
            {/* Only current members — a player who left mid-song is kept in the
                room state for the standings, but must not linger in the dock. */}
            {vs.room.players
              .filter((p) => !p.left)
              .map((p) => (
                <RosterRow key={p.id} p={p} you={p.id === vs.room.selfId} />
              ))}
            {status && (
              <div className="mt-1 px-1 text-[11px] leading-snug tracking-[0.06em] text-[#ececec]/55">
                {status}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
