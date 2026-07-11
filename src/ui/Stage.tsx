/**
 * The STEPLINE stage: a full-viewport surface (fills any aspect ratio — fixed
 * header/footer bars with a flexing body) using the design's dark palette,
 * Space Grotesk, and tabular numerals.
 */
import { type ReactNode } from 'react';

export const STEP_AC = '#ff5d47';

export function Stage({
  label,
  children,
  footer,
  headerRight,
}: {
  label: string;
  children: ReactNode;
  footer?: ReactNode;
  headerRight?: ReactNode;
}) {
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-[#0b0c0e] font-grotesk text-[#ececec] [font-variant-numeric:tabular-nums]">
      <div className="flex h-[56px] flex-none items-center justify-between border-b border-white/[0.09] px-[28px]">
        <div className="flex items-baseline gap-3">
          <span className="text-[19px] font-bold tracking-[0.22em]">STEPZONE</span>
          <span className="text-[13px] tracking-[0.18em]" style={{ color: STEP_AC }}>
            {label}
          </span>
        </div>
        {headerRight}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      {footer && (
        <div className="flex h-[44px] flex-none items-center gap-6 border-t border-white/[0.09] px-[28px] text-[12px] tracking-[0.14em] text-[#ececec]/62">
          {footer}
        </div>
      )}
    </div>
  );
}
