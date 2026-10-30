import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { pluginByName, templates, type Template } from '@/lib/catalog';
import { Adjacent, Block, CatalogPage, Crumbs, oneLine, PageHero, Tile } from '@/sections/catalog';
import { body } from '@/sections/shared';

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
  const i = templates.findIndex((x) => x.id === id);
  const prev = templates[(i - 1 + templates.length) % templates.length];
  const next = templates[(i + 1) % templates.length];
  const toItem = (x: Template) => ({ href: `/templates/${x.id}/`, title: x.title, image: x.hero });

  return (
    <CatalogPage>
      <Crumbs section="templates" current={t.title} />
      <PageHero title={t.title} tag="TEMPLATE  1.00" line={oneLine(t.description)} clip={t.hero} alt={`${t.title}, a clip of the finished video`}>
        <p className="mt-4 text-[14px] text-mute">Coming; not published yet.</p>
      </PageHero>

      {t.description !== oneLine(t.description) && (
        <p className={`${body} mt-12 max-w-[62ch]`}>{t.description.slice(oneLine(t.description).length).trim()}</p>
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
        <Block id="uses" title="Plugins it uses">
          <ul className="grid grid-cols-1 gap-8 sm:grid-cols-2 md:grid-cols-3">
            {uses.map((p, n) => (
              <Tile key={p.slug} href={`/plugins/${p.slug}/`} title={p.title} clip={p.hero} fixed index={n}>
                <p className="line-clamp-2 text-[15px] leading-[1.5] text-ink/75">{oneLine(p.description)}</p>
              </Tile>
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

      <Adjacent label="template" prev={toItem(prev)} next={toItem(next)} />
    </CatalogPage>
  );
}
