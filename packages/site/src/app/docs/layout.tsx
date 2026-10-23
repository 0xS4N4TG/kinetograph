import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

import { source } from '@/lib/source';
import { GITHUB } from '@/sections/links';
import { Wordmark } from '@/sections/shared';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ enabled: false }} search={{ options: { type: 'static', api: '/api/search' } }}>
      <DocsLayout
        tree={source.getPageTree()}
        nav={{
          title: <Wordmark className="text-[20px] text-ink" />,
          url: '/',
        }}
        githubUrl={GITHUB}
        themeSwitch={{ enabled: false }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
