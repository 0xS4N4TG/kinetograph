import { DocsPage } from 'fumadocs-ui/layouts/docs/page';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CodeBlock, CommandBar } from '@/components/code';
import { ItemCard, TypeBadge } from '@/components/library/card';
import { Preview } from '@/components/library/preview';
import { agentPrompt, items, pluginSlug, related } from '@/lib/library';
import { manualSteps } from '@/lib/library-files';
import { plugins } from '@/lib/catalog';
import { cn } from '@/lib/utils';

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
const linkCls = 'text-cobalt underline decoration-cobalt/30 underline-offset-4 hover:decoration-cobalt';

/** The command of an item, one line each: `npx kinetograph add` for a library item, `npm install` for a plugin. */
function installCommand(name: string, type: string, npm?: string) {
  return type === 'plugin' ? `npm install ${npm}` : `npx kinetograph add ${name}`;
}

export default async function ItemPage(props: { params: Promise<Params> }) {
  const { name } = await props.params;
  const item = items.find((i) => i.name === name);
  if (!item) notFound();
  const plugin = item.type === 'plugin' ? plugins.find((p) => p.slug === pluginSlug(item)) : undefined;
  const steps = manualSteps(item);
  const portrait = item.ratio < 1;
  const command = installCommand(item.name, item.type, plugin?.name);

  return (
    <DocsPage toc={[]} breadcrumb={{ enabled: false }} footer={{ enabled: false }}>
      <nav aria-label="Breadcrumb" className="mb-6 font-jb text-[12px] text-mute">
        <Link href="/catalog/" className="transition-colors hover:text-ink">
          Catalog
        </Link>
        <span aria-hidden> / </span>
        <span aria-current="page" className="text-ink">
          {item.title}
        </span>
      </nav>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-dm text-[clamp(32px,4.2vw,48px)] leading-[1.05] font-bold tracking-[-0.045em] text-ink">{item.title}</h1>
        <TypeBadge type={item.type} />
      </div>
      <p className="mt-4 max-w-[62ch] font-dm text-[17px] leading-[1.6] text-ink/75">{item.description}</p>

      <section aria-labelledby="install" className="mt-10">
        <h2 id="install" className={h2}>
          Install
        </h2>
        <CommandBar command={command} className="mt-4 h-14 rounded-xl text-[14px]" />
        {plugin && (
          <p className="mt-3 text-[15px] text-mute">
            Adds {plugin.components.map((c) => `<${c}>`).join(' ')}
            {plugin.hasPanel && ', a Studio panel'}
            {plugin.hasTools && ', agent tools'}
            {plugin.hasSkill && ' and a skill'}.
          </p>
        )}
      </section>

      <div className={cn('mt-8 overflow-hidden rounded-2xl border border-[var(--kg-box-border)] bg-night', portrait ? 'aspect-[9/16] max-w-[360px]' : 'aspect-video')}>
        <Preview name={item.name} poster={item.poster} ratio={item.ratio} />
      </div>

      <section aria-labelledby="ask" className="mt-12">
        <h2 id="ask" className={h2}>
          Ask your coding agent
        </h2>
        <p className="mt-2 text-[15px] text-mute">Paste this into your coding agent, in a Kinetograph project.</p>
        <CodeBlock code={agentPrompt(item)} title="Prompt" wrap className="mt-4 rounded-xl" />
      </section>

      <section aria-labelledby="by-hand" className="mt-12">
        <h2 id="by-hand" className={h2}>
          Do it by hand
        </h2>
        <ol className="mt-4 space-y-6">
          {steps.map((s, n) => (
            <li key={s.text} className="flex gap-4">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-fd-accent font-jb text-[13px] text-fd-accent-foreground" aria-hidden>
                {n + 1}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-[15px] leading-relaxed text-ink/80">{s.text.split(/(`[^`]+`)/).map((part, k) => (part.startsWith('`') ? <code key={k} className="rounded bg-fd-muted px-1 py-0.5 font-jb text-[13px] text-ink">{part.slice(1, -1)}</code> : part))}</p>
                {s.code && (s.code.includes('\n') ? <CodeBlock code={s.code} wrap className="mt-3 rounded-xl" /> : <CommandBar command={s.code} className="mt-3 rounded-xl" />)}
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-[14px] text-mute">
          The files are plain source in your project, yours to change.{' '}
          <a href={`https://github.com/0xS4N4TG/kinetograph-ui/tree/main/${item.folder}`} className={linkCls}>
            See it on GitHub
          </a>
          .{plugin && (
            <>
              {' '}
              <Link href={`/docs/plugins/${plugin.slug}/`} className={linkCls}>
                Read the {item.title} docs
              </Link>
              .
            </>
          )}
        </p>
      </section>

      <section aria-labelledby="related" className="mt-16">
        <h2 id="related" className={h2}>
          More like this
        </h2>
        <ul className="mt-6 grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {related(items, item).map((i) => (
            <ItemCard key={i.name} item={i} />
          ))}
        </ul>
      </section>
    </DocsPage>
  );
}
