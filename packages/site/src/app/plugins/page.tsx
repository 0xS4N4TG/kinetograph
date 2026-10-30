import type { Metadata } from 'next';

import { plugins, templates } from '@/lib/catalog';
import { Badges, Card, CatalogPage, Draws } from '@/sections/catalog';
import { Heading } from '@/sections/heading';
import { Label, body } from '@/sections/shared';

export const metadata: Metadata = {
  title: 'Plugins and templates | Kinetograph',
  description: 'Plugins and reel templates for Kinetograph: what each one draws and what you change.',
};

/** Plugins: two columns from md up, one under. */
const pluginGrid = 'mt-6 grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-2';
/** Templates: twelve columns from md up, one under. Five cards span 7+5 then 4+4+4, so no cell is empty. */
const templateGrid = 'mt-6 grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-12';
const templateSpan = ['md:col-span-7', 'md:col-span-5', 'md:col-span-4', 'md:col-span-4', 'md:col-span-4'];

export default function PluginsPage() {
  return (
    <CatalogPage>
      <Heading as="h1" lines={['Plugins and templates']} hot="templates" tag="CAT 01  1.00" className="text-[clamp(36px,4.2vw,56px)]" />
      <p className={`${body} mt-6 max-w-[62ch]`}>
        Plugins add new things to draw: looks for your footage, handwritten captions, paper cut-outs. Most come with a panel
        in Studio, and every one comes with a skill, so an agent can use it on its own. Templates are finished videos you start
        a project from and make your own. Both are coming; none is published yet.
      </p>

      <section className="mt-16" aria-labelledby="plugins">
        <Label>
          <span id="plugins">Plugins ({plugins.length})</span>
        </Label>
        <ul className={pluginGrid}>
          {plugins.map((p) => (
            <Card key={p.slug} href={`/plugins/${p.slug}/`} title={p.title} image={p.hero}>
              <p className={body}>{p.description}</p>
              <Draws names={p.components} />
              <Badges panel={p.hasPanel} tools={p.hasTools} skill={p.hasSkill} />
            </Card>
          ))}
        </ul>
      </section>

      <section className="mt-20" aria-labelledby="templates">
        <Label>
          <span id="templates">Templates ({templates.length})</span>
        </Label>
        <ul className={templateGrid}>
          {templates.map((t, i) => (
            <Card key={t.id} href={`/templates/${t.id}/`} title={t.title} image={t.hero} className={templateSpan[i]}>
              <p className={body}>{t.description}</p>
            </Card>
          ))}
        </ul>
      </section>
    </CatalogPage>
  );
}
