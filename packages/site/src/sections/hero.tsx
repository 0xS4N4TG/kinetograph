import { CommandBar } from '@/components/code';
import { Display, Label, shell } from '@/sections/shared';

const TAGLINE = 'The fastest programmatic video engine on earth, made for agents.';

export const commandBar = 'w-full max-w-lg rounded-none border-ink/20 bg-transparent font-jb text-[13px]';

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      {/* The film's vignette: paper falling off to a darker edge, faded out toward the page. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"
        style={{ background: 'radial-gradient(ellipse 75% 85% at 50% 40%, #eceae6 35%, #cfccc7 130%)' }}
      />
      <div className={`${shell} pt-[clamp(56px,10vw,150px)] pb-[clamp(96px,14vw,220px)]`}>
        <Label>A video engine</Label>
        <Display as="h1" className="mt-8 max-w-[13ch] text-[clamp(48px,9.4vw,140px)] leading-[1] tracking-[-0.045em]">
          With no browser in it.
        </Display>
        <p className="mt-10 max-w-[34ch] font-dm text-[clamp(18px,1.7vw,22px)] leading-snug tracking-[-0.01em] text-ink/75">{TAGLINE}</p>
        <div className="mt-12 flex flex-col items-start gap-6">
          <CommandBar command="npx kinetograph render index.tsx -o out.mp4" className={commandBar} />
          <div className="flex gap-8">
            <a href="#start" className="transition-colors hover:text-flag"><Label className="text-ink">Get started</Label></a>
            <a href="#film" className="transition-colors hover:text-flag"><Label className="text-ink">Watch the film</Label></a>
          </div>
        </div>
      </div>
    </section>
  );
}
