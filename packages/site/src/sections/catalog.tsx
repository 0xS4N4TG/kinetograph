import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import type { Image } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { Nav } from '@/sections/nav';
import { body, link, section, shell } from '@/sections/shared';

/** The page frame the catalog pages share: the nav, then the shell. */
export function CatalogPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen overflow-x-clip bg-ground font-dm text-ink selection:bg-flag selection:text-white">
      <Nav />
      <main className={`${shell} ${section}`}>{children}</main>
    </div>
  );
}

/** A link back up the section, above a page's heading. */
export function Back({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className={`${link} mb-6 inline-block font-jb text-[12px] tracking-[0.04em]`}>
      {children}
    </a>
  );
}

/** A titled block of a catalog page. */
export function Block({ id, title, children, className }: { id: string; title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-16', className)} aria-labelledby={id}>
      <h2 id={id} className="font-dm text-[clamp(26px,2.6vw,34px)] leading-tight font-bold tracking-[-0.04em] text-ink">
        {title}
      </h2>
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}

/** A still at its own aspect; `fit` crops it to a fixed frame (the cards). */
export function Still({ image, alt, fit = false, className }: { image: Image; alt: string; fit?: boolean; className?: string }) {
  return (
    <img
      src={image.src}
      width={image.w}
      height={image.h}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={cn('block w-full bg-ink/5', fit ? 'aspect-[16/10] object-cover' : 'h-auto', className)}
    />
  );
}

/** A still with its caption, for a page body. Portrait stills stay narrow. */
export function Figure({ image, alt, caption }: { image: Image; alt: string; caption?: string }) {
  const portrait = image.h > image.w;
  return (
    <figure className={cn(portrait && 'max-w-[420px]')}>
      <Still image={image} alt={alt} />
      {caption && <figcaption className="mt-2 text-[14px] text-mute">{caption}</figcaption>}
    </figure>
  );
}

/** A card of the index grids: a still, a title, text, and a link over the whole card. */
export function Card({ href, title, image, children }: { href: string; title: string; image: Image | null; children: ReactNode }) {
  return (
    <li className="group relative flex flex-col border-t border-ink/15 pt-4">
      {image ? <Still image={image} alt="" fit /> : <div className="aspect-[16/10] bg-ink/5" />}
      <h3 className="mt-4 font-dm text-[22px] leading-tight font-bold tracking-[-0.03em] text-ink">
        <a href={href} className="after:absolute after:inset-0 group-hover:text-cobalt">
          {title}
        </a>
      </h3>
      <div className="mt-2 space-y-3">{children}</div>
    </li>
  );
}

/** The Studio panel, agent tools and skill badges of a plugin. */
export function Badges({ panel, tools, skill }: { panel: boolean; tools: boolean; skill: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {panel && <Badge variant="outline">Studio panel</Badge>}
      {tools && <Badge variant="outline">Agent tools</Badge>}
      {skill && <Badge variant="outline">Skill</Badge>}
    </div>
  );
}

/** The components a plugin draws, as the JSX that draws them. */
export function Draws({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return <p className="font-jb text-[13px] text-ink/75">Draws {names.map((c) => `<${c}>`).join(' ')}</p>;
}

export function Paragraphs({ items }: { items: string[] }) {
  return (
    <>
      {items.map((t) => (
        <p key={t} className={`${body} max-w-[68ch]`}>
          {t}
        </p>
      ))}
    </>
  );
}
