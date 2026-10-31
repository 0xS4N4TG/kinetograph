'use client';

import { useEffect, useRef, useState } from 'react';
import { PlayIcon } from 'lucide-react';

import { CommandBar } from '@/components/code';
import { Heading } from '@/sections/heading';
import { commandBar } from '@/sections/hero';
import { doc } from '@/sections/links';
import renders from '@/sections/renders.json';
import { body, h2Size, link, section, shell } from '@/sections/shared';

interface Render {
  name: string;
  title: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  seconds_video: number;
  render_median: number;
  web: string;
  poster: string;
}

/** Seconds as the page states them: whole above 10, one decimal below (6 s, 2.3 s). */
const secs = (s: number) => `${s >= 10 ? Math.round(s) : Number(s.toFixed(1))} s`;

/** One example: a muted looping clip that plays while it is in view or hovered, and the facts of its render. */
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
    <figure onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <video
        ref={video}
        className="aspect-video w-full bg-ink object-contain"
        src={`/${r.web}`}
        poster={`/${r.poster}`}
        muted
        loop
        playsInline
        preload="none"
        aria-label={r.title}
      />
      <figcaption className="mt-4">
        <p className="font-dm text-[17px] font-medium tracking-[-0.01em] text-ink">{r.title}</p>
        <p className="mt-1.5 font-jb text-[12px] leading-relaxed text-ink/75">
          {r.frames.toLocaleString('en-US')} frames, {r.width}×{r.height}, {secs(r.seconds_video)} of video
        </p>
        <p className="font-jb text-[12px] leading-relaxed text-cobalt">rendered in {secs(r.render_median)}</p>
      </figcaption>
    </figure>
  );
}

/** Our own render times for example videos, stated plainly. The cards come from renders.json. */
export function Facts() {
  return (
    <section id="why" className={`${shell} ${section}`}>
      <div className="border-t border-cobalt/30 pt-[clamp(56px,8vw,112px)]">
        <Heading lines={['fast facts']} hot="facts" tag="TRK 02  0.94" className={h2Size} />
        <div className="mt-14 grid grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] gap-x-8 gap-y-14">
          {(renders as Render[]).filter((r) => r.name !== 'launch').map((r) => (
            <RenderCard key={r.name} r={r} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** The launch film under the hero: the poster with a play button; it plays in place, with sound. */
export function Film() {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <div id="film" className={`${shell} scroll-mt-6 pb-[clamp(72px,10vw,140px)]`}>
      <div>
        <div className="relative aspect-video overflow-hidden bg-ink">
          <video
            ref={video}
            className="size-full object-cover"
            src="/film/launch.mp4"
            poster="/film/poster.jpg"
            preload="none"
            playsInline
            controls={playing}
            onPlay={() => setPlaying(true)}
          />
          {!playing && (
            <button
              type="button"
              onClick={() => void video.current?.play()}
              className="group absolute inset-0 flex items-center justify-center"
              aria-label="Play the launch film"
            >
              <span className="flex size-20 items-center justify-center bg-cobalt text-white transition-transform duration-300 group-hover:scale-105 group-active:scale-[0.97]">
                <PlayIcon className="ml-1 size-7 fill-current" />
              </span>
            </button>
          )}
        </div>
        <p className={`${body} mt-6 max-w-[62ch]`}>
          This film was rendered by Kinetograph: 1,184 frames in 26 seconds on a laptop. Everything in it, sound effects
          included, comes from one TypeScript project in the repo,{' '}
          <a className={link} href={doc('examples/launch')} target="_blank" rel="noreferrer">examples/launch</a>.
        </p>
      </div>
    </div>
  );
}

/** The product in two plain blocks: what it runs, and what an agent can do with it. */
export function About() {
  return (
    <section id="engine" className={`${shell} ${section}`}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-24 border-t border-cobalt/30 pt-[clamp(56px,8vw,112px)] md:grid-cols-2">
        <div>
          <Heading lines={['the same code, with a GPU where the browser was.']} hot="GPU" tag="TRK 03  0.96" className="text-[clamp(32px,3.6vw,52px)]" />
          <p className={`${body} mt-10 max-w-[44ch]`}>
            Kinetograph runs the video you already write, in TypeScript with Remotion's API, CSS, SVG, Canvas 2D and Web
            Audio, or as an HTML page with GSAP, so HyperFrames projects render as they are. Node runs the code and a Rust
            compositor draws every frame, so there is no browser anywhere in the path.
          </p>
        </div>
        <div id="agents">
          <Heading lines={['an agent can see its own work.']} hot="see" tag="TRK 04  0.92" className="text-[clamp(32px,3.6vw,52px)]" />
          <p className={`${body} mt-10 max-w-[44ch]`}>
            Every command takes <code className="font-jb text-[14px]">--json</code>, and{' '}
            <code className="font-jb text-[14px]">kinetograph mcp</code> serves them as tools. An agent writes the TSX or HTML,
            renders a still, reads the scene graph and fixes what it finds before anyone watches.
          </p>
          <p className={`${body} mt-6 max-w-[44ch]`}>Give your agent the Kinetograph skills:</p>
          <CommandBar command="npx skills add 0xS4N4TG/kinetograph" className={`mt-4 ${commandBar}`} />
        </div>
      </div>
    </section>
  );
}
