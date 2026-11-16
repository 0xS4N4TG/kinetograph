'use client';

import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';

import { CATEGORIES, groupIds } from '@/lib/library-core';
import { cn } from '@/lib/utils';

/** The entries: all, the whole-video kinds and plugins, then components with a sub-entry per kind. `id` '' is everything. */
const TOP = [{ id: '', title: 'All' }, ...CATEGORIES.filter((c) => !c.parent), { id: 'components', title: 'Components' }];
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

/** One row: the name on the left, the count on the right. The row's description is the page's job, not the sidebar's. */
function Entry({ id, title, active, count, sub = false }: { id: string; title: string; active: string; count: number; sub?: boolean }) {
  const on = active === id;
  return (
    <Link
      href={href(id)}
      aria-current={on ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-lg px-2 py-[7px] text-sm transition-colors',
        sub && 'ml-3',
        on ? 'bg-fd-primary/10 text-fd-primary' : 'text-fd-muted-foreground hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80',
      )}
    >
      {title}
      {id === 'components' && (isOpen(active) ? <ChevronDownIcon className="size-3.5" aria-hidden /> : <ChevronRightIcon className="size-3.5" aria-hidden />)}
      <span className={cn('ml-auto font-jb text-[11px] tabular-nums', on ? 'text-fd-primary' : 'text-mute')}>{count}</span>
    </Link>
  );
}

function Categories({ groups }: { groups: Record<string, string> }) {
  const active = useActive(groups);
  const values = Object.values(groups);
  const count = (id: string) => (id === '' ? values.length : values.filter((g) => groupIds(id).includes(g)).length);
  return (
    <nav aria-label="Catalog categories" className="space-y-0.5">
      {TOP.map((c) => (
        <div key={c.id}>
          <Entry {...c} active={active} count={count(c.id)} />
          {c.id === 'components' && isOpen(active) && CATEGORIES.filter((k) => k.parent).map((k) => <Entry key={k.id} id={k.id} title={k.title} active={active} count={count(k.id)} sub />)}
        </div>
      ))}
    </nav>
  );
}

/**
 * The catalog's "Browse" group in the shared docs sidebar: a small mono label, then the category list. The layout puts it in the
 * page tree as the name of one separator and `BrowseSeparator` draws that node as it is, so the group sits under the Catalog
 * and Docs links the way the docs' own groups do. `groups` maps an item's name to its category id.
 */
export function CatalogBrowse({ groups }: { groups: Record<string, string> }) {
  return (
    <>
      <p className="mb-1 px-2 font-jb text-[11px] tracking-[0.08em] text-mute uppercase">Browse</p>
      <Suspense fallback={null}>
        <Categories groups={groups} />
      </Suspense>
    </>
  );
}

/** The sidebar's separator for the catalog: the node's name is already the whole group. */
export function BrowseSeparator({ item }: { item: { name?: ReactNode } }) {
  return <>{item.name}</>;
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
