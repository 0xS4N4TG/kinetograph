'use client';

import { useState } from 'react';

import { VIDEO_BASE } from '@/sections/links';

export interface Route {
  title: string;
  /** What the reader brings: one line, starting with "Bring". */
  bring: string;
  href: string;
  /** The clip is `VIDEO_BASE + 'routes-' + clip + '.mp4'`; `poster` is a local image. A route with neither shows a plain tinted box. */
  clip?: string;
  poster?: string;
}

/**
 * The "what do you want to make" picker: a two-column grid of routes. Each has a looping, muted 16:9 preview, a bold title and a line that
 * says what you bring. There is no card box. Under prefers-reduced-motion the previews stay posters.
 *
 * ```mdx
 * <RouteGrid routes={[{ title: 'Explain an idea', bring: 'Bring notes or a script.', href: '/docs/tips/storyboards/', clip: 'explain', poster: '/docs-media/films/dostoevsky.webp' }]} />
 * ```
 */
export function RouteGrid({ routes }: { routes: Route[] }) {
  const [still] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const box = 'block aspect-video w-full rounded-lg object-cover';
  return (
    <div className="not-prose my-6 grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2">
      {routes.map((r) => (
        <a key={r.title} href={r.href} aria-label={`${r.title}. ${r.bring}`} className="group flex flex-col gap-2 text-fd-foreground no-underline">
          {r.poster && VIDEO_BASE && r.clip && !still ? (
            <video ref={(v) => void (v && (v.muted = true))} src={`${VIDEO_BASE}routes-${r.clip}.mp4`} poster={r.poster} autoPlay muted loop playsInline preload="metadata" aria-hidden="true" className={`${box} bg-black`} />
          ) : r.poster ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.poster} alt="" width={480} height={270} loading="lazy" className={`${box} bg-black`} />
          ) : (
            <span aria-hidden="true" className={`${box} bg-fd-muted`} />
          )}
          <span>
            <span className="block font-semibold leading-snug transition-colors group-hover:text-fd-primary">{r.title}</span>
            <span className="mt-1 block text-sm leading-normal text-fd-muted-foreground">{r.bring}</span>
          </span>
        </a>
      ))}
    </div>
  );
}
