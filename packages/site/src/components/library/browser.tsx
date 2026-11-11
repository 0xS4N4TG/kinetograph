'use client';

import { ChevronDownIcon, PauseIcon, PlayIcon, SearchIcon } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ItemCard } from '@/components/library/card';
import { CategoryTabs } from '@/components/library/sidebar';
import { CATEGORIES, groupIds, search, type Item } from '@/lib/library-core';
import { cn } from '@/lib/utils';
import { Heading } from '@/sections/heading';

/** How many cards of a category show before "Show all": two rows of four on a wide screen. */
const FIRST = 8;

const pill = 'inline-flex items-center gap-2 rounded-full border border-[var(--kg-box-border)] bg-fd-card px-4 py-2 text-sm text-ink transition-colors hover:border-fd-primary';

/** The width of the intro line and the search field: one measure, so the two share a right edge. */
const MEASURE = 'max-w-[40rem]';

/**
 * The catalog: a heading, a search row and a grid of previews, all on one left edge. The grid has one section per category,
 * each cut to its first two rows with a "Show all" toggle. Picking a category shows just it, in full. A search replaces the
 * sections with one list of matches. The choice lives in the address (`?c=<category>`), which is how the old /templates,
 * /components and /tastes pages land here.
 */
export function Browser({ items, groups }: { items: Item[]; groups: Record<string, string> }) {
  const active = useSearchParams().get('c') ?? '';
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    setPaused(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  const scope = active ? items.filter((i) => groupIds(active).includes(i.group)) : items;
  const found = search(scope, query);
  const sections = CATEGORIES.map((c) => ({ ...c, list: found.filter((i) => i.group === c.id) })).filter((s) => s.list.length > 0);
  const toggle = (id: string) => setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
  const grid = 'grid grid-cols-1 gap-x-6 gap-y-8 min-[480px]:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]';

  return (
    <>
      <CategoryTabs groups={groups} />
      <header className="pt-6 md:pt-0">
        <Heading as="h1" lines={['Motion ready to add.']} hot="Motion" animate className="-ml-[0.08em] text-[clamp(36px,5vw,56px)] leading-[1.05]" />
        <p className={cn('mt-4 font-dm text-[17px] leading-[1.6] text-ink/75', MEASURE)}>
          Find a template, a component or a taste for your next video. Watch it play, then add it with one command and make it yours.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className={cn('relative w-full sm:flex-1', MEASURE)}>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-mute" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${scope.length} items`}
              aria-label="Search the catalog"
              className="h-11 w-full rounded-full border border-[var(--kg-box-border)] bg-fd-card pr-4 pl-11 text-[15px] text-ink outline-none placeholder:text-mute focus-visible:border-fd-primary"
            />
          </div>
          <div className="flex w-full items-center justify-between gap-4 sm:ml-auto sm:w-auto">
            <p role="status" className="font-jb text-[12px] text-mute tabular-nums">
              {found.length} {found.length === 1 ? 'item' : 'items'}
            </p>
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              aria-pressed={paused}
              className="inline-flex h-11 items-center gap-2 rounded-full px-3 text-sm text-mute transition-colors hover:bg-fd-accent/50 hover:text-ink"
            >
              {paused ? <PlayIcon className="size-3.5" aria-hidden /> : <PauseIcon className="size-3.5" aria-hidden />}
              {paused ? 'Play previews' : 'Pause previews'}
            </button>
          </div>
        </div>
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
            <ul className={grid}>
              {found.map((i) => (
                <ItemCard key={i.name} item={i} paused={paused} meta />
              ))}
            </ul>
          </section>
        ) : (
          sections.map((s) => {
            const full = active !== '' || open.includes(s.id);
            const shown = full ? s.list : s.list.slice(0, FIRST);
            return (
              <section key={s.id} aria-labelledby={`cat-${s.id}`} className="mb-12">
                <div className="mb-6 flex items-end justify-between gap-6">
                  <div className="min-w-0">
                    <h2 id={`cat-${s.id}`} className="font-dm text-[26px] leading-tight font-bold tracking-[-0.03em] text-ink">
                      {s.title}
                    </h2>
                    <p className="mt-1 text-[14px] text-mute">{s.blurb}</p>
                  </div>
                  {active === '' && s.list.length > FIRST && (
                    <button type="button" onClick={() => toggle(s.id)} aria-expanded={full} className="inline-flex shrink-0 items-center gap-1 text-sm text-mute transition-colors hover:text-ink">
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
    </>
  );
}
