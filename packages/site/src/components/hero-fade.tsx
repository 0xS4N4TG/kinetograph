'use client';

import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { useRef, type ReactNode } from 'react';

/** The hero's content fades, blurs a little and lifts as the page scrolls it away; motion values only, no state. */
export function HeroFade({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const opacity = useTransform(scrollYProgress, [0.08, 0.7], [1, 0]);
  const filter = useTransform(scrollYProgress, [0.08, 0.7], ['blur(0px)', 'blur(10px)']);
  const y = useTransform(scrollYProgress, [0, 1], [0, -56]);
  return (
    <div ref={ref}>
      <motion.div style={reduce ? undefined : { opacity, filter, y }}>{children}</motion.div>
    </div>
  );
}
