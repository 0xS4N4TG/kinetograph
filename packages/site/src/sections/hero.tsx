import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowDownIcon } from 'lucide-react';

import HeroArch, { CONTROLS, SCREEN } from '@/art/hero-arch';
import { CommandBar } from '@/components/code';
import { Button } from '@/components/ui/button';
import { DOCS } from '@/sections/links';

const TAGLINE = 'The fastest programmatic video engine on earth, made for agents.';
const COMMAND = 'npx kinetograph render index.tsx -o out.mp4';

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

/**
 * Maps boxes in plate units (1440 x 800, drawn with `xMidYMid slice`) to CSS positions in the plate's element, so HTML
 * laid over the drawing stays on it however the plate is cropped.
 */
function usePlate() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const place = (b: { x: number; y: number; w: number; h: number }): CSSProperties => {
    if (!size) return { visibility: 'hidden' };
    const s = Math.max(size.w / 1440, size.h / 800);
    return {
      position: 'absolute',
      left: size.w / 2 + (b.x - 720) * s,
      top: size.h / 2 + (b.y - 400) * s,
      width: b.w,
      height: b.h,
      transform: `scale(${s})`,
      transformOrigin: '0 0',
    };
  };
  return { ref, place };
}

function Actions() {
  return (
    <div className="flex flex-wrap justify-center gap-2.5">
      <Button render={<a href="#film" />}>
        Watch the film <ArrowDownIcon />
      </Button>
      <Button variant="outline" className="bg-paper" render={<a href={DOCS} target="_blank" rel="noreferrer" />}>
        Read the docs
      </Button>
    </div>
  );
}

export function Hero() {
  const frame = useFrame();
  const { ref, place } = usePlate();
  return (
    <section className="px-[clamp(8px,1.4vw,20px)]">
      <div ref={ref} className="relative mx-auto aspect-[1440/800] w-full max-w-[1440px] overflow-hidden bg-cobalt text-paper sm:max-h-[860px] sm:min-h-[680px]">
        <HeroArch className="absolute inset-0 size-full" />
        <div className="pointer-events-none absolute inset-3 border border-paper/40 sm:inset-4" />
        <span className="absolute top-6 left-7 hidden bg-cobalt px-2 font-mono text-[11px] tracking-[0.3em] text-paper/90 uppercase sm:block">
          Est. MDCCCXCI
        </span>
        <span className="absolute top-6 right-7 hidden bg-cobalt px-2 font-mono text-[11px] tracking-[0.3em] text-paper/90 tabular-nums uppercase sm:block">
          Frame {String(frame % 10000).padStart(4, '0')} · 30 fps
        </span>

        {/* What the camera is projecting. Sized in plate units and scaled with the plate. */}
        <div style={place(SCREEN)} className="kg-flicker flex flex-col items-center justify-center text-center text-night">
          <div className="font-mono text-[9px] tracking-[0.4em] text-cobalt/80 tabular-nums uppercase">
            Reel I · Frame {String(frame % 10000).padStart(4, '0')}
          </div>
          <h1 className="mt-2 font-serif text-[78px] leading-none font-normal tracking-[-0.02em]">Kinetograph</h1>
          <p className="mt-3 max-w-[30ch] font-serif text-[19px] leading-snug text-cobalt italic">{TAGLINE}</p>
        </div>

        <div style={place(CONTROLS)} className="hidden flex-col items-center justify-start gap-3.5 pt-1 text-night sm:flex">
          <CommandBar command={COMMAND} className="w-full border-cobalt/30 bg-paper" />
          <Actions />
        </div>
      </div>

      {/* On a phone the plate is a banner, too small to read the screen, so the tagline and controls sit under it. */}
      <div className="mx-auto flex max-w-[420px] flex-col items-center gap-5 px-5 pt-9 pb-4 text-center sm:hidden">
        <p className="font-serif text-[26px] leading-tight text-night">{TAGLINE}</p>
        <CommandBar command={COMMAND} className="w-full border-cobalt/30" />
        <Actions />
      </div>
    </section>
  );
}
