import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { components, templates } from '@/lib/catalog';
import { ItemPage, MovedPage } from '@/sections/item';

type Params = { id: string };

export const dynamicParams = false;

/** Templates were components: their old /components/<id>/ pages stay and point to /templates/<id>/. */
export function generateStaticParams(): Params[] {
  return [...components, ...templates].map((t) => ({ id: t.id }));
}

export async function generateMetadata(props: { params: Promise<Params> }): Promise<Metadata> {
  const { id } = await props.params;
  const t = components.find((x) => x.id === id);
  if (t) return { title: `${t.title} component | Kinetograph`, description: t.description };
  return {
    title: 'Moved | Kinetograph',
    robots: { index: false },
    alternates: { canonical: `https://kinetograph.dev/templates/${id}/` },
  };
}

export default async function ComponentPage(props: { params: Promise<Params> }) {
  const { id } = await props.params;
  const t = components.find((x) => x.id === id);
  if (t) return <ItemPage kind="component" item={t} items={components} />;
  if (templates.some((x) => x.id === id)) return <MovedPage to={`/templates/${id}/`} />;
  notFound();
}
