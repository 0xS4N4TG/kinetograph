import { plugins } from '@/lib/catalog';
import { pluginMarkdown } from '@/lib/plugin-markdown';
import { pluginPages } from '@/lib/source';
import { notFound } from 'next/navigation';

export const dynamic = 'force-static';

const slugOf = (name: string) => name.replace(/\.md$/, '').replace(/^plugin-/, '');

/** A plugin's catalog page as Markdown, `/llms.mdx/catalog/plugin-<slug>.md`: the same text as the page, for the "Copy Markdown" button and for agents. */
export async function GET(_req: Request, props: { params: Promise<{ name: string }> }) {
  const slug = slugOf((await props.params).name);
  const plugin = plugins.find((p) => p.slug === slug);
  const page = pluginPages.getPage([`plugin-${slug}`]);
  if (!plugin || !page) notFound();
  const text = await page.data.getText('processed');
  return new Response(pluginMarkdown(plugin, text), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}

export function generateStaticParams() {
  return plugins.map((p) => ({ name: `plugin-${p.slug}.md` }));
}
