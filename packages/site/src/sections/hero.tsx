import { CommandBar } from '@/components/code';
import { Hand } from '@/sections/hand';
import { Label, shell } from '@/sections/shared';

const TAGLINE = 'The fastest programmatic video engine on earth, made for agents.';

/** Command bars: square, hairline cobalt, mono. */
export const commandBar =
  'w-full max-w-lg rounded-none border-cobalt/40 bg-transparent font-jb text-[13px] [&_button]:rounded-none [&_button]:border-cobalt/40 [&_button]:text-cobalt [&_span]:text-cobalt';

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      {/* The film's vignette: paper falling off to a darker edge, faded out toward the page. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"
        style={{ background: 'radial-gradient(ellipse 75% 85% at 50% 40%, #eceae6 35%, #cfccc7 130%)' }}
      />
      <div className={`${shell} pt-[clamp(56px,9vw,130px)] pb-[clamp(96px,13vw,200px)]`}>
        <Label>A video engine</Label>
        <Hand
          as="h1"
          animate
          text="with no browser in it."
          hot="browser"
          tag="TRK 01  0.97"
          className="mt-14 max-w-[13em] text-[clamp(44px,8.4vw,128px)]"
        />
        <p className="mt-14 max-w-[34ch] font-dm text-[clamp(18px,1.7vw,22px)] leading-snug tracking-[-0.01em] text-ink/75">{TAGLINE}</p>
        <div className="mt-12 flex flex-col items-start gap-6">
          <CommandBar command="npx kinetograph render index.tsx -o out.mp4" className={commandBar} />
          <div className="flex gap-8">
            <a href="#start" className="transition-colors hover:text-cobalt"><Label className="text-ink">Get started</Label></a>
            <a href="#film" className="transition-colors hover:text-cobalt"><Label className="text-ink">Watch the film</Label></a>
          </div>
        </div>
      </div>
    </section>
  );
}
