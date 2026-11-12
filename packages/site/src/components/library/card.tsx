import Link from 'next/link';

import { Preview } from '@/components/library/preview';
import { categoryOf, type Item } from '@/lib/library-core';

/** The type pill by an item page's title. */
export function TypeBadge({ type }: { type: Item['type'] }) {
  return <span className="shrink-0 rounded-full bg-fd-accent px-2.5 py-0.5 font-jb text-[11px] tracking-[0.04em] text-fd-accent-foreground">{type}</span>;
}

/**
 * A tile of the catalog: a 16:9 preview, then the title (it wraps to two lines, never cut). The whole card is the link. Inside a
 * category section the type is known, so a card says nothing more; `meta` adds the category, for a list that mixes them (search
 * results, "More like this").
 */
export function ItemCard({ item, paused = false, meta = false }: { item: Item; paused?: boolean; meta?: boolean }) {
  return (
    <li>
      <Link href={`/catalog/${item.name}/`} className="kc-press group block rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cobalt">
        <div className="aspect-video overflow-hidden rounded-2xl border border-[var(--kg-box-border)] bg-fd-muted transition-colors group-hover:border-fd-primary">
          <Preview name={item.name} poster={item.poster} ratio={item.ratio} paused={paused} />
        </div>
        <h3 className="mt-3 line-clamp-2 px-1 font-dm text-[16px] leading-snug font-medium text-ink">{item.title}</h3>
        {meta && <p className="mt-1 px-1 font-jb text-[12px] text-mute">{categoryOf(item).title.toLowerCase()}</p>}
      </Link>
    </li>
  );
}
