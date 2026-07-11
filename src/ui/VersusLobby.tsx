/**
 * The versus lobby dock on PLAYER OPTIONS — a non-modal block above the START
 * button, so both players keep driving their option rows (difficulty, mods)
 * underneath while the room fills and readies. Pad input is handled by
 * PLAYER OPTIONS itself (START = ready, SELECT = leave); the buttons here are
 * the mouse mirrors of those, plus COPY INVITE LINK (legitimately mouse-only
 * — the arrow code is the pad path).
 */
import { useState } from 'react';
import { getIdentity } from '../net/identity';
import { codeToArrows, type VersusChartMeta } from '../net/versus';
import { difficultyToString } from '../song/difficulty';
import { difficultyColor } from './difficultyUi';
import { STEP_AC as AC } from './Stage';
import { abandonVersus, type VersusPhase } from './versusSession';

function DiffChip({ pick }: { pick: VersusChartMeta | null }) {
  if (!pick) return <span className="text-[11px] text-[#ececec]/35">CHOOSING…</span>;
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

export function VersusLobby({
  vs,
  selfPick,
  selfReady,
  onReady,
}: {
  vs: VersusPhase;
  /** The DIFFICULTY row's current selection (live until readied). */
  selfPick: VersusChartMeta;
  selfReady: boolean;
  onReady: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (vs.k === 'idle') return null;

  const copyLink = (code: string) => {
    void navigator.clipboard
      ?.writeText(`${location.origin}/?join=${code}`)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  return (
    <div
      className="mt-1 flex-none border border-l-[3px] px-4 py-3"
      style={{ borderColor: AC + '46', borderLeftColor: AC + '90', background: AC + '0d' }}
    >
      <div className="mb-2 flex items-center gap-3">
        <span className="text-[11px] font-bold tracking-[0.22em]" style={{ color: AC }}>
          LIVE VERSUS
        </span>
        <span className="h-px flex-1 bg-white/[0.08]" />
        <button
          onClick={abandonVersus}
          className="text-[11px] tracking-[0.12em] text-[#ececec]/45 hover:text-[#ececec]"
        >
          LEAVE ✕
        </button>
      </div>

      {vs.k === 'busy' && (
        <div className="py-2 text-center text-[12px] tracking-[0.14em] text-[#ececec]/60">
          {vs.message}
        </div>
      )}

      {vs.k === 'error' && (
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="text-[12px] tracking-[0.1em] text-[#ffd94b]">{vs.message}</span>
          <button
            onClick={abandonVersus}
            className="border px-3 py-1 text-[11px] tracking-[0.14em]"
            style={{ borderColor: AC }}
          >
            OK
          </button>
        </div>
      )}

      {vs.k === 'hosting' && (
        <div className="flex flex-col items-center gap-2 py-1">
          <div className="text-[26px] font-bold tracking-[0.16em]" style={{ color: AC }}>
            {codeToArrows(vs.code)}
          </div>
          <div className="text-[11px] tracking-[0.14em] text-[#ececec]/55">
            WAITING FOR A RIVAL — SHARE THE CODE OR
          </div>
          <button
            onClick={() => copyLink(vs.code)}
            className="border px-3 py-1 text-[11px] tracking-[0.14em]"
            style={{ borderColor: AC, color: copied ? '#59f07f' : '#ececec' }}
          >
            {copied ? '✓ LINK COPIED' : 'COPY INVITE LINK'}
          </button>
        </div>
      )}

      {vs.k === 'connected' && (
        <div className="flex flex-col gap-1.5">
          {[
            {
              name: `${getIdentity().name} (YOU)`,
              pick: selfReady ? (vs.session.match.selfPick ?? selfPick) : selfPick,
              ready: selfReady,
              you: true,
            },
            {
              name: vs.session.match.opponent.name ?? '…',
              pick: vs.session.match.opponent.pick,
              ready: vs.session.match.opponent.ready,
              you: false,
            },
          ].map((p) => (
            <div key={p.name} className="flex items-center gap-3 text-[13px] tracking-[0.08em]">
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <DiffChip pick={p.pick} />
              {p.you && !p.ready ? (
                <button
                  onClick={onReady}
                  className="border px-3 py-[3px] text-[11px] font-bold tracking-[0.14em]"
                  style={{ borderColor: AC }}
                >
                  READY UP
                </button>
              ) : (
                <span
                  className="w-[86px] text-right text-[11px] tracking-[0.12em]"
                  style={{ color: p.ready ? '#59f07f' : 'rgba(236,236,236,.35)' }}
                >
                  {p.ready ? 'READY' : 'NOT READY'}
                </span>
              )}
            </div>
          ))}
          <div className="text-[11px] text-[#ececec]/40">
            Pick your own difficulty, then START — the song begins on both machines together.
          </div>
        </div>
      )}
    </div>
  );
}
