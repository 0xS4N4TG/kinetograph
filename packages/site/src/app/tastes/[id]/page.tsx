import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { tastes, type Taste } from '@/lib/catalog';
import { Adjacent, CatalogPage, Crumbs, oneLine, PageHero } from '@/sections/catalog';

type Params = { id: string };

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return tastes.map((t) => ({ id: t.id }));
}

export async function generateMetadata(props: { params: Promise<Params> }): Promise<Metadata> {
  const { id } = await props.params;
  const t = tastes.find((x) => x.id === id);
  if (!t) return {};
  return { title: `${t.title} taste | Kinetograph`, description: t.description };
}

export default async function TastePage(props: { params: Promise<Params> }) {
  const { id } = await props.params;
  const t = tastes.find((x) => x.id === id);
  if (!t) notFound();
  const i = tastes.findIndex((x) => x.id === id);
  const prev = tastes[(i - 1 + tastes.length) % tastes.length];
  const next = tastes[(i + 1) % tastes.length];
  const toItem = (x: Taste) => ({ href: `/tastes/${x.id}/`, title: x.title, image: x.hero });

  return (
    <CatalogPage>
      <Crumbs section="tastes" current={t.title} />
      <PageHero title={t.title} tag="TASTE  1.00" line={oneLine(t.description)} clip={t.hero} alt={`${t.title}, a clip of its demo video`}>
        <p className="mt-4 text-[14px] text-mute">Coming; not published yet.</p>
      </PageHero>
      <Adjacent label="taste" prev={toItem(prev)} next={toItem(next)} />
    </CatalogPage>
  );
}
