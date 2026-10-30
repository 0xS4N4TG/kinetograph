import type { CSSProperties, ReactNode } from 'react';

import { ClipPlayer } from '@/components/clip-player';
import { InView } from '@/components/in-view';
import { Badge } from '@/components/ui/badge';
import type { Clip, Image } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { Nav } from '@/sections/nav';
import { Heading } from '@/sections/heading';
import { body, Label, link, section, shell } from '@/sections/shared';

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

/** The first sentence of a description: the one line under a tile. */
export const oneLine = (text: string) => text.split(/(?<=[.!?])\s/)[0];

/**
 * Small links above a page's heading so the catalog can be browsed without the back button: the section this page
 * belongs to and its own name on the left, the other section on the right.
 */
export function Crumbs({ section: sec, current }: { section: 'plugins' | 'templates'; current?: string }) {
  const here = sec === 'plugins' ? { href: '/plugins/', name: 'Plugins' } : { href: '/plugins/#templates', name: 'Templates' };
  const other = sec === 'plugins' ? { href: '/plugins/#templates', name: 'Templates' } : { href: '/plugins/', name: 'Plugins' };
  const cls = `${link} kc-press inline-block`;
  return (
    <nav aria-label="Catalog" className="mb-6 flex items-center justify-between font-jb text-[12px] tracking-[0.04em]">
      <p className="flex items-center gap-2 text-mute">
        <a href={here.href} className={cls}>
          {here.name}
        </a>
        {current && (
          <>
            <span aria-hidden>/</span>
            <span aria-current="page" className="text-ink">
              {current}
            </span>
          </>
        )}
      </p>
      <a href={other.href} className={cls}>
        {other.name}
      </a>
    </nav>
  );
}

/**
 * The first screen of a plugin or template page: the clip large, the title and one sentence beside it (stacked under
 * md). The clip's width is capped by the viewport height so a portrait clip never pushes the title off the screen.
 */
export function PageHero({ title, tag, line, clip, alt, children }: { title: string; tag: string; line: string; clip: Clip | null; alt: string; children?: ReactNode }) {
  const ratio = clip ? clip.w / clip.h : 16 / 9;
  const wide = ratio >= 1.5;
  return (
    <div className={cn('grid grid-cols-1 items-center gap-8 md:gap-12', wide ? 'md:grid-cols-[4fr_8fr]' : 'md:grid-cols-2')}>
      <div>
        <Heading as="h1" lines={[title]} hot={title.split(' ')[0]} tag={tag} className="text-[clamp(34px,3.8vw,52px)]" />
        <p className={`${body} mt-5 max-w-[44ch]`}>{line}</p>
        {children}
      </div>
      {clip && (
        <InView
          wipe
          style={{ '--r': ratio } as CSSProperties}
          className="w-full max-w-[min(100%,calc(var(--r)*44vh))] justify-self-start md:max-w-[min(100%,calc(var(--r)*68vh))] md:justify-self-end"
        >
          <ClipPlayer clip={clip} label={alt} />
        </InView>
      )}
    </div>
  );
}

/** A titled block of a catalog page. */
export function Block({ id, title, children, className }: { id: string; title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-16', className)} aria-labelledby={id}>
      <h2 id={id} className="scroll-mt-20 font-dm text-[clamp(26px,2.6vw,34px)] leading-tight font-bold tracking-[-0.04em] text-ink">
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

const isClip = (m: Image | Clip): m is Clip => 'video' in m;

/**
 * A clip (or a still) with one plain caption line under it. Portrait media stays narrow. The caption is text under the
 * media, never over it.
 */
export function Figure({ media, alt, caption, className, reveal = false }: { media: Image | Clip; alt: string; caption?: string; className?: string; reveal?: boolean }) {
  const portrait = media.h > media.w;
  return (
    <figure className={cn(portrait && 'max-w-[360px]', className)}>
      {isClip(media) ? (
        reveal ? (
          <InView wipe>
            <ClipPlayer clip={media} label={alt} />
          </InView>
        ) : (
          <ClipPlayer clip={media} label={alt} />
        )
      ) : (
        <Still image={media} alt={alt} />
      )}
      {caption && <figcaption className="mt-2 text-[14px] text-mute">{caption}</figcaption>}
    </figure>
  );
}

/**
 * A tile of the index: the clip is the card. It plays on hover with a desktop pointer (the in-view card plays on
 * touch), and a link covers the whole card. `fixed` crops landscape clips to one frame and mats a portrait clip in it;
 * otherwise the clip keeps its own aspect. The name and text sit under the media.
 */
export function Tile({ href, title, clip, fixed = false, index = 0, className, children }: { href: string; title: string; clip: Clip | null; fixed?: boolean; index?: number; className?: string; children: ReactNode }) {
  const portrait = clip !== null && clip.h > clip.w;
  return (
    <InView as="li" index={index} className={className}>
      <div data-tile className="kc-tile kc-press group relative">
        <div
          className={cn('kc-media overflow-hidden bg-ink', fixed && 'aspect-[16/10]')}
          style={!fixed && clip ? { aspectRatio: `${clip.w} / ${clip.h}` } : undefined}
        >
          {clip && <ClipPlayer clip={clip} label="" play="hover" className={cn('h-full w-full', fixed && portrait ? 'object-contain' : 'object-cover')} />}
        </div>
        <h3 className="mt-4 font-dm text-[22px] leading-tight font-bold tracking-[-0.03em] text-ink">
          <a
            href={href}
            className="transition-colors after:absolute after:inset-0 hover:text-cobalt focus-visible:after:outline-2 focus-visible:after:outline-offset-4 focus-visible:after:outline-cobalt"
          >
            {title}
          </a>
        </h3>
        <div className="mt-1.5 space-y-1.5">{children}</div>
      </div>
    </InView>
  );
}

/** Previous and next in a list, wrapping round, each with its small still. */
export function Adjacent({ label, prev, next }: { label: string; prev: { href: string; title: string; image: Image | null }; next: { href: string; title: string; image: Image | null } }) {
  const side = (item: typeof prev, dir: 'Previous' | 'Next') => (
    <a href={item.href} className={cn('kc-press flex items-center gap-4 hover:text-cobalt', dir === 'Next' && 'flex-row-reverse text-right')}>
      {item.image && <img src={item.image.src} width={item.image.w} height={item.image.h} alt="" loading="lazy" className="hidden aspect-[16/10] w-28 shrink-0 bg-ink object-cover sm:block" />}
      <span className="min-w-0">
        <Label>
          {dir} {label}
        </Label>
        <span className="mt-1 block font-dm text-[20px] leading-tight font-bold tracking-[-0.03em] text-ink">{item.title}</span>
      </span>
    </a>
  );
  return (
    <nav aria-label={`More ${label}s`} className="mt-20 grid grid-cols-2 gap-6 border-t border-ink/15 pt-6">
      {side(prev, 'Previous')}
      {side(next, 'Next')}
    </nav>
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
  return <p className="line-clamp-2 font-jb text-[13px] text-ink/75">Draws {names.map((c) => `<${c}>`).join(' ')}</p>;
}
