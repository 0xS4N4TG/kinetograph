'use client';

import { useEffect } from 'react';

/**
 * Loads the search index while the browser is idle, so the first search in the dialog is instant. The dialog's static
 * client caches the index by its URL, so this warms the same copy it reads.
 */
export function SearchPreload({ api }: { api: string }) {
  useEffect(() => {
    let cancelled = false;
    const warm = () => {
      if (cancelled) return;
      void import('fumadocs-core/search/client/orama-static')
        .then((mod) => mod.staticClient({ from: api }).search('kinetograph'))
        .catch(() => {});
    };
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 200));
    const id = idle(warm);
    return () => {
      cancelled = true;
      if (window.cancelIdleCallback && typeof id === 'number') window.cancelIdleCallback(id);
    };
  }, [api]);
  return null;
}
