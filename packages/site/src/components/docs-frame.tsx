import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type * as PageTree from 'fumadocs-core/page-tree';
import type { ReactNode } from 'react';

import cli from '../../../cli/package.json';

import { GithubStars } from '@/components/github-stars';
import { SearchPreload } from '@/components/search-preload';
import { repoCounts } from '@/lib/repo';
import { THEME } from '@/lib/theme';
import { NPM } from '@/sections/links';
import { Wordmark } from '@/sections/shared';

/**
 * The frame the docs and the catalog share: the same header (wordmark, Catalog and Docs links, search), the same sidebar and
 * the same content column, so moving between them changes only what is inside. `tree` is the sidebar's page tree; `banner`
 * goes above it (the catalog puts its categories there).
 */
export async function DocsFrame({ tree, banner, children }: { tree: PageTree.Root; banner?: ReactNode; children: ReactNode }) {
  const counts = await repoCounts();
  return (
    <RootProvider theme={THEME} search={{ options: { type: 'static', api: '/api/search', delayMs: 0 } }}>
      <SearchPreload api="/api/search" />
      <DocsLayout
        tree={tree}
        nav={{
          title: <Wordmark className="text-[20px] text-ink" />,
          url: '/',
        }}
        links={[
          { text: 'Catalog', url: '/catalog/', active: 'nested-url' },
          { text: 'Docs', url: '/docs/', active: 'nested-url' },
        ]}
        sidebar={{
          banner,
          footer: (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between rounded-lg border bg-fd-secondary/50 py-1.5 pr-1.5 pl-3 text-sm text-fd-muted-foreground">
                <span>Theme</span>
                <ThemeSwitch mode="light-dark-system" className="border-0 p-0" />
              </div>
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
        // Fumadocs centres the layout and stretches the sidebar over the left gutter, which leaves an empty strip
        // beside it on a wide screen. The same grid with no left gutter keeps the sidebar full width at the edge.
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
