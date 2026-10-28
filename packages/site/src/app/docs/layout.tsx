import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

import cli from '../../../../cli/package.json';

import { GithubStars } from '@/components/github-stars';
import { repoCounts } from '@/lib/repo';
import { source } from '@/lib/source';
import { NPM } from '@/sections/links';
import { Wordmark } from '@/sections/shared';

export default async function Layout({ children }: { children: ReactNode }) {
  const counts = await repoCounts();
  return (
    <RootProvider theme={{ enabled: false }} search={{ options: { type: 'static', api: '/api/search' } }}>
      <DocsLayout
        tree={source.getPageTree()}
        nav={{
          title: <Wordmark className="text-[20px] text-ink" />,
          url: '/',
        }}
        sidebar={{
          footer: (
            <div className="flex flex-col gap-2">
              <a
                href={NPM}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between rounded-lg border bg-fd-secondary/50 px-3 py-2 text-sm text-fd-muted-foreground transition-colors hover:text-cobalt"
              >
                <span>npm i kinetograph</span>
                <span className="font-jb text-xs tabular-nums">v{cli.version}</span>
              </a>
              <GithubStars initial={counts} className="w-full rounded-lg border bg-fd-secondary/50 px-3 py-2 text-sm text-fd-muted-foreground" />
            </div>
          ),
        }}
        themeSwitch={{ enabled: false }}
        // Fumadocs centres the layout and stretches the sidebar over the left gutter, which leaves empty space beside
        // it on a wide screen. The same grid with no left gutter keeps the sidebar at the edge and the spare width on
        // the right.
        containerProps={{
          style: {
            gridTemplate: `"sidebar sidebar header toc toc"
"sidebar sidebar toc-popover toc toc"
"sidebar sidebar main toc toc" 1fr / 0px var(--fd-sidebar-col) minmax(0, calc(var(--fd-layout-width,97rem) - var(--fd-sidebar-width) - var(--fd-toc-width))) var(--fd-toc-width) minmax(min-content, 1fr)`,
          },
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
