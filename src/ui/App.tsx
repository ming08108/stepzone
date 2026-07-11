import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Play } from './Play';
import { PlayerOptions } from './PlayerOptions';
import { Inspector } from './Inspector';
import { SongSelect } from './SongSelect';
import { Options } from './Options';
import { Calibrate } from './Calibrate';
import { Benchmark } from './Benchmark';
import { InputTest } from './InputTest';
import { BgConvertBadge } from './BgConvertBadge';
import { RawGamepadHint } from './RawGamepadHint';
import type { PlayRequest } from './playRequest';
import { flushQueue } from '../net/leaderboard';
import {
  consumeFollow,
  roomState,
  subscribeRoom,
  takeRoomForPlay,
  type RoomUiState,
} from './roomStore';
import { RoomDock } from './RoomDock';

type View =
  'menu' | 'playoptions' | 'play' | 'inspect' | 'options' | 'calibrate' | 'benchmark' | 'inputtest';

/** The one-line "what's happening / what to do" for the room dock, given the
 *  current screen — makes a GUEST's inability to pick songs explicit. */
function roomDockStatus(view: View, vs: RoomUiState): string | undefined {
  if (vs.k !== 'in-room') return undefined;
  const room = vs.room;
  const present = room.players.filter((p) => !p.left).length;
  if (view === 'playoptions') {
    if (room.self?.ready) return 'WAITING FOR EVERYONE TO READY UP…';
    if (present < 2) return 'WAITING FOR PLAYERS — SHARE THE CODE OR LINK';
    return 'PICK YOUR DIFFICULTY, THEN PRESS START TO READY UP';
  }
  if (room.isHost) {
    return present < 2
      ? 'WAITING FOR PLAYERS — PICK A SONG OR SHARE THE CODE'
      : 'PICK A SONG FOR THE ROOM';
  }
  // Guest: they can't pick — the host does. Make that unmistakable.
  if (vs.follow.k === 'resolving' || vs.follow.k === 'error') return vs.follow.message;
  if (room.phase === 'playing') return 'A SONG IS IN PROGRESS — YOU JOIN THE NEXT ONE';
  return 'THE HOST PICKS THE SONGS — SIT TIGHT, YOU JOIN AUTOMATICALLY';
}

export function App() {
  // ?bench / ?bench=auto deep-links straight into the render benchmark
  // (the automated perf harness drives it this way).
  const [view, setView] = useState<View>(() =>
    new URLSearchParams(location.search).has('bench') ? 'benchmark' : 'menu',
  );
  const [req, setReq] = useState<PlayRequest | null>(null);

  // Retry leaderboard submissions parked while offline (net/leaderboard).
  useEffect(() => {
    void flushQueue();
  }, []);

  // Room routing (docs/VERSUS.md): a GUEST follows the host's song picks.
  // When the store resolves a broadcast song (local by hash, or transferred
  // P2P) it stages a play request here; when the host clears their pick, a
  // guest parked on PLAYER OPTIONS returns to the songs. Never yanks anyone
  // out of live gameplay — 'play' finishes on its own.
  const vs = useSyncExternalStore(subscribeRoom, roomState);
  useEffect(() => {
    if (vs.k !== 'in-room' || vs.room.isHost) return;
    if (vs.follow.k === 'ready' && view !== 'play') {
      const staged = consumeFollow();
      if (staged) {
        setReq(staged);
        setView('playoptions');
      }
    } else if (!vs.room.song && view === 'playoptions') {
      setView('menu');
    }
  }, [vs, view]);

  let body: ReactNode;
  if (view === 'playoptions' && req) {
    body = (
      <PlayerOptions
        req={req}
        onStart={(chart, practice) => {
          // A live room race (roomStore) rides into gameplay here — App is
          // the single place that attaches it to the request.
          setReq((r) => {
            if (!r) return r;
            const versus = takeRoomForPlay(r.song) ?? undefined;
            return { ...r, chart: chart ?? r.chart, practice: practice ?? null, versus };
          });
          setView('play');
        }}
        onBack={() => setView('menu')}
      />
    );
  } else if (view === 'play' && req) {
    body = (
      <Play
        req={req}
        onExit={() => {
          // The ROOM persists across plays — only this request's ride-along
          // handle is dropped. Play already reported our result (or DNF).
          if (req.versus) setReq((r) => (r ? { ...r, versus: undefined } : r));
          setView('menu');
        }}
      />
    );
  } else if (view === 'options') {
    body = (
      <Options
        onBack={() => setView('menu')}
        onCalibrate={() => setView('calibrate')}
        onBenchmark={() => setView('benchmark')}
        onInputTest={() => setView('inputtest')}
        onInspect={() => setView('inspect')}
      />
    );
  } else if (view === 'benchmark') {
    body = <Benchmark onBack={() => setView('options')} />;
  } else if (view === 'inputtest') {
    body = <InputTest onBack={() => setView('options')} />;
  } else if (view === 'calibrate') {
    body = <Calibrate onBack={() => setView('options')} />;
  } else if (view === 'inspect') {
    body = <Inspector onBack={() => setView('options')} />;
  } else {
    body = (
      <SongSelect
        onPlay={(r) => {
          setReq(r);
          // Everyone goes through PLAYER OPTIONS — room guests included
          // (they pick their own difficulty there before readying up).
          setView('playoptions');
        }}
        onOptions={() => setView('options')}
      />
    );
  }

  // Background-conversion badge floats over every view (the work usually runs
  // while the user is mid-song, exactly when no menu chrome is visible).
  return (
    <>
      {body}
      {/* The room dock lives here — one persistent element pinned bottom-right
          on every screen except gameplay, so the party stays visible and in the
          same place as you move between song select, options, and player
          options. */}
      {vs.k !== 'idle' && view !== 'play' && (
        <div className="fixed bottom-4 right-4 z-[45] w-[432px] max-w-[92vw]">
          <RoomDock vs={vs} status={roomDockStatus(view, vs)} />
        </div>
      )}
      <BgConvertBadge />
      {view !== 'play' && <RawGamepadHint />}
    </>
  );
}
