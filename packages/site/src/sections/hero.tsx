import { CommandBar } from '@/components/code';
import { FitLine } from '@/components/fit-line';
import { HeroFade } from '@/components/hero-fade';
import { PillLink } from '@/components/pill-link';
import { shell } from '@/sections/shared';
import { cn } from '@/lib/utils';

const TAGLINE = 'Write a video in TypeScript or HTML, or have an agent write it. There is no browser.';

/** Command bars: a pill with the copy button in its own circle, mono. */
export const commandBar =
  'w-full max-w-lg rounded-full border-foreground/15 bg-card py-1.5 pr-1.5 pl-6 font-jb text-[13px] [&_button]:rounded-full [&_button]:before:rounded-full [&_button]:size-10 sm:[&_button]:size-10';

export function Hero() {
  return (
    <section id="hero" className="relative">
      <HeroFade>
        <div className={cn(shell, 'flex min-h-[calc(100dvh-56px)] flex-col justify-center gap-[clamp(28px,4vw,52px)] pt-24 pb-10')}>
          <h1 aria-label="Blazingly fast programmatic video engine." className="flex flex-col gap-[clamp(12px,1.9vw,28px)]">
            <FitLine text="BLAZINGLY FAST" r={4.43} step={30} />
            <span className="max-md:hidden">
              <FitLine text="PROGRAMMATIC VIDEO ENGINE." r={8.575} step={15} lead={160} />
            </span>
            <span className="flex flex-col gap-[clamp(12px,1.9vw,28px)] md:hidden">
              <FitLine text="PROGRAMMATIC" r={4.436} step={28} lead={100} />
              <FitLine text="VIDEO ENGINE." r={4.014} step={28} lead={200} />
            </span>
          </h1>
          <div className="grid grid-cols-[minmax(0,1fr)] items-end gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14">
            <p data-reveal style={{ '--i': 14 } as React.CSSProperties} className="max-w-[40ch] font-dm text-[clamp(17px,1.5vw,20px)] leading-snug tracking-[-0.005em] text-ink/80">
              {TAGLINE}
            </p>
            <div className="flex flex-col gap-4 sm:gap-5">
              <div data-reveal style={{ '--i': 15 } as React.CSSProperties}>
                <CommandBar command="npx kinetograph render index.tsx -o out.mp4" className={commandBar} />
              </div>
              <div data-reveal style={{ '--i': 16 } as React.CSSProperties} className="flex flex-wrap gap-3">
                <PillLink href="/docs/getting-started/first-video/">Get started</PillLink>
                <PillLink href="#film" tone="ghost" icon="down">Watch the film</PillLink>
              </div>
            </div>
          </div>
        </div>
      </HeroFade>
    </section>
  );
}
