import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { loadSettings, normalizeSettings, saveSettings, type Settings } from '../app/settings';
import { setControlBindings } from '../input/inputBus';

interface SettingsCtx {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

const Ctx = createContext<SettingsCtx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => {
    const s = loadSettings();
    // Synchronously, so the input bus resolves with the persisted bindings
    // before any child screen subscribes.
    setControlBindings(s.bindings);
    return s;
  });

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = normalizeSettings({ ...prev, ...patch });
      saveSettings(next);
      setControlBindings(next.bindings);
      return next;
    });
  }, []);

  return <Ctx.Provider value={{ settings, update }}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSettings must be used within <SettingsProvider>');
  return c;
}
