import type { Viewport } from 'next';
import type { ReactNode } from 'react';

import { DocsFrame } from '@/components/docs-frame';
import { BrowseSeparator, CatalogBrowse } from '@/components/library/sidebar';
import { groups } from '@/lib/library';

export const viewport: Viewport = { themeColor: '#111113' };

/**
 * The catalog sits in the docs' frame: same header, sidebar and footer. Its sidebar holds one group, "Browse" (the categories),
 * under the Catalog and Docs links; its content column takes the whole width, since it has no table of contents.
 */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsFrame tree={{ name: 'Catalog', children: [{ type: 'separator', name: <CatalogBrowse groups={groups} /> }] }} components={{ Separator: BrowseSeparator }} wide>
      {children}
    </DocsFrame>
  );
}
