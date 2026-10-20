import { useEffect, useState } from 'react';
import { ArrowDownIcon } from 'lucide-react';

import HeroArch from '@/art/hero-arch';
import { CommandBar } from '@/components/code';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Mark } from '@/sections/nav';
import { DOCS } from '@/sections/links';

/** A frame counter that runs at 30 fps, like the corner of a timeline. */
function useFrame() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      setFrame(Math.floor(((performance.now() - start) / 1000) * 30));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return frame;
}

function Pitch({ className }: { className?: string }) {
  return (
    <div className={cn('text-night flex w-full flex-col items-center text-center', className)}>
      <Mark className="text-cobalt mb-5 size-[30px]" />
      <h1 className="font-serif text-[clamp(38px,3.4vw,50px)] leading-[1.02] font-normal tracking-[-0.01em] text-balance">
        Don't screenshot it.
        <br />
        <em className="text-cobalt">Render it.</em>
      </h1>
      <p className="mt-4 max-w-[36ch] text-[15px] leading-relaxed text-night/75">
        Write video in TypeScript with Remotion's API. Kinetograph runs it in Node and draws every frame on the GPU, in
        Rust. There is no Chrome in it.
      </p>
      <CommandBar command="npx kinetograph render index.tsx -o out.mp4" className="mt-5 w-full border-cobalt/30 bg-paper" />
      <div className="mt-4 flex flex-wrap justify-center gap-2.5">
        <Button render={<a href="#film" />}>
          Watch the film <ArrowDownIcon />
        </Button>
        <Button variant="outline" render={<a href={DOCS} target="_blank" rel="noreferrer" />}>
          Read the docs
        </Button>
      </div>
    </div>
  );
}

export function Hero() {
  const frame = useFrame();
  return (
    <section className="px-[clamp(8px,1.4vw,20px)]">
      <div className="relative mx-auto max-w-[1440px] overflow-hidden bg-cobalt text-paper aspect-[1440/800] w-full sm:min-h-[680px] sm:max-h-[860px]">
        <HeroArch className="absolute inset-0 size-full" />
        <div className="pointer-events-none absolute inset-3 border border-paper/40 sm:inset-4" />
        <span className="absolute top-6 left-7 hidden bg-cobalt px-2 font-mono text-[11px] tracking-[0.3em] text-paper/90 uppercase sm:block">
          Est. MDCCCXCI
        </span>
        <span className="absolute top-6 right-7 hidden bg-cobalt px-2 font-mono text-[11px] tracking-[0.3em] text-paper/90 tabular-nums uppercase sm:block">
          Frame {String(frame % 10000).padStart(4, '0')} · 30 fps
        </span>

        {/* Sits inside the arch: its opening runs from 26% to 95% of the plate's height, and is wide enough for type from 40%. */}
        <div className="absolute inset-x-0 top-[31%] hidden justify-center px-6 sm:flex">
          <Pitch className="max-w-[min(470px,34vw+60px)]" />
        </div>
      </div>
      {/* On a phone the plate is a banner and the pitch sits under it. */}
      <div className="flex justify-center px-5 pt-10 pb-4 sm:hidden">
        <Pitch className="max-w-[420px]" />
      </div>
    </section>
  );
}
