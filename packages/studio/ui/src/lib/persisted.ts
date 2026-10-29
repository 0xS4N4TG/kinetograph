import { useCallback, useState } from 'react';

/** A number kept in the browser (panel sizes): `[value, set]`; storage that is not there leaves it for the session. */
export function usePersistedNumber(key: string, fallback: number): [number, (value: number) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(key));
      return Number.isFinite(stored) && stored > 0 ? stored : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: number) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, String(Math.round(next)));
      } catch {
        // the size lasts until reload
      }
    },
    [key],
  );
  return [value, set];
}
