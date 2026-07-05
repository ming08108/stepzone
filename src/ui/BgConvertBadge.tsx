/**
 * Small fixed badge (bottom-right, every screen) while a legacy background
 * video is being converted (io/bgVideo.ts) — the work runs in ffmpeg's worker
 * while the user is typically mid-song, so without this the only sign of life
 * was the video "appearing" a play later. Non-interactive by design.
 */
import { useEffect, useState } from 'react';
import { subscribeBgConvert, type BgConvertStatus } from '../io/bgVideo';

export function BgConvertBadge() {
  const [status, setStatus] = useState<BgConvertStatus | null>(null);
  useEffect(() => subscribeBgConvert(setStatus), []);
  if (!status) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-3 right-3 z-50 flex items-center gap-2 border border-white/[0.14] bg-[#0b0c0e]/90 px-3 py-[6px] font-grotesk text-[11px] tracking-[0.14em] text-[#ececec]/80"
      title="Converting a legacy background video — it plays from the next start of this song"
    >
      <span style={{ color: '#ff5d47', animation: 'blinkStart 1.4s infinite' }}>●</span>
      <span className="max-w-[320px] truncate">
        CONVERTING BG — {status.name.toUpperCase()} {Math.round(status.progress * 100)}%
        {status.remaining > 1 ? ` (+${status.remaining - 1} QUEUED)` : ''}
      </span>
    </div>
  );
}
