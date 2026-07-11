/**
 * A prominent, centered "please wait" overlay for the moments a room join has
 * something happening but no screen of its own yet: connecting to the host, and
 * a guest resolving the host's song (finding a local copy, downloading it P2P
 * with a progress bar, adding it, loading it). Without this, joining a room
 * where the host already picked a song left you on song select for a beat with
 * only a tiny dock line — this makes it unmistakable. Rendered globally by App.
 */
import { useSyncExternalStore } from 'react';
import { roomState, subscribeRoom } from './roomStore';

const AC = '#ff5d47';

export function RoomJoinOverlay() {
  const vs = useSyncExternalStore(subscribeRoom, roomState);

  let title: string;
  let message: string;
  let progress: number | undefined;
  if (vs.k === 'busy') {
    title = 'MULTIPLAYER';
    message = vs.message;
  } else if (vs.k === 'in-room' && vs.follow.k === 'resolving') {
    title = 'GETTING READY';
    message = vs.follow.message;
    progress = vs.follow.progress;
  } else {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/72 backdrop-blur-[2px]">
      <div className="flex w-[440px] max-w-[92%] flex-col items-center gap-4 border border-white/15 bg-[#0b0c0e] px-8 py-9 shadow-2xl">
        <div className="text-[12px] font-bold tracking-[0.26em]" style={{ color: AC }}>
          {title}
        </div>
        <div className="text-center text-[16px] font-bold tracking-[0.04em] text-[#ececec]">
          {message}
        </div>
        {progress !== undefined ? (
          <div className="mt-1 w-[280px]">
            <div className="h-[8px] w-full overflow-hidden rounded-full bg-white/[0.12]">
              <div
                className="h-full rounded-full transition-[width] duration-150"
                style={{
                  width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`,
                  background: AC,
                }}
              />
            </div>
            <div className="mt-1.5 text-center text-[12px] tabular-nums tracking-[0.1em] text-[#ececec]/55">
              {Math.round(Math.max(0, Math.min(1, progress)) * 100)}%
            </div>
          </div>
        ) : (
          <div
            className="text-[12px] tracking-[0.3em] text-[#ececec]/45"
            style={{ animation: 'blinkStart 1.4s infinite' }}
          >
            • • •
          </div>
        )}
      </div>
    </div>
  );
}
