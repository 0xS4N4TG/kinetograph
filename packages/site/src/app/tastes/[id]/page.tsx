import type { Metadata } from 'next';

import { Redirect } from '@/components/redirect';
import { items, movedTo } from '@/lib/library';

type Params = { id: string };

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return items.filter((i) => i.type === 'taste').map((i) => ({ id: i.name }));
}

export async function generateMetadata(props: { params: Promise<Params> }): Promise<Metadata> {
  return movedTo(`/catalog/${(await props.params).id}/`);
}

/** The old /tastes/<id>/ page: the item's page in the catalog. */
export default async function Page(props: { params: Promise<Params> }) {
  return <Redirect to={`/catalog/${(await props.params).id}/`} />;
}
