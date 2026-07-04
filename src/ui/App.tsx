import { useState } from 'react';
import { Play } from './Play';
import { Inspector } from './Inspector';

type Tab = 'play' | 'inspect';

export function App() {
  const [tab, setTab] = useState<Tab>('play');

  // Play is a full-screen arcade view; Inspect is the padded engine view.
  if (tab === 'play') {
    return <Play onInspect={() => setTab('inspect')} />;
  }

  return (
    <div className="mx-auto max-w-[1000px] px-6 pb-16 pt-8">
      <header className="mb-6 flex items-center justify-between">
        <div className="text-xl font-bold">
          notefield <span className="pill">engine inspector</span>
        </div>
        <nav>
          <button
            onClick={() => setTab('play')}
            className="rounded-lg border border-line px-4 py-2 text-muted hover:border-accent hover:text-ink"
          >
            ▶ Play
          </button>
        </nav>
      </header>

      <Inspector />

      <footer className="mt-8 text-sm text-muted">
        <code className="rounded bg-white/5 px-1.5 py-0.5">src/dev/example.ssc</code> · engine
        verified by <code className="rounded bg-white/5 px-1.5 py-0.5">npm test</code>
      </footer>
    </div>
  );
}
