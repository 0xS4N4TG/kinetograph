import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

import { Mark } from '@/sections/nav';
import { source } from '@/lib/source';
import { GITHUB } from '@/sections/links';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ enabled: false }} search={{ options: { type: 'static', api: '/api/search/' } }}>
      <DocsLayout
        tree={source.getPageTree()}
        nav={{
          title: (
            <span className="flex items-center gap-2 font-serif text-[19px] text-cobalt">
              <Mark />
              Kinetograph
            </span>
          ),
          url: '/',
        }}
        githubUrl={GITHUB}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
