'use client';

import { useEffect } from 'react';

/**
 * A page that sends the visitor on: a static export has no server redirects. It shows nothing. The meta refresh covers a
 * browser without scripts and goes to `to`. `hashes` sends an old in-page anchor (`#templates`) to its own address.
 */
export function Redirect({ to, hashes }: { to: string; hashes?: Record<string, string> }) {
  useEffect(() => {
    location.replace(hashes?.[location.hash.slice(1)] ?? to);
  }, [to, hashes]);
  return <meta httpEquiv="refresh" content={`0; url=${to}`} />;
}
