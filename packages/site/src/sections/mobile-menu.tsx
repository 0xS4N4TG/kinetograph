'use client';

import { MenuIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { GithubStars } from '@/components/github-stars';
import { Sheet, SheetPanel, SheetPopup, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import type { RepoCounts } from '@/lib/repo';
import { Wordmark } from '@/sections/shared';

/** The phone nav: a hamburger that opens a right-hand sheet with the links, the GitHub link and any extra slot. */
export function MobileMenu({
  links,
  counts,
  extra,
}: {
  links: { href: string; label: string }[];
  counts?: RepoCounts;
  extra?: ReactNode;
}) {
  return (
    <Sheet>
      <SheetTrigger aria-label="Open menu" className="-me-2 inline-flex size-10 items-center justify-center text-ink transition-colors hover:text-cobalt">
        <MenuIcon className="size-5" />
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
          {extra && <div className="pt-2">{extra}</div>}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
