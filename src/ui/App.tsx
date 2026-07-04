import { useState, type ReactNode } from 'react';
import { Play } from './Play';
import { Inspector } from './Inspector';
import { SongSelect } from './SongSelect';
import { Options } from './Options';
import { Calibrate } from './Calibrate';
import type { PlayRequest } from './playRequest';
import { useMenuNav } from './useMenuNav';

type View = 'menu' | 'play' | 'inspect' | 'options' | 'calibrate';

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
          notefield <span className="pill">{title}</span>
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
  const [view, setView] = useState<View>('menu');
  const [req, setReq] = useState<PlayRequest | null>(null);

  if (view === 'play' && req) {
    return <Play req={req} onExit={() => setView('menu')} />;
  }
  if (view === 'options') {
    return <Options onBack={() => setView('menu')} onCalibrate={() => setView('calibrate')} />;
  }
  if (view === 'calibrate') {
    return <Calibrate onBack={() => setView('options')} />;
  }
  if (view === 'inspect') {
    return (
      <Chrome title="engine inspector" onBack={() => setView('menu')}>
        <Inspector />
      </Chrome>
    );
  }

  return (
    <SongSelect
      onPlay={(r) => {
        setReq(r);
        setView('play');
      }}
      onInspect={() => setView('inspect')}
      onOptions={() => setView('options')}
    />
  );
}
