import type { Metadata } from 'next';

import { KINDS, plugins, components, tastes } from '@/lib/catalog';
import { CatalogPage, Draws, oneLine, Tile } from '@/sections/catalog';
import { Heading } from '@/sections/heading';
import { Label, body, link } from '@/sections/shared';

export const metadata: Metadata = {
  title: 'Plugins and components | Kinetograph',
  description: 'Plugins and components for Kinetograph: what each one makes and what you can change.',
};

/** Plugins: two large tiles across from md up, one under. */
const pluginGrid = 'mt-6 grid grid-cols-1 gap-x-8 gap-y-14 md:grid-cols-2';
/**
 * Components are grouped: the first seven (the scenes, with no category) are a wall of hero clips, each at its own
 * aspect, three columns from md up and one under, in `order`. Seven tiles: the portrait Word Flash spans the first two
 * rows of column 1; four wide clips fill the two columns beside it; the last row is one wide clip and Scrapline across
 * two columns. The two rows beside the portrait are about as tall as it is, so only the bottom of the wall is ragged.
 * Each kind (Grids, Carousels, ...) follows under a small heading as a plain three-column grid of 16:9 clips.
 */
const componentGrid = 'mt-6 grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-3 md:items-start';
const componentPlace: Record<string, string> = {
  'word-flash': 'md:col-start-1 md:row-span-2 md:row-start-1',
  'collage-burst': 'md:col-start-2 md:row-start-1',
  'greeting-intro': 'md:col-start-3 md:row-start-1',
  'wait-ship': 'md:col-start-2 md:row-start-2',
  'prompt-reply': 'md:col-start-3 md:row-start-2',
  'phone-orbit': 'md:col-start-1 md:row-start-3',
  scrapline: 'md:col-span-2 md:col-start-2 md:row-start-3',
};
const order = ['scrapline', 'word-flash', 'collage-burst', 'greeting-intro', 'wait-ship', 'prompt-reply', 'phone-orbit'];
const scenes = components.filter((c) => !c.category).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const groups = [
  { id: 'scenes', title: 'Scenes', items: scenes },
  ...KINDS.map((k) => ({ id: k.id, title: k.title, items: components.filter((c) => c.category === k.id) })),
].filter((g) => g.items.length > 0);
/** The tastes follow the components as one more group; their clips are portrait, so the cards are narrower. */
const tasteGrid = 'mt-6 grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-3 md:items-start';

export default function PluginsPage() {
  return (
    <CatalogPage>
      <Heading as="h1" lines={['Plugins and components']} hot="components" tag="CAT 01  1.00" className="text-[clamp(36px,4.2vw,56px)]" />
      <p className={`${body} mt-5 max-w-[62ch]`}>Plugins add looks, captions, paper and tracking to a project. Components are finished videos you start from and change.</p>
      <p className="mt-1 text-[14px] text-mute">Coming; not published yet.</p>

      <section className="mt-12" aria-labelledby="plugins">
        <div className="flex items-baseline justify-between">
          <Label>
            <span id="plugins">Plugins ({plugins.length})</span>
          </Label>
          <a href="#components" className={`${link} kc-press inline-block font-jb text-[12px] tracking-[0.04em]`}>
            Components
          </a>
        </div>
        <ul className={pluginGrid}>
          {plugins.map((p, i) => (
            <Tile key={p.slug} href={`/plugins/${p.slug}/`} title={p.title} clip={p.hero} fixed index={i % 2}>
              <p className={`${body} line-clamp-2`}>{oneLine(p.description)}</p>
              <Draws names={p.components} />
            </Tile>
          ))}
        </ul>
      </section>

      <section className="mt-24 scroll-mt-8" aria-labelledby="components">
        <div className="flex items-baseline justify-between">
          <Label>
            <span id="components">Components ({components.length})</span>
          </Label>
          <nav aria-label="Component kinds" className="hidden gap-4 font-jb text-[12px] tracking-[0.04em] md:flex">
            {groups.map((g) => (
              <a key={g.id} href={`#kind-${g.id}`} className={`${link} kc-press inline-block`}>
                {g.title}
              </a>
            ))}
            {tastes.length > 0 && (
              <a href="#kind-tastes" className={`${link} kc-press inline-block`}>
                Tastes
              </a>
            )}
          </nav>
        </div>
        {groups.map((g, n) => (
          <div key={g.id} className={n === 0 ? 'mt-8' : 'mt-16'}>
            <h3 id={`kind-${g.id}`} className="scroll-mt-8 border-b border-ink/15 pb-2 font-dm text-[22px] leading-tight font-bold tracking-[-0.03em] text-ink">
              {g.title} <span className="font-jb text-[12px] font-medium tracking-[0.04em] text-mute">({g.items.length})</span>
            </h3>
            <ul className={componentGrid}>
              {g.items.map((t, i) => (
                <Tile key={t.id} href={`/components/${t.id}/`} title={t.title} clip={t.hero} index={i % 3} className={g.id === 'scenes' ? componentPlace[t.id] : undefined}>
                  <p className="line-clamp-2 text-[15px] leading-[1.5] text-ink/75">{oneLine(t.description)}</p>
                </Tile>
              ))}
            </ul>
          </div>
        ))}
        {tastes.length > 0 && (
          <div className="mt-16">
            <h3 id="kind-tastes" className="scroll-mt-8 border-b border-ink/15 pb-2 font-dm text-[22px] leading-tight font-bold tracking-[-0.03em] text-ink">
              Tastes <span className="font-jb text-[12px] font-medium tracking-[0.04em] text-mute">({tastes.length})</span>
            </h3>
            <p className="mt-3 max-w-[62ch] text-[15px] leading-[1.5] text-ink/75">A taste is a whole style for a video: its colours, type, motion and cuts.</p>
            <ul className={tasteGrid}>
              {tastes.map((t, i) => (
                <Tile key={t.id} href={`/tastes/${t.id}/`} title={t.title} clip={t.hero} index={i % 3} className="md:max-w-[19rem]">
                  <p className="line-clamp-3 text-[15px] leading-[1.5] text-ink/75">{oneLine(t.description)}</p>
                </Tile>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-16 text-[14px] text-mute">Photos: NASA, public domain.</p>
      </section>
    </CatalogPage>
  );
}
