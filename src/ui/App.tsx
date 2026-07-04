import { useState } from 'react';
import { Play } from './Play';
import { Inspector } from './Inspector';
import { SongSelect } from './SongSelect';
import type { PlayRequest } from './playRequest';

type View = 'menu' | 'play' | 'inspect';

export function App() {
  const [view, setView] = useState<View>('menu');
  const [req, setReq] = useState<PlayRequest | null>(null);

  if (view === 'play' && req) {
    return <Play req={req} onExit={() => setView('menu')} />;
  }

  if (view === 'inspect') {
    return (
      <div className="mx-auto max-w-[1000px] px-6 pb-16 pt-8">
        <header className="mb-6 flex items-center justify-between">
          <div className="text-xl font-bold">
            notefield <span className="pill">engine inspector</span>
          </div>
          <button
            onClick={() => setView('menu')}
            className="rounded-lg border border-line px-4 py-2 text-muted hover:border-accent hover:text-ink"
          >
            ← Menu
          </button>
        </header>
        <Inspector />
      </div>
    );
  }

  return (
    <SongSelect
      onPlay={(r) => {
        setReq(r);
        setView('play');
      }}
      onInspect={() => setView('inspect')}
    />
  );
}
