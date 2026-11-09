import type { ReactNode } from 'react';

import { Nav } from '@/sections/nav';

/** The page frame of the catalog pages: the site nav over the page background. The pages lay out their own columns. */
export function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen overflow-x-clip bg-ground font-dm text-ink selection:bg-flag selection:text-white">
      <Nav />
      <main className="pt-4">{children}</main>
    </div>
  );
}
