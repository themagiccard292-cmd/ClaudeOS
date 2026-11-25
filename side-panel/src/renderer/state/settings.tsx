import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_SETTINGS, type PanelSettings } from '../../shared/protocol';
import { api } from '../lib/api';

interface SettingsContextValue {
  settings: PanelSettings;
  /** Optimistic update, then reconciled with what the main process stored. */
  update: (patch: Partial<PanelSettings>) => Promise<void>;
  loaded: boolean;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PanelSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    api()
      .settings.get()
      .then((s) => {
        if (!alive) return;
        setSettings(s);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    const off = api().settings.onChange((s) => setSettings(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const update = useCallback(async (patch: Partial<PanelSettings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    const stored = await api().settings.set(patch);
    setSettings(stored);
  }, []);

  const value = useMemo(() => ({ settings, update, loaded }), [settings, update, loaded]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>');
  return ctx;
}
