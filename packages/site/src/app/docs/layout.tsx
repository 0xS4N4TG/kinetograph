import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Viewport } from 'next';
import type { ReactNode } from 'react';

import cli from '../../../../cli/package.json';

import { GithubStars } from '@/components/github-stars';
import { repoCounts } from '@/lib/repo';
import { THEME } from '@/lib/theme';
import { source } from '@/lib/source';
import { NPM } from '@/sections/links';
import { Wordmark } from '@/sections/shared';

export const viewport: Viewport = { themeColor: '#111113' };

export default async function Layout({ children }: { children: ReactNode }) {
  const counts = await repoCounts();
  return (
    <RootProvider theme={THEME} search={{ options: { type: 'static', api: '/api/search' } }}>
      <DocsLayout
        tree={source.getPageTree()}
        nav={{
          title: <Wordmark className="text-[20px] text-ink" />,
          url: '/',
        }}
        sidebar={{
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
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
