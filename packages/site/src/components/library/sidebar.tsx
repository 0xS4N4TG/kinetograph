'use client';

import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { CATEGORIES, COMPONENTS_BLURB, groupIds } from '@/lib/library-core';
import { cn } from '@/lib/utils';

/** The entries: all, the whole-video kinds and plugins, then components with a sub-entry per kind. `id` '' is everything. */
const TOP = [{ id: '', title: 'All', blurb: '' }, ...CATEGORIES.filter((c) => !c.parent), { id: 'components', title: 'Components', blurb: COMPONENTS_BLURB }];
const href = (id: string) => (id ? `/catalog/?c=${id}` : '/catalog/');
const isOpen = (active: string) => active === 'components' || CATEGORIES.some((c) => c.id === active && c.parent);

/**
 * The selected entry: on an item's page its category, otherwise the `?c=` of the address ('' for all). `groups` maps an item's
 * name to its category id.
 */
function useActive(groups: Record<string, string>) {
  const pathname = usePathname();
  const c = useSearchParams().get('c') ?? '';
  const name = pathname.match(/^\/catalog\/([^/]+)\/?$/)?.[1];
  return name ? (groups[name] ?? '') : c;
}

function Entry({ id, title, blurb, active, count, sub = false }: { id: string; title: string; blurb: string; active: string; count: number; sub?: boolean }) {
  const on = active === id;
  const parent = id === 'components';
  return (
    <Link
      href={href(id)}
      aria-current={on ? 'page' : undefined}
      className={cn(
        'block rounded-lg px-2.5 py-1.5 text-sm transition-colors',
        sub && 'ml-3',
        on ? 'bg-fd-primary/10 font-medium text-fd-primary' : 'text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-accent-foreground',
      )}
    >
      <span className="flex items-center gap-2">
        {title}
        {id !== '' && <span className="rounded-md bg-fd-muted px-1.5 font-jb text-[11px] font-normal text-fd-muted-foreground">{count}</span>}
        {parent && (isOpen(active) ? <ChevronDownIcon className="ml-auto size-3.5" aria-hidden /> : <ChevronRightIcon className="ml-auto size-3.5" aria-hidden />)}
      </span>
      {blurb && !sub && <span className="mt-0.5 block text-xs leading-snug font-normal text-fd-muted-foreground">{blurb}</span>}
    </Link>
  );
}

function Categories({ groups }: { groups: Record<string, string> }) {
  const active = useActive(groups);
  const values = Object.values(groups);
  const count = (id: string) => (id === '' ? values.length : values.filter((g) => groupIds(id).includes(g)).length);
  return (
    <nav aria-label="Catalog categories" className="mb-2 space-y-0.5">
      {TOP.map((c) => (
        <div key={c.id}>
          <Entry {...c} active={active} count={count(c.id)} />
          {c.id === 'components' && isOpen(active) && CATEGORIES.filter((k) => k.parent).map((k) => <Entry key={k.id} {...k} active={active} count={count(k.id)} sub />)}
        </div>
      ))}
    </nav>
  );
}

/** The catalog's category list, shown at the top of the shared docs sidebar. */
export function CatalogSidebar({ groups }: { groups: Record<string, string> }) {
  return (
    <Suspense fallback={null}>
      <Categories groups={groups} />
    </Suspense>
  );
}

/** The same entries as one scrolling row of tabs on a narrow screen, in the docs' tab style: an underline marks the open one. */
function Tabs({ groups }: { groups: Record<string, string> }) {
  const active = useActive(groups);
  const tabs = [...TOP.filter((c) => c.id !== 'components'), ...CATEGORIES.filter((c) => c.parent)];
  return (
    <nav aria-label="Catalog categories" className="overflow-x-auto md:hidden">
      <div className="flex w-max gap-1 border-b border-[var(--kg-box-border)]">
        {tabs.map((c) => (
          <Link
            key={c.id}
            href={href(c.id)}
            aria-current={active === c.id ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
              active === c.id ? 'border-fd-primary text-fd-foreground' : 'border-transparent text-fd-muted-foreground hover:text-fd-foreground',
            )}
          >
            {c.title}
          </Link>
        ))}
      </div>
    </nav>
  );
}

export function CategoryTabs({ groups }: { groups: Record<string, string> }) {
  return (
    <Suspense fallback={null}>
      <Tabs groups={groups} />
    </Suspense>
  );
}
