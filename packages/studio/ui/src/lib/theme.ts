import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'kg.theme';

function read(): Theme {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // no storage
  }
  return 'dark';
}

/** Dark is the default; the choice is kept in the browser. The class is on `<html>`, set before first paint by index.html. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);
  const choose = useCallback((next: Theme) => {
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // the choice lasts until reload
    }
    setTheme(next);
  }, []);
  return [theme, choose];
}
