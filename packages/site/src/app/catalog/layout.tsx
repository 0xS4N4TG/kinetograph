import type { Viewport } from 'next';
import type { ReactNode } from 'react';

import { DocsFrame } from '@/components/docs-frame';
import { CatalogSidebar } from '@/components/library/sidebar';
import { groups } from '@/lib/library';

export const viewport: Viewport = { themeColor: '#111113' };

/** The catalog sits in the docs' frame: same header, sidebar and content column. Its sidebar holds the categories, not pages. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsFrame tree={{ name: 'Catalog', children: [] }} banner={<CatalogSidebar groups={groups} />}>
      {children}
    </DocsFrame>
  );
}
