'use client';

import { ChevronDownIcon, PauseIcon, PlayIcon, SearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ItemCard } from '@/components/library/card';
import { CategoryTabs, Sidebar } from '@/components/library/sidebar';
import { CATEGORIES, groupIds, items, search } from '@/lib/library';
import { cn } from '@/lib/utils';
import { shell } from '@/sections/shared';

/** How many cards of a category show before "Show all": two rows of three. */
const FIRST = 6;

const pill = 'inline-flex items-center gap-2 rounded-full border border-[var(--kg-box-border)] bg-fd-card px-4 py-2 text-sm text-ink transition-colors hover:border-fd-primary';

/**
 * The catalog: a category list beside a grid of previews. The grid has one section per category, each cut to its first
 * two rows with a "Show all" toggle. Picking a category shows just it, in full. A search replaces the sections with one
 * list of matches. The choice lives in the address (`?c=<category>`), which is how the old /templates, /components and
 * /tastes pages land here.
 */
export function Browser() {
  const [active, setActive] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    setActive(new URLSearchParams(location.search).get('c') ?? '');
    setPaused(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  const select = (id: string) => {
    setActive(id);
    history.replaceState(null, '', id ? `?c=${id}` : location.pathname);
    window.scrollTo({ top: 0 });
  };

  const scope = active ? items.filter((i) => groupIds(active).includes(i.group)) : items;
  const found = search(scope, query);
  const sections = CATEGORIES.map((c) => ({ ...c, list: found.filter((i) => i.group === c.id) })).filter((s) => s.list.length > 0);
  const toggle = (id: string) => setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
  const grid = 'grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 xl:grid-cols-3';

  return (
    <div className={`${shell} flex gap-10 pb-[clamp(64px,9vw,128px)]`}>
      <Sidebar active={active} onSelect={select} />
      <div className="min-w-0 flex-1">
        <CategoryTabs active={active} onSelect={select} />
        <header className="pt-8 lg:pt-12">
          <h1 className="font-dm text-[clamp(40px,6vw,72px)] leading-[1.05] font-bold tracking-[-0.045em] text-ink">
            <span className="bg-gradient-to-r from-cobalt to-flag bg-clip-text text-transparent">Motion</span> ready to add.
          </h1>
          <p className="mt-5 max-w-[56ch] font-dm text-[17px] leading-[1.6] text-ink/75">
            Find a template, a component or a taste for your next video. Watch it play, then add it with one command and make it yours.
          </p>
          <div className="relative mt-8 max-w-xl">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-mute" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${items.length} items: charts, backgrounds, launch films...`}
              aria-label="Search the catalog"
              className="h-12 w-full rounded-full border border-[var(--kg-box-border)] bg-fd-card pr-4 pl-11 text-[15px] text-ink outline-none placeholder:text-mute focus-visible:border-fd-primary"
            />
          </div>
          <button type="button" onClick={() => setPaused((p) => !p)} aria-pressed={paused} className={cn(pill, 'mt-4')}>
            {paused ? <PlayIcon className="size-3.5" aria-hidden /> : <PauseIcon className="size-3.5" aria-hidden />}
            {paused ? 'Play previews' : 'Pause previews'}
          </button>
        </header>

        <div className="mt-12">
          {found.length === 0 ? (
            <div role="status" className="rounded-2xl border border-dashed border-[var(--kg-box-border)] px-6 py-16 text-center">
              <p className="font-dm text-xl font-medium text-ink">Nothing matches &ldquo;{query}&rdquo;.</p>
              <p className="mt-2 text-[15px] text-mute">Try a shorter word, such as chart, grid or film.</p>
              <button type="button" onClick={() => setQuery('')} className={cn(pill, 'mt-6')}>
                Clear search
              </button>
            </div>
          ) : query ? (
            <section aria-label="Search results">
              <p className="mb-6 font-jb text-[12px] text-mute">
                {found.length} {found.length === 1 ? 'result' : 'results'}
              </p>
              <ul className={grid}>
                {found.map((i) => (
                  <ItemCard key={i.name} item={i} paused={paused} />
                ))}
              </ul>
            </section>
          ) : (
            sections.map((s) => {
              const full = active !== '' || open.includes(s.id);
              const shown = full ? s.list : s.list.slice(0, FIRST);
              return (
                <section key={s.id} aria-labelledby={`cat-${s.id}`} className="mb-14">
                  <div className="mb-6 flex items-baseline justify-between gap-4">
                    <h2 id={`cat-${s.id}`} className="font-dm text-[26px] font-bold tracking-[-0.03em] text-ink">
                      {s.title}
                    </h2>
                    {active === '' && s.list.length > FIRST && (
                      <button type="button" onClick={() => toggle(s.id)} aria-expanded={full} className="inline-flex items-center gap-1 text-sm text-mute transition-colors hover:text-ink">
                        {full ? 'Show fewer' : `Show all ${s.list.length}`}
                        <ChevronDownIcon className={cn('size-4 transition-transform', full && 'rotate-180')} aria-hidden />
                      </button>
                    )}
                  </div>
                  <ul className={grid}>
                    {shown.map((i) => (
                      <ItemCard key={i.name} item={i} paused={paused} />
                    ))}
                  </ul>
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
