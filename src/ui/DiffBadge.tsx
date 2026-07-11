/**
 * The ahead/behind diff readout for GhostRace (RoomRace's rival bars share
 * only diffColor — they stack, so they position themselves): a bordered
 * badge, ahead/behind color, and percent formatting; the caller supplies the
 * label content and diff source.
 */
import type { ReactNode } from 'react';

const AHEAD_CLR = '#59f07f';
const BEHIND_CLR = '#ff5d47';

export function diffColor(diff: number): string {
  return diff >= 0 ? AHEAD_CLR : BEHIND_CLR;
}

export function DiffBadge({
  children,
  diff,
  borderColor,
}: {
  /** Leading content before the +/-diff readout (e.g. "VS RIVAL"). */
  children: ReactNode;
  diff: number;
  /** Override the badge border; defaults to the diff color. */
  borderColor?: string;
}) {
  const ahead = diff >= 0;
  const clr = diffColor(diff);
  return (
    <div
      className="absolute left-4 top-4 z-[3] border bg-black/45 px-3 py-1.5 text-[12px] tracking-[0.14em] text-[#ececec]/85"
      style={{ borderColor: borderColor ?? clr + '66' }}
    >
      {children}{' '}
      <span className="font-bold" style={{ color: clr }}>
        {ahead ? '+' : ''}
        {(diff * 100).toFixed(2)}%
      </span>
    </div>
  );
}
