'use client';

import { ArrowLeftIcon, ArrowRightIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Heading } from '@/sections/heading';
import renders from '@/sections/renders.json';
import { section, shell } from '@/sections/shared';

interface Render {
  name: string;
  title: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  seconds_video: number;
  credit?: string;
  web: string;
  poster: string;
}

/** Seconds as the page states them: whole above 10, one decimal below (6 s, 2.3 s). */
const secs = (s: number) => `${s >= 10 ? Math.round(s) : Number(s.toFixed(1))} s`;

/** One example: a muted looping clip, full colour, that plays while it is in view or hovered, and what it is made of. */
function RenderCard({ r }: { r: Render }) {
  const video = useRef<HTMLVideoElement>(null);
  const [hover, setHover] = useState(false);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(!!e?.isIntersecting), { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (hover || (inView && !reduce)) void el.play().catch(() => {});
    else el.pause();
  }, [hover, inView]);
  return (
    <figure className="shrink-0 snap-start" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className="kg-tray">
        <div className="kg-core bg-ink" style={{ aspectRatio: `${r.width} / ${r.height}` }}>
          <video
            ref={video}
            className="block h-[clamp(220px,26vw,340px)] w-auto bg-ink object-cover"
            style={{ aspectRatio: `${r.width} / ${r.height}` }}
            src={`/${r.web}`}
            poster={`/${r.poster}`}
            muted
            loop
            playsInline
            preload="none"
            aria-label={r.title}
          />
        </div>
      </div>
      <figcaption className="mt-4 px-2">
        <p className="font-dm text-[17px] font-medium tracking-[-0.01em] text-ink">{r.title}</p>
        <p className="mt-1.5 font-jb text-[12px] leading-relaxed text-ink/75">
          {r.frames.toLocaleString('en-US')} frames, {r.width}×{r.height}, {secs(r.seconds_video)} of video
        </p>
        {r.credit && <p className="mt-1 font-jb text-[12px] leading-relaxed text-ink/70">{r.credit}</p>}
      </figcaption>
    </figure>
  );
}

const PAD = 'max(clamp(20px, 4.5vw, 64px), calc((100% - 1320px) / 2 + clamp(20px, 4.5vw, 64px)))';

const arrow =
  'grid size-12 place-items-center rounded-full text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--foreground)_22%,transparent)] transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] disabled:opacity-30 disabled:active:scale-100';

/**
 * The example renders (renders.json) as a row you scroll sideways: clips keep their own shape, portrait ones are narrow.
 * It bleeds off the right edge of the window, fades there while there is more, and has previous and next buttons.
 */
export function Examples() {
  const rail = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });

  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const sync = () => {
      const start = el.scrollLeft < 8;
      const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8;
      setEdge((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    return () => el.removeEventListener('scroll', sync);
  }, []);

  const go = (dir: 1 | -1) => {
    const el = rail.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <section id="examples" className={`${section} scroll-mt-6`}>
      <div data-reveal className={`${shell} flex items-end justify-between gap-6`}>
        <Heading>Made with Kinetograph.</Heading>
        <div className="flex shrink-0 gap-2 pb-1">
          <button type="button" aria-label="Previous renders" disabled={edge.start} onClick={() => go(-1)} className={arrow}>
            <ArrowLeftIcon className="size-5" strokeWidth={1.75} />
          </button>
          <button type="button" aria-label="Next renders" disabled={edge.end} onClick={() => go(1)} className={arrow}>
            <ArrowRightIcon className="size-5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
      <div
        ref={rail}
        data-reveal
        style={{ '--i': 1, paddingInline: PAD, scrollPaddingInline: PAD, scrollbarWidth: 'none', ...(edge.end ? {} : { maskImage: 'linear-gradient(to right, #000 calc(100% - 72px), transparent)' }) } as React.CSSProperties}
        tabIndex={0}
        role="region"
        aria-label="Example renders"
        className="mt-[clamp(32px,4vw,56px)] flex snap-x snap-mandatory gap-5 overflow-x-auto"
      >
        {(renders as Render[]).filter((r) => r.name !== 'launch').map((r) => (
          <RenderCard key={r.name} r={r} />
        ))}
      </div>
    </section>
  );
}
