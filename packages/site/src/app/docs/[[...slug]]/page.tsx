import { DocsPre, PromptBox } from '@/components/docs/mdx';
import { Media } from '@/components/docs/media';
import { Card, CardGroup, Note, Step, Tip, Warning } from '@/components/docs/blocks';
import { FilmGrid } from '@/components/docs/film-grid';
import { IconTabs, Tab } from '@/components/docs/icon-tabs';
import { Terminal, TwoUp } from '@/components/docs/figures';
import { RouteGrid } from '@/components/docs/route-grid';
import { LinkCard } from '@/components/docs/link-card';
import { Video } from '@/components/docs/video';
import { PageActions } from '@/components/docs/page-actions';
import { TasteGallery } from '@/components/docs/taste-gallery';
import { EngineDiagram } from '@/components/engine-diagram';
import { SITE_URL } from '@/lib/catalog-feed';
import { source } from '@/lib/source';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Steps } from 'fumadocs-ui/components/steps';
import defaultMdxComponents from 'fumadocs-ui/mdx';
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
        {/*
          MDX components, as written in a page:
          - ```tsx title="src/MyComp.tsx"  a code block headed by its file name, with a copy button (DocsPre).
          - ```txt with ├─ │ └─ branches  a file tree (DocsPre spots the branches): a trailing / marks a folder, text
            after two spaces is a comment. It copies as plain text. Add title="..." for a header.
          - ```txt title="Suggested prompt"  a prompt box when the text starts with /skill-name; or write
            <Prompt skill="kinetograph-markup">Add motion blur to my text</Prompt>.
          - <Media src="studio/window-light.webp" dark="studio/window-dark.webp" width={1600} height={1160} alt="..." />
            a picture from public/docs-media, or a looping clip for an .mp4 (components/docs/media.tsx).
          - <Video name="first-video" label="..." caption="..." silent />  a hosted clip with a poster (components/docs/video.tsx;
            base URL in sections/links.ts).
          - <FilmGrid /> / <LinkCard title icon href> / <Card> / <CardGroup cols> / <Steps><Step title> / <Tip> / <Note>:
            the HyperFrames-style blocks (components/docs/film-grid.tsx, link-card.tsx, blocks.tsx).
          - <TasteGallery />  every taste of the catalog as a looping clip with its name (components/docs/taste-gallery.tsx).
        */}
        <MDX
          components={{
            ...defaultMdxComponents,
            pre: DocsPre,
            Media,
            Video,
            FilmGrid,
            IconTabs,
            Terminal,
            TwoUp,
            RouteGrid,
            LinkCard,
            Card,
            CardGroup,
            Steps,
            Step,
            Tip,
            Note,
            TasteGallery,
            Prompt: PromptBox,
            Accordion,
            Accordions,
            AccordionGroup: Accordions,
            Warning,
            EngineDiagram,
            Tab,
          }}
        />
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
