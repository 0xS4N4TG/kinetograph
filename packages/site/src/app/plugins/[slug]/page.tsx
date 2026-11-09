import type { Metadata } from 'next';

import { Redirect } from '@/components/redirect';
import { plugins } from '@/lib/catalog';
import { movedTo } from '@/lib/library';

type Params = { slug: string };

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return plugins.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata(props: { params: Promise<Params> }): Promise<Metadata> {
  return movedTo(`/catalog/plugin-${(await props.params).slug}/`);
}

/** The old /plugins/<slug>/ page: the plugin's page in the catalog. */
export default async function Page(props: { params: Promise<Params> }) {
  return <Redirect to={`/catalog/plugin-${(await props.params).slug}/`} />;
}
