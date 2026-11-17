'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { useMediaQuery } from '@/hooks/use-media-query';
import { cn } from '@/lib/utils';

const pill =
  'kg-pill pointer-events-auto rounded-full border border-foreground/10 bg-background/60 shadow-[inset_0_1px_0_rgb(255_255_255/0.1)] backdrop-blur-xl';

/**
 * The floating glass pill. Over the hero it is the roomy one (links, star counts, theme). Once the hero has scrolled
 * away it slides up and out while a smaller pill slides down in its place; the phone only ever shows the small one.
 * The pill that is out of play is inert.
 */
export function NavShell({ full, compact }: { full: ReactNode; compact: ReactNode }) {
  const [past, setPast] = useState(false);
  const desktop = useMediaQuery('(min-width: 768px)');

  useEffect(() => {
    const hero = document.getElementById('hero');
    if (!hero) return;
    const io = new IntersectionObserver(([e]) => setPast(!e.isIntersecting && e.boundingClientRect.top < 0), { rootMargin: '-120px 0px 0px 0px' });
    io.observe(hero);
    return () => io.disconnect();
  }, []);

  return (
    <header data-past={past ? '' : undefined} className="group/nav pointer-events-none fixed inset-x-0 top-4 z-40 flex justify-center px-4">
      <div
        inert={past || !desktop}
        className={cn(pill, 'max-md:hidden group-data-[past]/nav:-translate-y-[190%] group-data-[past]/nav:opacity-0')}
      >
        {full}
      </div>
      <div
        inert={desktop && !past}
        className={cn(pill, 'max-md:relative md:absolute md:top-0 md:-translate-y-[190%] md:opacity-0 md:group-data-[past]/nav:translate-y-0 md:group-data-[past]/nav:opacity-100')}
      >
        {compact}
      </div>
    </header>
  );
}
