import { source } from '@/lib/source';
import { notFound } from 'next/navigation';

export const dynamic = 'force-static';

/**
 * Each page is served as `<slug>.md`, so a folder's index page (`terminology.md`) and the folder of its pages
 * (`terminology/`) can sit side by side in the static export. The docs index has no slug and is served as `index.md`.
 */
const toSlug = (slug: string[]) => {
  const parts = [...slug.slice(0, -1), slug[slug.length - 1].replace(/\.md$/, '')];
  return parts.length === 1 && parts[0] === 'index' ? [] : parts;
};

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
  return source.generateParams().map(({ slug }) => ({
    slug: slug.length ? [...slug.slice(0, -1), `${slug[slug.length - 1]}.md`] : ['index.md'],
  }));
}
