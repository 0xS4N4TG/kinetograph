import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { pluginByName, templates } from '@/lib/catalog';
import { Back, Block, CatalogPage, Figure } from '@/sections/catalog';
import { Heading } from '@/sections/heading';
import { body, link } from '@/sections/shared';

type Params = { id: string };

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return templates.map((t) => ({ id: t.id }));
}

export async function generateMetadata(props: { params: Promise<Params> }): Promise<Metadata> {
  const { id } = await props.params;
  const t = templates.find((x) => x.id === id);
  if (!t) return {};
  return { title: `${t.title} template | Kinetograph`, description: t.description };
}

export default async function TemplatePage(props: { params: Promise<Params> }) {
  const { id } = await props.params;
  const t = templates.find((x) => x.id === id);
  if (!t) notFound();
  const uses = t.plugins.map(pluginByName).filter((p) => p !== undefined);

  return (
    <CatalogPage>
      <Back href="/plugins/#templates">All templates</Back>
      <Heading as="h1" lines={[t.title]} hot={t.title.split(' ')[0]} tag="TEMPLATE  1.00" className="text-[clamp(36px,4.2vw,56px)]" />
      <p className={`${body} mt-6 max-w-[62ch]`}>{t.description}</p>
      <p className="mt-4 text-[14px] text-mute">Coming; not published yet.</p>
      {t.hero && (
        <div className="mt-10">
          <Figure media={t.hero} alt={`${t.title}, a clip of the finished video`} />
        </div>
      )}

      {t.change.length > 0 && (
        <Block id="change" title="What you change">
          <ul className="max-w-[68ch] list-disc space-y-2 pl-5 marker:text-ink/40">
            {t.change.map((c) => (
              <li key={c} className={body}>
                {c}
              </li>
            ))}
          </ul>
        </Block>
      )}

      {uses.length > 0 && (
        <Block id="uses" title="Uses">
          <ul className="space-y-1">
            {uses.map((p) => (
              <li key={p.slug} className={body}>
                <a href={`/plugins/${p.slug}/`} className={link}>
                  {p.title}
                </a>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {t.compositions.length > 0 && (
        <Block id="compositions" title="Compositions">
          <ul className="flex flex-wrap gap-2">
            {t.compositions.map((c) => (
              <li key={c} className="rounded-sm border border-ink/20 px-2 py-1 font-jb text-[13px] text-ink">
                {c}
              </li>
            ))}
          </ul>
        </Block>
      )}
    </CatalogPage>
  );
}
