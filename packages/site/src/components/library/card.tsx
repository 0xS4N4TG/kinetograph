import Link from 'next/link';

import { Preview } from '@/components/library/preview';
import { categoryOf, type Item } from '@/lib/library-core';

/** The type pill under a card's title and on an item page. */
export function TypeBadge({ type }: { type: Item['type'] }) {
  return <span className="shrink-0 rounded-full bg-fd-accent px-2.5 py-0.5 font-jb text-[11px] tracking-[0.04em] text-fd-accent-foreground">{type}</span>;
}

/** A tile of the catalog: the preview, then the name with its type, then the category. The whole card is the link. */
export function ItemCard({ item, paused = false }: { item: Item; paused?: boolean }) {
  return (
    <li>
      <Link href={`/catalog/${item.name}/`} className="kc-press group block rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cobalt">
        <div className="aspect-[16/10] overflow-hidden rounded-2xl border border-[var(--kg-box-border)] bg-night transition-colors group-hover:border-fd-primary">
          <Preview name={item.name} poster={item.poster} ratio={item.ratio} paused={paused} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 px-1">
          <h3 className="min-w-0 truncate font-dm text-[16px] font-medium text-ink">{item.title}</h3>
          <TypeBadge type={item.type} />
        </div>
        <p className="mt-0.5 px-1 font-jb text-[12px] text-mute">{categoryOf(item).title.toLowerCase()}</p>
      </Link>
    </li>
  );
}
