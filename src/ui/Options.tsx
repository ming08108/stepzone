import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_KEYBINDINGS, type Settings } from '../app/settings';
import { useSettings } from './SettingsContext';

const COLS = [
  { i: 0, label: 'Left', glyph: '←' },
  { i: 1, label: 'Down', glyph: '↓' },
  { i: 2, label: 'Up', glyph: '↑' },
  { i: 3, label: 'Right', glyph: '→' },
];

function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  const arrows: Record<string, string> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
  };
  return arrows[code] ?? code;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted">{title}</h2>
      {children}
    </section>
  );
}

export function Options({ onBack, onCalibrate }: { onBack: () => void; onCalibrate: () => void }) {
  const { settings, update } = useSettings();
  const [rebinding, setRebinding] = useState<number | null>(null);

  // Capture the next key press while rebinding a column.
  useEffect(() => {
    if (rebinding === null) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code === 'Escape') {
        setRebinding(null);
        return;
      }
      const kb = { ...settings.keybindings, [e.code]: rebinding };
      update({ keybindings: kb });
      setRebinding(null);
    };
    window.addEventListener('keydown', onKey, { once: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [rebinding, settings.keybindings, update]);

  const keysFor = (col: number) =>
    Object.entries(settings.keybindings)
      .filter(([, c]) => c === col)
      .map(([code]) => code);

  const clearKey = (code: string) => {
    const kb = { ...settings.keybindings };
    delete kb[code];
    update({ keybindings: kb });
  };

  const isC = settings.scrollMode === 'C';

  return (
    <div className="mx-auto max-w-[720px] px-6 pb-16 pt-8">
      <header className="mb-6 flex items-center justify-between">
        <div className="text-xl font-bold">
          notefield <span className="pill">options</span>
        </div>
        <button
          onClick={onBack}
          className="rounded-lg border border-line px-4 py-2 text-muted hover:border-accent hover:text-ink"
        >
          ← Menu
        </button>
      </header>

      <Section title="Scroll">
        <div className="mb-3 flex gap-2">
          {(['C', 'X'] as const).map((m) => (
            <button
              key={m}
              onClick={() => update({ scrollMode: m, scrollValue: m === 'C' ? 550 : 2 })}
              className={`rounded-lg border px-4 py-1.5 ${
                settings.scrollMode === m
                  ? 'border-accent bg-accent/10 text-ink'
                  : 'border-line text-muted'
              }`}
            >
              {m}Mod
            </button>
          ))}
          <span className="self-center text-sm text-muted">
            {isC ? 'constant speed (BPM-independent)' : 'multiple of the song BPM'}
          </span>
        </div>
        <label className="flex items-center gap-4">
          <input
            type="range"
            min={isC ? 100 : 0.5}
            max={isC ? 1200 : 8}
            step={isC ? 10 : 0.25}
            value={settings.scrollValue}
            onChange={(e) => update({ scrollValue: Number(e.target.value) })}
            className="flex-1 accent-[var(--color-accent)]"
          />
          <span className="w-24 text-right font-mono tabular-nums">
            {isC ? `C${Math.round(settings.scrollValue)}` : `${settings.scrollValue.toFixed(2)}×`}
          </span>
        </label>
      </Section>

      <Section title="Speed (practice)">
        <label className="flex items-center gap-4">
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={settings.musicRate}
            onChange={(e) => update({ musicRate: Number(e.target.value) })}
            className="flex-1 accent-[var(--color-accent)]"
          />
          <span className="w-24 text-right font-mono tabular-nums">
            {settings.musicRate.toFixed(2)}×
          </span>
        </label>
        <p className="mt-1 text-sm text-muted">
          Slows/speeds the music; judgment windows scale too.
        </p>
      </Section>

      <Section title="Sync / offset">
        {(
          [
            ['audioOffsetMs', 'Audio offset', 'shifts judgment + visuals'],
            ['visualOffsetMs', 'Visual offset', 'shifts only the arrows'],
          ] as const
        ).map(([key, label, hint]) => (
          <label key={key} className="mb-2 flex items-center gap-4">
            <span className="w-28 text-sm text-muted">{label}</span>
            <input
              type="range"
              min={-150}
              max={150}
              step={1}
              value={settings[key]}
              onChange={(e) => update({ [key]: Number(e.target.value) } as Partial<Settings>)}
              className="flex-1 accent-[var(--color-accent)]"
            />
            <span className="w-20 text-right font-mono tabular-nums">
              {settings[key] > 0 ? '+' : ''}
              {settings[key]} ms
            </span>
            <span className="hidden w-40 text-xs text-muted sm:block">{hint}</span>
          </label>
        ))}
        <button
          onClick={onCalibrate}
          className="mt-2 rounded-lg border border-accent bg-accent/10 px-4 py-1.5 text-ink hover:bg-accent/20"
        >
          Auto-calibrate audio offset…
        </button>
      </Section>

      <Section title="Keys">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {COLS.map(({ i, label, glyph }) => (
            <div key={i} className="rounded-lg border border-line p-3">
              <div className="text-sm text-muted">
                {glyph} {label}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {keysFor(i).map((code) => (
                  <button
                    key={code}
                    onClick={() => clearKey(code)}
                    title="click to remove"
                    className="kbd hover:border-[#ff6b6b] hover:text-[#ff6b6b]"
                  >
                    {keyLabel(code)}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setRebinding(i)}
                className="mt-2 w-full rounded border border-line py-1 text-xs text-muted hover:border-accent hover:text-ink"
              >
                {rebinding === i ? 'press a key…' : '+ bind key'}
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={() => update({ keybindings: { ...DEFAULT_KEYBINDINGS } })}
          className="mt-3 rounded-lg border border-line px-4 py-1.5 text-sm text-muted hover:text-ink"
        >
          Reset keys to default
        </button>
        <p className="mt-2 text-xs text-muted">
          Add your pad's keys with “+ bind key”. For a gamepad/dance pad, plug it in and press a
          panel — buttons are auto-detected while playing.
        </p>
      </Section>
    </div>
  );
}
