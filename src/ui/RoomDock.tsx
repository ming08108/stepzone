/**
 * The room dock — the persistent party strip shown wherever a room is live:
 * above the START button on PLAYER OPTIONS, and floating over SONG SELECT
 * between songs. Non-modal: players keep driving the screen underneath while
 * the roster fills, readies, and cycles. Pad input is handled by the OWNING
 * screen (START = ready, SELECT = leave/back); the buttons here are mouse
 * mirrors, plus COPY INVITE LINK (legitimately mouse-only — the arrow code is
 * the pad path).
 */
import { useState } from 'react';
import type { PlayerState } from '../net/roomPeer';
import { codeToArrows, type VersusChartMeta } from '../net/versus';
import { difficultyToString } from '../song/difficulty';
import { difficultyColor } from './difficultyUi';
import { STEP_AC as AC } from './Stage';
import { leaveRoom, type RoomUiState } from './roomStore';

function DiffChip({ pick }: { pick: VersusChartMeta | null }) {
  if (!pick) return <span className="text-[11px] text-[#ececec]/45">CHOOSING…</span>;
  const name = difficultyToString(pick.difficulty);
  const color = difficultyColor(name);
  return (
    <span
      className="border px-2 py-[2px] text-[11px] font-bold uppercase tracking-[0.08em]"
      style={{ borderColor: color, color }}
    >
      {name} {pick.meter}
    </span>
  );
}

function RosterRow({ p, you }: { p: PlayerState; you: boolean }) {
  return (
    <div className="flex items-center gap-3 text-[13px] tracking-[0.08em]">
      <span className={`min-w-0 flex-1 truncate${p.left ? ' line-through opacity-50' : ''}`}>
        {p.name}
        {you ? ' (YOU)' : ''}
        {p.id === 0 ? ' ★' : ''}
      </span>
      <DiffChip pick={p.pick} />
      <span
        className="w-[86px] text-right text-[11px] tracking-[0.12em]"
        style={{
          color: p.left ? 'rgba(236,236,236,.45)' : p.ready ? '#59f07f' : 'rgba(236,236,236,.45)',
        }}
      >
        {p.left ? 'LEFT' : p.done ? 'FINISHED' : p.ready ? 'READY' : 'NOT READY'}
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
      className="border px-3 py-1 text-[11px] tracking-[0.14em]"
      style={{ borderColor: AC, color: copied ? '#59f07f' : '#ececec' }}
    >
      {copied ? '✓ LINK COPIED' : 'COPY INVITE LINK'}
    </button>
  );
}

/**
 * The dock body for an in-room state. `status` is the owning screen's one-line
 * situation report (WAITING FOR A SONG… / PICK A SONG… / transfer progress);
 * `action` is an optional screen-owned button (e.g. READY UP on options).
 */
export function RoomDock({
  vs,
  status,
  action,
}: {
  vs: RoomUiState;
  status?: string;
  action?: React.ReactNode;
}) {
  if (vs.k === 'idle') return null;
  return (
    <div
      className="flex-none border border-l-[3px] px-4 py-3"
      style={{ borderColor: AC + '46', borderLeftColor: AC + '90', background: '#101113f2' }}
    >
      <div className="mb-2 flex items-center gap-3">
        <span className="text-[11px] font-bold tracking-[0.22em]" style={{ color: AC }}>
          MULTIPLAYER
        </span>
        {vs.k === 'in-room' && (
          <span className="text-[13px] font-bold tracking-[0.14em] text-[#ececec]/85">
            {codeToArrows(vs.room.code)}
          </span>
        )}
        <span className="h-px flex-1 bg-white/[0.1]" />
        {vs.k === 'in-room' && <CopyInviteButton code={vs.room.code} />}
        <button
          onClick={leaveRoom}
          className="text-[11px] tracking-[0.12em] text-[#ececec]/55 hover:text-[#ececec]"
        >
          LEAVE ✕
        </button>
      </div>

      {vs.k === 'busy' && (
        <div className="py-2 text-center text-[12px] tracking-[0.14em] text-[#ececec]/70">
          {vs.message}
        </div>
      )}

      {vs.k === 'error' && (
        <div className="py-1 text-[12px] tracking-[0.1em] text-[#ffd94b]">{vs.message}</div>
      )}

      {vs.k === 'in-room' && (
        <div className="flex flex-col gap-1.5">
          {vs.room.players.map((p) => (
            <RosterRow key={p.id} p={p} you={p.id === vs.room.selfId} />
          ))}
          <div className="mt-1 flex items-center gap-3">
            <span className="min-w-0 flex-1 text-[11px] tracking-[0.08em] text-[#ececec]/55">
              {status ?? ''}
            </span>
            {action}
          </div>
        </div>
      )}
    </div>
  );
}
