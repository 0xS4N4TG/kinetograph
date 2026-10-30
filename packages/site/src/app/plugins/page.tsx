import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import catalog from '../../../content/catalog.json';
import { Heading } from '@/sections/heading';
import { Nav } from '@/sections/nav';
import { Label, body, section, shell } from '@/sections/shared';

export const metadata: Metadata = {
  title: 'Plugins and templates | Kinetograph',
  description: 'The Studio plugins and reel templates made for Kinetograph.',
};

interface Plugin {
  name: string;
  title: string;
  description: string;
  components: string[];
  hasPanel: boolean;
  hasTools: boolean;
  hasSkill: boolean;
  demos: { id: string; title: string }[];
}

interface Template {
  id: string;
  title: string;
  description: string;
  plugins: string[];
}

const plugins: Plugin[] = catalog.plugins;
const templates: Template[] = catalog.templates;
const titleOf = (name: string) => plugins.find((p) => p.name === name)?.title ?? name;

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="border-t border-ink/15 py-6">
      <h3 className="font-dm text-[22px] leading-tight font-bold tracking-[-0.03em] text-ink">{title}</h3>
      <div className="mt-2 space-y-3">{children}</div>
    </li>
  );
}

export default function PluginsPage() {
  return (
    <div className="min-h-screen overflow-x-clip bg-ground font-dm text-ink selection:bg-flag selection:text-white">
      <Nav />
      <main className={`${shell} ${section}`}>
        <Heading as="h1" lines={['Plugins and templates']} hot="templates" tag="CAT 01  1.00" className="text-[clamp(36px,4.2vw,56px)]" />
        <p className={`${body} mt-6 max-w-[62ch]`}>
          Plugins add components, a Studio panel, agent tools and a skill to a project. Templates are finished reels you
          can start a project from. Both are coming; none is published yet.
        </p>

        <section className="mt-16" aria-labelledby="plugins">
          <Label>
            <span id="plugins">Plugins ({plugins.length})</span>
          </Label>
          <ul className="mt-4">
            {plugins.map((p) => (
              <Row key={p.name} title={p.title}>
                <p className={body}>{p.description}</p>
                {p.components.length > 0 && (
                  <p className="font-jb text-[13px] text-ink/75">
                    Draws {p.components.map((c) => `<${c}>`).join(' ')}
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {p.hasPanel && <Badge variant="outline">Studio panel</Badge>}
                  {p.hasTools && <Badge variant="outline">Agent tools</Badge>}
                  {p.hasSkill && <Badge variant="outline">Skill</Badge>}
                </div>
                {p.demos.length > 0 && (
                  <p className="text-[14px] text-mute">Demos: {p.demos.map((d) => d.title).join(', ')}</p>
                )}
              </Row>
            ))}
          </ul>
        </section>

        <section className="mt-16" aria-labelledby="templates">
          <Label>
            <span id="templates">Templates ({templates.length})</span>
          </Label>
          <ul className="mt-4">
            {templates.map((t) => (
              <Row key={t.id} title={t.title}>
                <p className={body}>{t.description}</p>
                {t.plugins.length > 0 && (
                  <p className="text-[14px] text-mute">Uses plugins: {t.plugins.map(titleOf).join(', ')}</p>
                )}
              </Row>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
