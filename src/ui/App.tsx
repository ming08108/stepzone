import { useEffect, useState, type ReactNode } from 'react';
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
import { useMenuNav } from './useMenuNav';
import { abandonVersus, takeVersusForPlay } from './versusSession';

type View =
  'menu' | 'playoptions' | 'play' | 'inspect' | 'options' | 'calibrate' | 'benchmark' | 'inputtest';

function Chrome({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  useMenuNav(onBack);
  return (
    <div className="mx-auto max-w-[1000px] px-6 pb-16 pt-8">
      <header className="mb-6 flex items-center justify-between">
        <div className="text-xl font-bold">
          stepzone <span className="pill">{title}</span>
        </div>
        <button
          onClick={onBack}
          className="rounded-lg border border-line px-4 py-2 text-muted hover:border-accent hover:text-ink"
        >
          ← Menu
        </button>
      </header>
      {children}
    </div>
  );
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

  let body: ReactNode;
  if (view === 'playoptions' && req) {
    body = (
      <PlayerOptions
        req={req}
        onStart={(chart, practice) => {
          // A live versus session (versusSession store) rides into gameplay
          // here — App is the single place that attaches it to the request.
          setReq((r) => {
            if (!r) return r;
            const song = r.song;
            const versus = takeVersusForPlay(song) ?? undefined;
            return { ...r, chart: chart ?? r.chart, practice: practice ?? null, versus };
          });
          setView('play');
        }}
        onBack={() => {
          abandonVersus(); // safety net — SELECT in-screen already left the room
          setView('menu');
        }}
      />
    );
  } else if (view === 'play' && req) {
    body = (
      <Play
        req={req}
        onExit={() => {
          // A live versus match ends when the play view goes away — tell the
          // peer and release the RTCPeerConnection here (not in Play's own
          // unmount, which StrictMode double-fires in dev).
          if (req.versus) {
            abandonVersus();
            setReq((r) => (r ? { ...r, versus: undefined } : r));
          }
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
    body = (
      <Chrome title="engine inspector" onBack={() => setView('options')}>
        <Inspector />
      </Chrome>
    );
  } else {
    body = (
      <SongSelect
        onPlay={(r) => {
          setReq(r);
          // Everyone goes through PLAYER OPTIONS — versus joiners included
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
      <BgConvertBadge />
      {view !== 'play' && <RawGamepadHint />}
    </>
  );
}
