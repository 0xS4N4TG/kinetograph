import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { pluginByName, components, type Component } from '@/lib/catalog';
import { Adjacent, Block, CatalogPage, Crumbs, oneLine, PageHero, Tile } from '@/sections/catalog';
import { body } from '@/sections/shared';

type Params = { id: string };

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return components.map((t) => ({ id: t.id }));
}

export async function generateMetadata(props: { params: Promise<Params> }): Promise<Metadata> {
  const { id } = await props.params;
  const t = components.find((x) => x.id === id);
  if (!t) return {};
  return { title: `${t.title} component | Kinetograph`, description: t.description };
}

export default async function ComponentPage(props: { params: Promise<Params> }) {
  const { id } = await props.params;
  const t = components.find((x) => x.id === id);
  if (!t) notFound();
  const uses = t.plugins.map(pluginByName).filter((p) => p !== undefined);
  const i = components.findIndex((x) => x.id === id);
  const prev = components[(i - 1 + components.length) % components.length];
  const next = components[(i + 1) % components.length];
  const toItem = (x: Component) => ({ href: `/components/${x.id}/`, title: x.title, image: x.hero });

  return (
    <CatalogPage>
      <Crumbs section="components" current={t.title} />
      <PageHero title={t.title} tag="COMPONENT  1.00" line={oneLine(t.description)} clip={t.hero} alt={`${t.title}, a clip of the finished video`}>
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

      {t.props && t.props.length > 0 && (
        <Block id="props" title="Props">
          <p className={`${body} max-w-[62ch]`}>Every prop has a default, so the component renders as it is. Change any of them in Studio or in code.</p>
          <ul className="divide-y divide-ink/10 border-y border-ink/15">
            {t.props.map((p) => (
              <li key={p.name} className="grid grid-cols-1 gap-x-6 gap-y-1 py-3 md:grid-cols-[minmax(0,13rem)_minmax(0,11rem)_minmax(0,1fr)]">
                <code className="font-jb text-[13px] break-words text-ink">{p.name}</code>
                <p className="font-jb text-[12px] break-words text-mute">
                  {p.type}
                  {p.default && <span className="text-ink/60">{` = ${p.default}`}</span>}
                </p>
                <p className="text-[15px] leading-[1.5] text-ink/75">{p.doc}</p>
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

      <Adjacent label="component" prev={toItem(prev)} next={toItem(next)} />
    </CatalogPage>
  );
}
