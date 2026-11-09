import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CommandBar, CodeBlock } from '@/components/code';
import { ItemCard, TypeBadge } from '@/components/library/card';
import { Frame } from '@/components/library/frame';
import { Preview } from '@/components/library/preview';
import { Sidebar } from '@/components/library/sidebar';
import { agentPrompt, items, related } from '@/lib/library';
import { itemFiles } from '@/lib/library-files';
import { cn } from '@/lib/utils';
import { shell } from '@/sections/shared';

type Params = { name: string };

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return items.map((i) => ({ name: i.name }));
}

export async function generateMetadata(props: { params: Promise<Params> }): Promise<Metadata> {
  const { name } = await props.params;
  const item = items.find((i) => i.name === name);
  return item ? { title: `${item.title} ${item.type} | Kinetograph`, description: item.description } : {};
}

const h2 = 'font-dm text-[22px] font-bold tracking-[-0.03em] text-ink';

export default async function ItemPage(props: { params: Promise<Params> }) {
  const { name } = await props.params;
  const item = items.find((i) => i.name === name);
  if (!item) notFound();
  const files = itemFiles(item.name);
  const portrait = item.ratio < 1;

  return (
    <Frame>
      <div className={`${shell} flex gap-10 pb-[clamp(64px,9vw,128px)]`}>
        <Sidebar active={item.group} />
        <article className="min-w-0 max-w-[920px] flex-1 lg:pt-4">
          <nav aria-label="Breadcrumb" className="mb-6 font-jb text-[12px] text-mute">
            <a href="/catalog/" className="transition-colors hover:text-ink">
              Catalog
            </a>
            <span aria-hidden> / </span>
            <span aria-current="page" className="text-ink">
              {item.title}
            </span>
          </nav>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-dm text-[clamp(34px,4.6vw,52px)] leading-[1.05] font-bold tracking-[-0.045em] text-ink">{item.title}</h1>
            <TypeBadge type={item.type} />
          </div>
          <p className="mt-4 max-w-[62ch] font-dm text-[17px] leading-[1.6] text-ink/75">{item.description}</p>

          <section aria-labelledby="install" className="mt-10">
            <h2 id="install" className={h2}>
              Install
            </h2>
            <CommandBar command={`npx kinetograph add ${item.name}`} className="mt-4 h-14 rounded-xl text-[14px]" />
            <p className="mt-3 text-[15px] text-mute">
              Adds {files.length} {files.length === 1 ? 'file' : 'files'} to your project.
            </p>
          </section>

          <div
            className={cn('mt-8 overflow-hidden rounded-2xl border border-[var(--kg-box-border)] bg-night', portrait ? 'aspect-[9/16] max-w-[360px]' : 'aspect-video')}
          >
            <Preview name={item.name} poster={item.poster} ratio={item.ratio} />
          </div>

          <section aria-labelledby="ask" className="mt-12">
            <h2 id="ask" className={h2}>
              Ask your agent
            </h2>
            <p className="mt-2 text-[15px] text-mute">Paste this into your coding agent, in a Kinetograph project.</p>
            <CodeBlock code={agentPrompt(item)} title="Prompt" wrap className="mt-4 rounded-xl" />
          </section>

          <section aria-labelledby="files" className="mt-12">
            <h2 id="files" className={h2}>
              Files it adds
            </h2>
            <ul className="mt-4 max-h-80 divide-y divide-[var(--kg-box-border)] overflow-y-auto rounded-xl border border-[var(--kg-box-border)] bg-fd-card">
              {files.map((f) => (
                <li key={f} className="px-4 py-2 font-jb text-[13px] break-all text-ink">
                  {f}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[14px] text-mute">
              The files are plain source in your project, yours to change.{' '}
              <a href={`https://github.com/0xS4N4TG/kinetograph-ui/tree/main/${item.folder}`} className="text-cobalt underline decoration-cobalt/30 underline-offset-4 hover:decoration-cobalt">
                See it on GitHub
              </a>
              .
            </p>
          </section>

          <section aria-labelledby="related" className="mt-16">
            <h2 id="related" className={h2}>
              More like this
            </h2>
            <ul className="mt-6 grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 xl:grid-cols-3">
              {related(item).map((i) => (
                <ItemCard key={i.name} item={i} />
              ))}
            </ul>
          </section>
        </article>
      </div>
    </Frame>
  );
}
