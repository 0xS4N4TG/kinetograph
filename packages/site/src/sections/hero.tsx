import { useEffect, useRef, type CSSProperties } from 'react';
import { ArrowDownIcon } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';

import HeroPlate, { EDGE, GATE, PLATE } from '@/art/hero-plate';
import { CommandBar } from '@/components/code';
import { Button } from '@/components/ui/button';

const TAGLINE = 'The fastest programmatic video engine on earth, made for agents.';
const PROOF = [['7.0×', 'faster than Remotion'], ['988 / 988', 'frames of a real project'], ['0', 'browsers']] as const;
const COMMAND = 'npx kinetograph render index.tsx -o out.mp4';
/** The loop is cut from the launch film starting at 19.5 s, so its frames are numbered from there. */
const LOOP_START = Math.round(19.5 * 30);

/** A box in plate units as percentages of the plate, which is drawn to fill its box exactly. */
const at = (b: { x: number; y: number; w: number; h: number }): CSSProperties => ({
  position: 'absolute',
  left: `${(b.x / PLATE.w) * 100}%`,
  top: `${(b.y / PLATE.h) * 100}%`,
  width: `${(b.w / PLATE.w) * 100}%`,
  height: `${(b.h / PLATE.h) * 100}%`,
});

/** The clip in the gate, with the launch film's frame number printed on the strip's edge as it plays. */
function Gate() {
  const video = useRef<HTMLVideoElement>(null);
  const code = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) v.pause();
    let handle = 0;
    const show = (t: number) => {
      if (code.current) code.current.textContent = String(LOOP_START + Math.floor(t * 30)).padStart(4, '0');
    };
    const tick = (_: number, meta: VideoFrameCallbackMetadata) => {
      show(meta.mediaTime);
      handle = v.requestVideoFrameCallback(tick);
    };
    handle = v.requestVideoFrameCallback(tick);
    return () => v.cancelVideoFrameCallback(handle);
  }, []);
  return (
    <>
      <video
        ref={video}
        style={at(GATE)}
        className="object-cover"
        src="/film/loop.mp4"
        poster="/film/loop.jpg"
        autoPlay
        muted
        loop
        playsInline
        aria-label="A clip from the launch film, rendered by Kinetograph"
      />
      <div style={at(EDGE)} className="flex items-center justify-between font-mono text-[1.25cqw] tracking-[0.3em] text-cobalt/80 tabular-nums">
        <span>FRAME <span ref={code}>{String(LOOP_START).padStart(4, '0')}</span></span>
        <span>30 FPS</span>
      </div>
    </>
  );
}

export function Hero() {
  const reduce = useReducedMotion();
  const enter = (delay: number) => ({
    initial: reduce ? false : { opacity: 0, y: 18 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.8, delay, ease: [0.16, 1, 0.3, 1] as const },
  });
  return (
    <section className="mx-auto grid max-w-[1440px] grid-cols-[minmax(0,1fr)] items-center gap-10 px-[clamp(16px,3vw,44px)] pt-10 pb-16 lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14 lg:py-12">
      <div className="max-w-[560px]">
        <motion.h1 {...enter(0)} className="pb-1 font-serif text-[clamp(52px,6.4vw,100px)] leading-[1.02] font-normal tracking-[-0.03em] text-night">
          Kinetograph
        </motion.h1>
        <motion.p {...enter(0.08)} className="mt-5 max-w-[30ch] text-[clamp(19px,1.6vw,23px)] leading-snug text-night/75">
          {TAGLINE}
        </motion.p>
        <motion.div {...enter(0.16)} className="mt-9 flex flex-col gap-4">
          <CommandBar command={COMMAND} className="w-full border-cobalt/30" />
          <div className="flex flex-wrap gap-2.5">
            <Button render={<a href="#start" />}>
              Get started <ArrowDownIcon />
            </Button>
            <Button variant="outline" render={<a href="#film" />}>
              Watch the film
            </Button>
          </div>
          <dl className="mt-2 grid grid-cols-3 gap-4 border-t border-cobalt/15 pt-5">
            {PROOF.map(([n, label]) => (
              <div key={label}>
                <dt className="font-serif text-[clamp(24px,2.4vw,34px)] leading-none text-cobalt tabular-nums">{n}</dt>
                <dd className="mt-1.5 text-xs leading-snug text-night/65">{label}</dd>
              </div>
            ))}
          </dl>
        </motion.div>
      </div>

      <motion.div
        initial={reduce ? false : { opacity: 0, scale: 0.985 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 1, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        className="@container relative mx-auto aspect-[840/720] w-full lg:max-w-[min(100%,calc((100dvh-10rem)*840/720))]"
      >
        <HeroPlate className="absolute inset-0 size-full" />
        <Gate />
      </motion.div>
    </section>
  );
}
