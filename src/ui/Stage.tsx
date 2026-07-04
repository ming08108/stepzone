/**
 * The STEPLINE stage: a fixed 1280×720 surface scaled uniformly to fit the
 * window (letterboxed on #050506, any aspect ratio), with the shared header and
 * optional footer/hint bar. Space Grotesk, tabular numerals.
 */
import { type ReactNode, useEffect, useState } from 'react';

export const STEP_AC = '#ff4d3d';

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
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / 1280, window.innerHeight / 720));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-hidden bg-[#050506]">
      <div
        className="relative flex h-[720px] w-[1280px] flex-none flex-col overflow-hidden bg-[#0b0c0e] font-grotesk text-[#ececec] [font-variant-numeric:tabular-nums]"
        style={{ transform: `scale(${scale})`, transformOrigin: 'center' }}
      >
        <div className="flex h-[56px] flex-none items-center justify-between border-b border-white/[0.09] px-[28px]">
          <div className="flex items-baseline gap-3">
            <span className="text-[19px] font-bold tracking-[0.22em]">STEPLINE</span>
            <span className="text-[13px] tracking-[0.18em]" style={{ color: STEP_AC }}>
              {label}
            </span>
          </div>
          {headerRight}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        {footer && (
          <div className="flex h-[44px] flex-none items-center gap-6 border-t border-white/[0.09] px-[28px] text-[12px] tracking-[0.14em] text-[#ececec]/45">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
