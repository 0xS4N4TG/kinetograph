import { ArrowUpRightIcon } from 'lucide-react';

import { CommandBar } from '@/components/code';
import { Reveal } from '@/components/reveal';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DOCS, GITHUB } from '@/sections/links';
import { body, H2, shell } from '@/sections/page';

const PAINS = [
  ['Slow', 'Every frame waits on a browser.', 'A browser renderer takes a screenshot of a live page for each frame. The same 89-frame scene takes 8.96 seconds there and 1.28 seconds here.'],
  ['Heavy', 'Every render machine needs Chrome.', 'Servers and CI runners have to install, sandbox and keep a headless browser up to date, just to draw some text and shapes.'],
  ['Blind', 'Agents write video code they cannot see.', 'Text overflows its box and layers slide off the canvas, and nobody finds out until a person watches the render.'],
] as const;

/** Names the audience and what goes wrong for them, before the page offers anything. */
export function Problem() {
  return (
    <section id="why" className="border-t border-cobalt/15 py-[clamp(72px,9vw,128px)]">
      <div className={shell}>
        <Reveal className="max-w-4xl">
          <p className="mb-4 font-mono text-xs tracking-[0.2em] text-cobalt uppercase">For people who make video with code</p>
          <H2 className="text-night">
            A browser in the render loop costs you <em className="text-cobalt">time, servers and sight.</em>
          </H2>
        </Reveal>
        <div className="mt-14 grid grid-cols-[minmax(0,1fr)] gap-px overflow-hidden border border-cobalt/20 bg-cobalt/20 md:grid-cols-3">
          {PAINS.map(([tag, title, text], i) => (
            <Reveal key={tag} delay={0.08 * i} className="bg-paper p-7 sm:p-9">
              <span className="font-serif text-lg text-cobalt italic">{tag}</span>
              <h3 className="mt-3 font-serif text-[clamp(22px,2vw,28px)] leading-snug font-normal text-night">{title}</h3>
              <p className={cn(body, 'mt-3 text-night/70')}>{text}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const OUTCOMES = [
  ['7.0× faster', 'Frames are drawn by a Rust compositor on the GPU, and FFmpeg encodes the last frame while the next one is drawn.'],
  ['Nothing to babysit', 'Node, a GPU and FFmpeg. No browser to install, and no display, so it runs the same on a laptop and on a server.'],
  ['Work an agent can check', 'lint, inspect and still let it read the scene graph and look at a frame, then fix what it finds before anyone watches.'],
] as const;

/** The product as the bridge from those problems to the outcome. */
export function Solution() {
  return (
    <section id="solution" className="border-t border-cobalt/15 py-[clamp(72px,9vw,128px)]">
      <div className={cn(shell, 'grid grid-cols-[minmax(0,1fr)] items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16')}>
        <Reveal>
          <H2 className="text-night">
            The same code, with a <em className="text-cobalt">GPU</em> where the browser was.
          </H2>
          <p className={cn(body, 'mt-5 max-w-[46ch] text-night/75')}>
            Kinetograph runs the video you already write, in TypeScript with Remotion's API, CSS, SVG, Canvas 2D and Web
            Audio. Node runs the code and a Rust compositor draws every frame, so there is no browser anywhere in the path.
          </p>
          <div className="mt-8 flex flex-wrap gap-2.5">
            <Button render={<a href="#start" />}>Get started</Button>
            <Button variant="outline" render={<a href="#film" />}>Watch the film</Button>
          </div>
        </Reveal>
        <ul className="divide-y divide-cobalt/15 border-y border-cobalt/15">
          {OUTCOMES.map(([title, text], i) => (
            <Reveal key={title} delay={0.08 * i} className="py-7">
              <li>
                <div className="font-serif text-[clamp(26px,2.6vw,36px)] leading-tight text-cobalt">{title}</div>
                <p className={cn(body, 'mt-2 max-w-[52ch] text-night/70')}>{text}</p>
              </li>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The closing offer: the same install command, the docs, and the source. */
export function FinalCta() {
  return (
    <section id="try" className="border-t border-cobalt/15 py-[clamp(72px,9vw,128px)]">
      <Reveal className={cn(shell, 'flex flex-col items-center text-center')}>
        <H2 className="max-w-[18ch] text-night">
          Make your next video with <em className="text-cobalt">code and a GPU.</em>
        </H2>
        <p className={cn(body, 'mt-5 max-w-[48ch] text-night/75')}>
          Install it, point it at a Remotion project and render. Free for individuals and small companies under the
          PolyForm Small Business licence.
        </p>
        <CommandBar command="npm install kinetograph" className="mt-8 w-full max-w-md border-cobalt/30" />
        <div className="mt-5 flex flex-wrap justify-center gap-2.5">
          <Button render={<a href={DOCS} target="_blank" rel="noreferrer" />}>Read the docs</Button>
          <Button variant="outline" render={<a href={GITHUB} target="_blank" rel="noreferrer" />}>
            Star on GitHub <ArrowUpRightIcon />
          </Button>
        </div>
      </Reveal>
    </section>
  );
}
