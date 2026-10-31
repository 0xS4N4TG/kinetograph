import type { Metadata } from 'next';

import { plugins, templates } from '@/lib/catalog';
import { CatalogPage, Draws, oneLine, Tile } from '@/sections/catalog';
import { Heading } from '@/sections/heading';
import { Label, body, link } from '@/sections/shared';

export const metadata: Metadata = {
  title: 'Plugins and templates | Kinetograph',
  description: 'Plugins and reel templates for Kinetograph: what each one draws and what you change.',
};

/** Plugins: two large tiles across from md up, one under. */
const pluginGrid = 'mt-6 grid grid-cols-1 gap-x-8 gap-y-14 md:grid-cols-2';
/** Templates: a wall of hero clips, each at its own aspect. From md up the portrait clip takes one column and the wide one two; one column under md, in this order. */
const templateGrid = 'mt-6 grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-3 md:items-start';
const templatePlace: Record<string, string> = {
  'word-flash': 'md:col-start-1',
  scrapline: 'md:col-span-2 md:col-start-2 md:row-start-1',
};
const order = ['scrapline', 'word-flash'];
const wall = [...templates].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

export default function PluginsPage() {
  return (
    <CatalogPage>
      <Heading as="h1" lines={['Plugins and templates']} hot="templates" tag="CAT 01  1.00" className="text-[clamp(36px,4.2vw,56px)]" />
      <p className={`${body} mt-5 max-w-[62ch]`}>Looks, captions and paper for your videos, and finished reels to start from.</p>
      <p className="mt-1 text-[14px] text-mute">Coming; not published yet.</p>

      <section className="mt-12" aria-labelledby="plugins">
        <div className="flex items-baseline justify-between">
          <Label>
            <span id="plugins">Plugins ({plugins.length})</span>
          </Label>
          <a href="#templates" className={`${link} kc-press inline-block font-jb text-[12px] tracking-[0.04em]`}>
            Templates
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

      <section className="mt-24 scroll-mt-8" aria-labelledby="templates">
        <Label>
          <span id="templates">Templates ({templates.length})</span>
        </Label>
        <ul className={templateGrid}>
          {wall.map((t, i) => (
            <Tile key={t.id} href={`/templates/${t.id}/`} title={t.title} clip={t.hero} index={i % 3} className={templatePlace[t.id]}>
              <p className="line-clamp-2 text-[15px] leading-[1.5] text-ink/75">{oneLine(t.description)}</p>
            </Tile>
          ))}
        </ul>
      </section>
    </CatalogPage>
  );
}
