import { CommandBar } from '@/components/code';
import { Heading } from '@/sections/heading';
import { Film } from '@/sections/page';
import { Label, shell } from '@/sections/shared';

const TAGLINE = 'Made for agents. They write video in TypeScript; Kinetograph renders every frame on the GPU, with no browser.';

/** Command bars: square, hairline cobalt, mono. */
export const commandBar =
  'w-full max-w-lg rounded-none border-cobalt/40 bg-transparent font-jb text-[13px] [&_button]:rounded-none [&_button]:before:rounded-none [&_button]:border-cobalt/40 [&_button]:text-cobalt [&_span]:text-cobalt';

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      {/* The film's vignette: paper falling off to a darker edge, faded out toward the page. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"
        style={{ background: 'radial-gradient(ellipse 75% 85% at 50% 40%, #eceae6 35%, #cfccc7 130%)' }}
      />
      <div className={`${shell} pt-[clamp(32px,5vw,72px)] pb-[clamp(48px,6vw,88px)]`}>
        <Label>An agentic video engine</Label>
        <Heading
          as="h1"
          animate
          lines={['blazingly fast', 'programmatic video.']}
          hot="fast"
          tag="TRK 01  0.97"
          className="mt-10 text-[clamp(38px,6.6vw,96px)]"
        />
        <p className="mt-8 max-w-[44ch] font-dm text-[clamp(17px,1.5vw,20px)] leading-snug tracking-[-0.01em] text-ink/75">{TAGLINE}</p>
        <div className="mt-8 flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:gap-8">
          <CommandBar command="npx kinetograph render index.tsx -o out.mp4" className={commandBar} />
          <div className="flex gap-8">
            <a href="#start" className="transition-colors hover:text-cobalt"><Label className="text-ink">Get started</Label></a>
            <a href="#film" className="transition-colors hover:text-cobalt"><Label className="text-ink">Watch the film</Label></a>
          </div>
        </div>
      </div>
      <Film />
    </section>
  );
}
