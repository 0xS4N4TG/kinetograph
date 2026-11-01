import type { Metadata } from 'next';

import { components } from '@/lib/catalog';

type Params = { id: string };

export const dynamicParams = false;

/** Components were called templates. This keeps /templates/<id>/ alive and sends it to /components/<id>/ (a static export has no server redirects). Only the first seven components ever were templates; the kinds added later get no redirect. */
export function generateStaticParams(): Params[] {
  return components.filter((c) => !c.category).map((c) => ({ id: c.id }));
}

export async function generateMetadata(props: { params: Promise<Params> }): Promise<Metadata> {
  const { id } = await props.params;
  return {
    title: 'Moved | Kinetograph',
    robots: { index: false },
    alternates: { canonical: `https://kinetograph.dev/components/${id}/` },
  };
}

export default async function MovedTemplatePage(props: { params: Promise<Params> }) {
  const { id } = await props.params;
  const to = `/components/${id}/`;
  return (
    <>
      <meta httpEquiv="refresh" content={`0; url=${to}`} />
      <main className="mx-auto max-w-[62ch] px-4 py-24">
        <p className="text-[16px]">
          This page moved to <a href={to} className="underline">{to}</a>.
        </p>
      </main>
    </>
  );
}
