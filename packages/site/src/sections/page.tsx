'use client';

import { useRef, useState } from 'react';
import { PlayIcon } from 'lucide-react';

import { doc } from '@/sections/links';
import { body, Display, Label, link, section, shell } from '@/sections/shared';

const FACTS = [
  ['7.0×', 'faster than Remotion'],
  ['988 / 988', 'frames of a real project'],
  ['0', 'browsers'],
] as const;

/** The three numbers the page already stated, set as plain type. */
export function Facts() {
  return (
    <section id="why" className={`${shell} ${section}`}>
      <dl className="grid grid-cols-[minmax(0,1fr)] gap-14 border-t border-ink/15 pt-14 md:grid-cols-3 md:gap-10">
        {FACTS.map(([n, label]) => (
          <div key={label}>
            <dt className="font-dm text-[clamp(44px,5.4vw,76px)] leading-none font-extralight tracking-[-0.04em] whitespace-nowrap text-ink tabular-nums">{n}</dt>
            <dd className="mt-4"><Label>{label}</Label></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function Film() {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <section id="film" className={`${shell} ${section}`}>
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
            <span className="flex size-20 items-center justify-center rounded-full bg-flag text-white transition-transform duration-300 group-hover:scale-105 group-active:scale-[0.97]">
              <PlayIcon className="ml-1 size-7 fill-current" />
            </span>
          </button>
        )}
      </div>
      <p className={`${body} mt-6 max-w-[62ch]`}>
        This film was rendered by Kinetograph: 1,521 frames in 297 seconds on a laptop. Everything in it, sound effects
        included, comes from one TypeScript project in the repo,{' '}
        <a className={link} href={doc('examples/launch')} target="_blank" rel="noreferrer">examples/launch</a>.
      </p>
    </section>
  );
}

/** The product in two plain blocks: what it runs, and what an agent can do with it. */
export function About() {
  return (
    <section id="engine" className={`${shell} ${section}`}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-20 border-t border-ink/15 pt-[clamp(56px,8vw,112px)] md:grid-cols-2">
        <div>
          <Label>The engine</Label>
          <Display className="mt-6 text-[clamp(32px,3.8vw,52px)]">The same code, with a GPU where the browser was.</Display>
          <p className={`${body} mt-8 max-w-[44ch]`}>
            Kinetograph runs the video you already write, in TypeScript with Remotion's API, CSS, SVG, Canvas 2D and Web
            Audio. Node runs the code and a Rust compositor draws every frame, so there is no browser anywhere in the path.
          </p>
        </div>
        <div id="agents">
          <Label>For agents</Label>
          <Display className="mt-6 text-[clamp(32px,3.8vw,52px)]">An agent can see its own work.</Display>
          <p className={`${body} mt-8 max-w-[44ch]`}>
            Every command takes <code className="font-jb text-[14px]">--json</code>, and{' '}
            <code className="font-jb text-[14px]">kinetograph mcp</code> serves them as tools. An agent writes the TSX,
            renders a still, reads the scene graph and fixes what it finds before anyone watches.
          </p>
        </div>
      </div>
    </section>
  );
}
