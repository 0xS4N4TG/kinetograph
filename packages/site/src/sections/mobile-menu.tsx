'use client';

import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch';
import { SidebarIcon } from 'lucide-react';

import { GithubStars } from '@/components/github-stars';
import { Sheet, SheetPanel, SheetPopup, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import type { RepoCounts } from '@/lib/repo';
import { labelText, Wordmark } from '@/sections/shared';

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
      <SheetTrigger aria-label="Open menu" className="inline-flex size-9 items-center justify-center rounded-full text-ink transition-colors hover:text-cobalt">
        <SidebarIcon className="size-5" />
      </SheetTrigger>
      <SheetPopup side="right" className="bg-ground">
        <div className="flex h-20 items-center px-6">
          <SheetTitle render={<span />}>
            <Wordmark className="text-[24px] text-ink" />
          </SheetTitle>
        </div>
        <SheetPanel className="flex flex-col gap-1 pt-2">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className={`${labelText} border-b border-ink/10 py-5 text-[19px] text-ink transition-colors hover:text-cobalt`}
            >
              {l.label}
            </a>
          ))}
          <GithubStars initial={counts} className={`${labelText} py-5 text-[19px] text-ink`} />
        </SheetPanel>
        {/* Pinned to the bottom, as in the docs sidebar's footer. */}
        <div className="mt-auto px-6 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center justify-between rounded-full border border-ink/10 py-1.5 pr-1.5 pl-5 text-sm text-mute">
            <span>Theme</span>
            <ThemeSwitch mode="light-dark-system" className="border-0 p-0" />
          </div>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
