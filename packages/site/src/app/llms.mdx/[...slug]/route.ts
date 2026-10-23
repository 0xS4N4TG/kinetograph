import { source } from '@/lib/source';
import { notFound } from 'next/navigation';

export const dynamic = 'force-static';

/** The docs index has no slug, so it is served as `index`; a directory cannot share the `llms.mdx` path. */
const toSlug = (slug: string[]) => (slug.length === 1 && slug[0] === 'index' ? [] : slug);

/** One Markdown file per docs page, written at build time for the "Copy Markdown" button. */
export async function GET(_req: Request, props: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await props.params;
  const page = source.getPage(toSlug(slug));
  if (!page) notFound();
  const text = await page.data.getText('processed');
  return new Response(`# ${page.data.title}\n\n${text}`, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}

export function generateStaticParams() {
  return source.generateParams().map(({ slug }) => ({ slug: slug.length ? slug : ['index'] }));
}
