'use client';

import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';

import { CATEGORIES, COMPONENTS_BLURB, groupIds, items } from '@/lib/library';
import { cn } from '@/lib/utils';

/** The sidebar's entries: all, the whole-video kinds, then components with a sub-entry per kind. `id` '' is everything. */
const TOP = [
  { id: '', title: 'All', blurb: '' },
  ...CATEGORIES.filter((c) => !c.parent),
  { id: 'components', title: 'Components', blurb: COMPONENTS_BLURB },
];
const count = (id: string) => (id === '' ? items.length : items.filter((i) => groupIds(id).includes(i.group)).length);
const isOpen = (active: string) => active === 'components' || CATEGORIES.some((c) => c.id === active && c.parent);
const href = (id: string) => (id ? `/catalog/?c=${id}` : '/catalog/');

type Props = {
  /** The selected entry: '' for all, a category id, or `components`. */
  active: string;
  /** Called with an id when the page filters in place; without it the entries are plain links. */
  onSelect?: (id: string) => void;
};

function Entry({ id, title, blurb, active, onSelect, sub = false }: Props & { id: string; title: string; blurb: string; sub?: boolean }) {
  const on = active === id;
  const parent = id === 'components';
  const open = parent && isOpen(active);
  return (
    <a
      href={href(id)}
      onClick={(e) => {
        if (!onSelect) return;
        e.preventDefault();
        onSelect(id);
      }}
      aria-current={on ? 'page' : undefined}
      className={cn(
        'group block rounded-lg px-3 py-2 transition-colors',
        sub && 'ml-3 py-1.5',
        on ? 'bg-fd-accent text-fd-accent-foreground' : 'text-ink hover:bg-fd-accent/60',
      )}
    >
      <span className="flex items-center gap-2 text-[15px] font-medium">
        {title}
        {id !== '' && <span className="rounded-md bg-ink/10 px-1.5 font-jb text-[11px] font-normal text-mute">{count(id)}</span>}
        {parent && (open ? <ChevronDownIcon className="ml-auto size-3.5 text-mute" aria-hidden /> : <ChevronRightIcon className="ml-auto size-3.5 text-mute" aria-hidden />)}
      </span>
      {blurb && !sub && <span className="mt-0.5 block pl-0 text-[12.5px] leading-snug font-normal text-mute">{blurb}</span>}
    </a>
  );
}

/** The catalog's category list for wide screens: sticky, with its own scroll, so it stays beside the grid. */
export function Sidebar(props: Props) {
  const kinds = CATEGORIES.filter((c) => c.parent);
  const open = isOpen(props.active);
  return (
    <aside aria-label="Catalog categories" className="sticky top-6 hidden max-h-[calc(100vh-3rem)] w-64 shrink-0 self-start overflow-y-auto pr-2 lg:block">
      <nav className="space-y-0.5">
        {TOP.map((c) => (
          <div key={c.id}>
            <Entry {...props} {...c} />
            {c.id === 'components' && open && kinds.map((k) => <Entry key={k.id} {...props} id={k.id} title={k.title} blurb={k.blurb} sub />)}
          </div>
        ))}
      </nav>
      <a href="/plugins/" className="mt-4 block rounded-lg px-3 py-2 text-[15px] font-medium text-ink hover:bg-fd-accent/60">
        Plugins
        <span className="mt-0.5 block text-[12.5px] leading-snug font-normal text-mute">Looks and tools that extend Kinetograph.</span>
      </a>
    </aside>
  );
}

/** The same entries as one scrolling row of tabs for narrow screens, in the docs' tab style: an underline marks the open one. */
export function CategoryTabs(props: Props) {
  const tabs = [...TOP.filter((c) => c.id !== 'components'), ...CATEGORIES.filter((c) => c.parent)];
  return (
    <nav aria-label="Catalog categories" className="-mx-[clamp(20px,5vw,64px)] overflow-x-auto px-[clamp(20px,5vw,64px)] lg:hidden">
      <div className="flex w-max gap-1 border-b border-[var(--kg-box-border)]">
        {tabs.map((c) => (
          <a
            key={c.id}
            href={href(c.id)}
            onClick={(e) => {
              if (!props.onSelect) return;
              e.preventDefault();
              props.onSelect(c.id);
            }}
            aria-current={props.active === c.id ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
              props.active === c.id ? 'border-fd-primary text-fd-foreground' : 'border-transparent text-fd-muted-foreground hover:text-fd-foreground',
            )}
          >
            {c.title}
          </a>
        ))}
      </div>
    </nav>
  );
}
