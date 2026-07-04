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
    <div className="app">
      <header className="topbar">
        <div className="brand">
          notefield <span className="tag">engine inspector</span>
        </div>
        <nav>
          <button onClick={() => setTab('play')}>▶ Play</button>
        </nav>
      </header>

      <Inspector />

      <footer>
        <code>src/dev/example.ssc</code> · engine verified by <code>npm test</code>
      </footer>
    </div>
  );
}
