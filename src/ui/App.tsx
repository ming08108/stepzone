import { useState, type ReactNode } from 'react';
import { Play } from './Play';
import { PlayerOptions } from './PlayerOptions';
import { Inspector } from './Inspector';
import { SongSelect } from './SongSelectStepline';
import { Options } from './Options';
import { Calibrate } from './Calibrate';
import { Benchmark } from './Benchmark';
import { InputTest } from './InputTest';
import { BgConvertBadge } from './BgConvertBadge';
import { RawGamepadHint } from './RawGamepadHint';
import type { PlayRequest } from './playRequest';
import { useMenuNav } from './useMenuNav';

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

  let body: ReactNode;
  if (view === 'playoptions' && req) {
    body = (
      <PlayerOptions
        req={req}
        onStart={(chart, practice) => {
          setReq((r) => (r ? { ...r, chart: chart ?? r.chart, practice: practice ?? null } : r));
          setView('play');
        }}
        onBack={() => setView('menu')}
      />
    );
  } else if (view === 'play' && req) {
    body = <Play req={req} onExit={() => setView('menu')} />;
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
  } else if (view === 'calibrate') {
    body = <Calibrate onBack={() => setView('options')} />;
  } else if (view === 'inspect') {
    body = (
      <Chrome title="engine inspector" onBack={() => setView('menu')}>
        <Inspector />
      </Chrome>
    );
  } else {
    body = (
      <SongSelect
        onPlay={(r) => {
          setReq(r);
          setView('playoptions');
        }}
        onInspect={() => setView('inspect')}
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
