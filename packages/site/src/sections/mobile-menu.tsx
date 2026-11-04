'use client';

import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch';
import { SidebarIcon } from 'lucide-react';

import { GithubStars } from '@/components/github-stars';
import { Sheet, SheetPanel, SheetPopup, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import type { RepoCounts } from '@/lib/repo';
import { Wordmark } from '@/sections/shared';

/** The phone nav: the docs' sidebar icon opens a right-hand sheet with the links, the GitHub link and the theme switch. */
export function MobileMenu({
  links,
  counts,
}: {
  links: { href: string; label: string }[];
  counts?: RepoCounts;
}) {
  return (
    <Sheet>
      <SheetTrigger aria-label="Open menu" className="-me-2 inline-flex size-10 items-center justify-center text-ink transition-colors hover:text-cobalt">
        <SidebarIcon className="size-5" />
      </SheetTrigger>
      <SheetPopup side="right" className="bg-ground">
        <div className="flex h-20 items-center px-6">
          <SheetTitle render={<span />}>
            <Wordmark className="text-[22px] text-ink" />
          </SheetTitle>
        </div>
        <SheetPanel className="flex flex-col gap-1 pt-2">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="border-b border-ink/10 py-4 font-jb text-[13px] font-medium tracking-[0.24em] text-ink uppercase transition-colors hover:text-cobalt"
            >
              {l.label}
            </a>
          ))}
          <GithubStars initial={counts} className="py-4 font-jb text-[13px] font-medium tracking-[0.24em] text-ink uppercase" />
          <div className="mt-2 flex items-center justify-between rounded-lg border border-ink/10 py-1.5 pr-1.5 pl-3 text-sm text-mute">
            <span>Theme</span>
            <ThemeSwitch mode="light-dark-system" className="border-0 p-0" />
          </div>
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
