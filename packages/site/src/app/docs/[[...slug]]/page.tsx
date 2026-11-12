import { docsMdxComponents } from '@/components/docs/mdx-components';
import { PageActions } from '@/components/docs/page-actions';
import { SITE_URL } from '@/lib/catalog-feed';
import { source } from '@/lib/source';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const MDX = page.data.body;
  const markdownUrl = `/llms.mdx/${page.slugs.join('/') || 'index'}.md`;
  return (
    <DocsPage toc={page.data.toc} full={page.data.full} breadcrumb={{ includePage: true }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <DocsTitle>{page.data.title}</DocsTitle>
        <PageActions markdownUrl={markdownUrl} absoluteMarkdownUrl={`${SITE_URL}${markdownUrl}`} />
      </div>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={docsMdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: { params: Promise<{ slug?: string[] }> }): Promise<Metadata> {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  return { title: `${page.data.title} · Kinetograph`, description: page.data.description };
}
