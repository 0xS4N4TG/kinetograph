'use client';

import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Sets `data-in` once, the first time the element scrolls into view. The CSS does the rest: `kc-enter` fades and
 * lifts it in (staggered by `index`), `kc-wipe` reveals a big clip from the top down. It never blocks interaction.
 */
export function InView({
  as = 'div',
  index = 0,
  wipe = false,
  className,
  style,
  children,
}: {
  as?: 'div' | 'li';
  index?: number;
  wipe?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const watch = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setSeen(true);
        watch.disconnect();
      },
      { threshold: 0.12 },
    );
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  return createElement(
    as,
    {
      ref,
      'data-in': seen ? '' : undefined,
      className: cn(wipe ? 'kc-wipe' : 'kc-enter', className),
      style: { ...style, '--i': index } as CSSProperties,
    },
    children,
  );
}
