import { source } from '@/lib/source';
import { DocsBody, DocsDescription, DocsPage, DocsTitle, MarkdownCopyButton } from 'fumadocs-ui/layouts/docs/page';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const MDX = page.data.body;
  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <DocsTitle>{page.data.title}</DocsTitle>
        <MarkdownCopyButton markdownUrl={`/llms.mdx/${page.slugs.join('/') || 'index'}`} />
      </div>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents, Accordion, Accordions }} />
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
