import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Play } from './Play';
import { PlayerOptions } from './PlayerOptions';
import { SongSelect } from './SongSelect';
import { Options } from './Options';
import { Calibrate } from './Calibrate';
import { Benchmark } from './Benchmark';
import { InputTest } from './InputTest';
import { VrmTest } from './VrmTest';
// Code-split: IsaacViewer pulls in three/webgpu; keep it out of the main bundle.
const IsaacViewer = lazy(() => import('./IsaacViewer').then((m) => ({ default: m.IsaacViewer })));
const ReplayDancer = lazy(() =>
  import('./ReplayDancer').then((m) => ({ default: m.ReplayDancer })),
);
const ExperimentsDashboard = lazy(() =>
  import('./ExperimentsDashboard').then((m) => ({ default: m.ExperimentsDashboard })),
);
import { BgConvertBadge } from './BgConvertBadge';
import { RawGamepadHint } from './RawGamepadHint';
import type { PlayRequest } from './playRequest';
import { flushQueue } from '../net/leaderboard';
import { consumeFollow, roomState, subscribeRoom, takeRoomForPlay } from './roomStore';

type View =
  | 'menu'
  | 'playoptions'
  | 'play'
  | 'options'
  | 'calibrate'
  | 'benchmark'
  | 'inputtest'
  | 'vrmtest'
  | 'isaacviewer'
  | 'replaydancer'
  | 'experiments';

export function App() {
  // ?bench / ?bench=auto deep-links into the render benchmark; ?vrm into the
  // three.js dancer proving ground (?model=miku|ps1|a|b|c picks the avatar).
  const [view, setView] = useState<View>(() => {
    const params = new URLSearchParams(location.search);
    if (params.has('bench')) return 'benchmark';
    if (params.has('vrm')) return 'vrmtest';
    if (params.has('isaacviewer')) return 'isaacviewer';
    if (params.has('replaydancer')) return 'replaydancer';
    if (params.has('experiments')) return 'experiments';
    return 'menu';
  });
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
  //
  // Only route into pre-play while the room is in the LOBBY. A guest who joins
  // mid-song is sent the in-progress song too (so its files transfer early),
  // but must NOT be dropped onto PLAYER OPTIONS for a race already underway —
  // there READY UP silently no-ops (the peer gates ready to the lobby phase).
  // The staged 'ready' follow persists, so when the race ends and the room
  // returns to the lobby this effect re-runs and routes them for the next one.
  const vs = useSyncExternalStore(subscribeRoom, roomState);
  useEffect(() => {
    if (vs.k !== 'in-room' || vs.room.isHost) return;
    if (vs.follow.k === 'ready' && view !== 'play' && vs.room.phase === 'lobby') {
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
        onSettings={() => setView('options')}
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
      />
    );
  } else if (view === 'benchmark') {
    body = <Benchmark onBack={() => setView('options')} />;
  } else if (view === 'inputtest') {
    body = <InputTest onBack={() => setView('options')} />;
  } else if (view === 'vrmtest') {
    body = <VrmTest onExit={() => setView('menu')} />;
  } else if (view === 'isaacviewer') {
    body = (
      <Suspense fallback={null}>
        <IsaacViewer onExit={() => setView('menu')} />
      </Suspense>
    );
  } else if (view === 'replaydancer') {
    body = (
      <Suspense fallback={null}>
        <ReplayDancer onExit={() => setView('menu')} />
      </Suspense>
    );
  } else if (view === 'experiments') {
    body = (
      <Suspense fallback={null}>
        <ExperimentsDashboard onExit={() => setView('menu')} />
      </Suspense>
    );
  } else if (view === 'calibrate') {
    body = <Calibrate onBack={() => setView('options')} />;
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
      {/* The party lives in the docked PartyBar that SONG SELECT and PLAYER
          OPTIONS render above their legends (design 6a) — one surface for
          entry, connecting, roster and transfers, replacing the floating dock
          and the blocking join overlay that used to be pinned here. */}
      <BgConvertBadge />
      {view !== 'play' && <RawGamepadHint />}
    </>
  );
}
