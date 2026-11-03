import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { templates } from '@/lib/catalog';
import { ItemPage } from '@/sections/item';

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
  return <ItemPage kind="template" item={t} items={templates} />;
}
