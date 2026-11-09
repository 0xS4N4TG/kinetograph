'use client';

import { useEffect } from 'react';

/**
 * A page that sends the visitor on: a static export has no server redirects. It shows nothing. The meta refresh covers a
 * browser without scripts and goes to the same address.
 */
export function Redirect({ to }: { to: string }) {
  useEffect(() => {
    location.replace(to);
  }, [to]);
  return <meta httpEquiv="refresh" content={`0; url=${to}`} />;
}
