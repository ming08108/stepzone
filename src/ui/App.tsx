import { useState } from 'react';
import { Play } from './Play';
import { Inspector } from './Inspector';

type Tab = 'play' | 'inspect';

export function App() {
  const [tab, setTab] = useState<Tab>('play');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          notefield <span className="tag">milestone 3 · playable</span>
        </div>
        <nav>
          <button className={tab === 'play' ? 'active' : ''} onClick={() => setTab('play')}>
            Play
          </button>
          <button className={tab === 'inspect' ? 'active' : ''} onClick={() => setTab('inspect')}>
            Inspect
          </button>
        </nav>
      </header>

      {tab === 'play' ? <Play /> : <Inspector />}

      <footer>
        <code>src/dev/example.ssc</code> · engine verified by <code>npm test</code>
      </footer>
    </div>
  );
}
