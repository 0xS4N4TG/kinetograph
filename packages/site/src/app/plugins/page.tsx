import type { Metadata } from 'next';

import { plugins, templates } from '@/lib/catalog';
import { Badges, Card, CatalogPage, Draws } from '@/sections/catalog';
import { Heading } from '@/sections/heading';
import { Label, body } from '@/sections/shared';

export const metadata: Metadata = {
  title: 'Plugins and templates | Kinetograph',
  description: 'Plugins and reel templates for Kinetograph: what each one draws and what you change.',
};

const grid = 'mt-6 grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3';

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
