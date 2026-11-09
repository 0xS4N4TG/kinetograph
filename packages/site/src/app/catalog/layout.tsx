import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Viewport } from 'next';
import type { ReactNode } from 'react';

import { THEME } from '@/lib/theme';

export const viewport: Viewport = { themeColor: '#111113' };

/** The catalog pages share the docs' theme: dark by default, with the toggle in the nav. No search dialog here. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={THEME} search={{ enabled: false }}>
      {children}
    </RootProvider>
  );
}
