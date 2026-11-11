import type { ComponentProps } from 'react';

import { docsMdxComponents } from '@/components/docs/mdx-components';
import type { Image, Plugin } from '@/lib/catalog';
import { cn } from '@/lib/utils';

/*
 * The body of a plugin's catalog page: its MDX (content/catalog/plugin-<slug>.mdx) drawn with the docs' MDX components. The tags
 * <Features />, <Presets /> and <Genes /> in that MDX draw what content/catalog.json holds for the plugin. The stills are the
 * webp files under public/catalog/plugins; the clips themselves are not hosted, so a feature shows its first frame.
 */

const frame = 'overflow-hidden rounded-2xl border border-[var(--kg-box-border)] bg-fd-muted';

/** A still in a fixed-ratio frame. A portrait one sits inside it, matted, as in the catalog's tiles. */
function Still({ image, alt, ratio = 'aspect-video' }: { image: Image; alt: string; ratio?: string }) {
  const portrait = image.h > image.w;
  return (
    <div className={cn(frame, ratio)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.src} alt={alt} width={image.w} height={image.h} loading="lazy" decoding="async" className={cn('block size-full', portrait ? 'object-contain' : 'object-cover')} />
    </div>
  );
}

/** Each feature: a still, a short heading and a sentence or two. A feature with no still is text. Three across when the count divides by three, else two, so no row is left half empty. */
function Features({ p }: { p: Plugin }) {
  return (
    <div className="@container mt-6">
      <ul className={cn('not-prose grid grid-cols-1 gap-x-6 gap-y-10', p.features.length % 3 === 0 ? '@2xl:grid-cols-3' : '@md:grid-cols-2')}>
        {p.features.map((f) => (
          <li key={f.title} className="min-w-0">
            {f.clip && <Still image={f.clip} alt={f.clip.caption ?? f.title} />}
            <h3 className={cn('font-dm text-[18px] font-bold tracking-[-0.02em] text-ink', f.clip && 'mt-4')}>{f.title}</h3>
            <p className="mt-1.5 text-[15px] leading-relaxed text-ink/75">{f.text}</p>
            {f.clip?.caption && <p className="mt-2 text-[13px] text-mute">{f.clip.caption}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Ready-made looks, each a portrait still with its name and line. */
function Presets({ p }: { p: Plugin }) {
  return (
    <>
      {p.presetNote && <p>{p.presetNote}</p>}
      <div className="@container mt-6">
        <ul className="not-prose grid grid-cols-2 gap-x-5 gap-y-8 @xl:grid-cols-4">
          {p.presets.map((r) => (
            <li key={r.name} className="min-w-0">
              {r.image && <Still image={r.image} alt={`${r.name} look`} ratio="aspect-[9/16]" />}
              <h3 className="mt-3 font-jb text-[14px] font-medium text-ink">{r.name}</h3>
              {r.line && <p className="mt-1 text-[14px] leading-snug text-ink/75">{r.line}</p>}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/** Hexed's slots, each with the effects it can roll. The note of an effect is its tooltip and, for a screen reader, hidden text. */
function Genes({ p }: { p: Plugin }) {
  return (
    <div className="@container mt-6">
      <div className="not-prose grid grid-cols-1 gap-x-10 gap-y-8 @xl:grid-cols-2">
        {(p.genes ?? []).map((s) => (
          <div key={s.slot} className="min-w-0">
            <h3 className="font-jb text-[15px] font-medium text-ink">
              {s.slot} <span className="text-mute">({s.genes.length})</span>
            </h3>
            {s.note && <p className="mt-1 text-[14px] leading-snug text-ink/75">{s.note}</p>}
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {s.genes.map((g) => (
                <li key={g.id}>
                  <span tabIndex={0} title={g.note} className="inline-block rounded-md border border-[var(--kg-box-border)] px-2 py-1 font-jb text-[12px] text-ink focus-visible:outline-2 focus-visible:outline-cobalt">
                    {g.id}
                    <span className="sr-only">: {g.note}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

const h2 = 'mt-12 mb-4 scroll-mt-24 font-dm text-[22px] font-bold tracking-[-0.03em] text-ink first:mt-0';
const h3 = 'mt-8 mb-2 scroll-mt-24 font-dm text-[18px] font-bold tracking-[-0.02em] text-ink';

/** The MDX components for a plugin's page: the docs' set, with the catalog's heading styles and the plugin's own data tags. */
export function pluginMdxComponents(p: Plugin) {
  return {
    ...docsMdxComponents,
    h2: ({ id, children }: ComponentProps<'h2'>) => (
      <h2 id={id} className={h2}>
        {children}
      </h2>
    ),
    h3: ({ id, children }: ComponentProps<'h3'>) => (
      <h3 id={id} className={h3}>
        {children}
      </h3>
    ),
    Features: () => <Features p={p} />,
    Presets: () => <Presets p={p} />,
    Genes: () => <Genes p={p} />,
  };
}
