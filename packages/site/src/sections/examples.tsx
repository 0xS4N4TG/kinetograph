'use client';

import { useEffect, useRef, useState } from 'react';

import renders from '@/sections/renders.json';

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

/** The example renders (renders.json) as a row you scroll sideways: clips keep their own shape, portrait ones are narrow. */
export function Examples() {
  return (
    <div data-reveal className="mt-[clamp(72px,9vw,128px)]">
      <div
        tabIndex={0}
        role="region"
        aria-label="Example renders"
        className="flex snap-x snap-mandatory gap-5 overflow-x-auto pb-4 [scrollbar-width:thin]"
        style={{
          paddingInline: 'max(clamp(20px, 4.5vw, 64px), calc((100% - 1320px) / 2 + clamp(20px, 4.5vw, 64px)))',
          scrollPaddingInline: 'max(clamp(20px, 4.5vw, 64px), calc((100% - 1320px) / 2 + clamp(20px, 4.5vw, 64px)))',
          scrollbarColor: 'color-mix(in oklab, var(--foreground) 30%, transparent) transparent',
        }}
      >
        {(renders as Render[]).filter((r) => r.name !== 'launch').map((r) => (
          <RenderCard key={r.name} r={r} />
        ))}
      </div>
    </div>
  );
}
