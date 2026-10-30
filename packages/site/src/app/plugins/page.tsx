import type { Metadata } from 'next';

import { plugins, templates } from '@/lib/catalog';
import { Badges, Card, CatalogPage, Draws } from '@/sections/catalog';
import { Heading } from '@/sections/heading';
import { Label, body } from '@/sections/shared';

export const metadata: Metadata = {
  title: 'Plugins and templates | Kinetograph',
  description: 'The Studio plugins and reel templates made for Kinetograph: what each draws and what you change.',
};

const grid = 'mt-6 grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3';

export default function PluginsPage() {
  return (
    <CatalogPage>
      <Heading as="h1" lines={['Plugins and templates']} hot="templates" tag="CAT 01  1.00" className="text-[clamp(36px,4.2vw,56px)]" />
      <p className={`${body} mt-6 max-w-[62ch]`}>
        Plugins add components, a Studio panel, agent tools and a skill to a project. Templates are finished videos you can
        start a project from. Both are coming; none is published yet.
      </p>

      <section className="mt-16" aria-labelledby="plugins">
        <Label>
          <span id="plugins">Plugins ({plugins.length})</span>
        </Label>
        <ul className={grid}>
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
        <ul className={grid}>
          {templates.map((t) => (
            <Card key={t.id} href={`/templates/${t.id}/`} title={t.title} image={t.hero}>
              <p className={body}>{t.description}</p>
            </Card>
          ))}
        </ul>
      </section>
    </CatalogPage>
  );
}
