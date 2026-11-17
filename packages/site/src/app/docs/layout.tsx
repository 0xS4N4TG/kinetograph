import type { Viewport } from 'next';
import type { ReactNode } from 'react';

import { DocsFrame } from '@/components/docs-frame';
import { source } from '@/lib/source';

export const viewport: Viewport = { themeColor: '#111113' };

export default function Layout({ children }: { children: ReactNode }) {
  return <DocsFrame tree={source.getPageTree()}>{children}</DocsFrame>;
}
