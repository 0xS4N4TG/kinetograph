import type { Metadata } from 'next';

import { plugins } from '@/lib/catalog';
import { CatalogPage, Draws, oneLine, Tile } from '@/sections/catalog';
import { Heading } from '@/sections/heading';
import { body, link } from '@/sections/shared';

export const metadata: Metadata = {
  title: 'Plugins | Kinetograph',
  description: 'Plugins add looks, captions, paper and tracking to Kinetograph: what each one makes and how to install it.',
};

/** Plugins: two large tiles across from md up, one under. */
const pluginGrid = 'mt-10 grid grid-cols-1 gap-x-8 gap-y-14 md:grid-cols-2';

export default function PluginsPage() {
  return (
    <CatalogPage>
      <Heading as="h1" lines={['Plugins']} hot="plugins" tag="CAT 01  1.00" className="text-[clamp(36px,4.2vw,56px)]" />
      <p className={`${body} mt-5 max-w-[62ch]`}>
        Plugins add looks, captions, paper and tracking. Install one from npm with{' '}
        <code className="font-jb text-[13px]">npm install @kinetographdev/&lt;name&gt;</code>. Looking for a template, a component or a taste? See the{' '}
        <a href="/catalog/" className={link}>catalog</a>.
      </p>

      <section aria-labelledby="plugins">
        <h2 id="plugins" className="sr-only">
          Plugins ({plugins.length})
        </h2>
        <ul className={pluginGrid}>
          {plugins.map((p, i) => (
            <Tile key={p.slug} href={`/plugins/${p.slug}/`} title={p.title} clip={p.hero} fixed index={i % 2}>
              <p className={`${body} line-clamp-2`}>{oneLine(p.description)}</p>
              <Draws names={p.components} />
            </Tile>
          ))}
        </ul>
      </section>
    </CatalogPage>
  );
}
