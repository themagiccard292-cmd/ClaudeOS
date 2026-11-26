import { useEffect, useState } from 'react';
import type { ColorScheme, ThemePreference } from '../../shared/protocol';
import { api } from '../lib/api';

const STORAGE_KEY = 'claudeos.effectiveTheme';

function mediaScheme(): ColorScheme {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** OS colour scheme: the main process (nativeTheme) when available, `prefers-color-scheme` as the fallback. */
export function useSystemColorScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(mediaScheme);
  useEffect(() => {
    let alive = true;
    const offs: (() => void)[] = [];
    if (typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onMq = (e: MediaQueryListEvent) => setScheme(e.matches ? 'dark' : 'light');
      mq.addEventListener?.('change', onMq);
      offs.push(() => mq.removeEventListener?.('change', onMq));
    }
    const system = api().system;
    system
      .getColorScheme()
      .then((s) => alive && setScheme(s))
      .catch(() => undefined);
    offs.push(system.onColorScheme((s) => setScheme(s)));
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, []);
  return scheme;
}

export function resolveTheme(preference: ThemePreference, system: ColorScheme): ColorScheme {
  return preference === 'system' ? system : preference;
}

/** Applies the effective theme to <html data-theme> and remembers it for the no-flash boot script. */
export function useTheme(preference: ThemePreference): ColorScheme {
  const system = useSystemColorScheme();
  const effective = resolveTheme(preference, system);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effective);
    try {
      window.localStorage.setItem(STORAGE_KEY, effective);
    } catch {
      // Storage can be unavailable (private mode / sandbox); the boot script then falls back to the media query.
    }
  }, [effective]);
  return effective;
}
