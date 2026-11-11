'use client';

import { useEffect } from 'react';

/**
 * Sets `data-in` on every `[data-reveal]` element the first time it scrolls into view; index.css fades it up 8px, 45ms
 * apart by `--i`. One observer for the page, so the sections stay server components. It also does the touch peek of the untreated pictures. Renders nothing.
 */
export function RevealRoot() {
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>('[data-reveal]');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.in = '';
          io.unobserve(e.target);
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );
    els.forEach((el) => io.observe(el));

    // Touch has no hover: show each untreated picture once, for about two seconds, when it is fully in view.
    const touch = window.matchMedia('(hover: none)').matches && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timers: number[] = [];
    const peek = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          peek.unobserve(el);
          el.dataset.peek = '';
          timers.push(window.setTimeout(() => delete el.dataset.peek, 2100));
        }
      },
      { threshold: 0.9 },
    );
    if (touch) document.querySelectorAll<HTMLElement>('.kg-pic:has(> .orig)').forEach((el) => peek.observe(el));
    return () => {
      io.disconnect();
      peek.disconnect();
      timers.forEach(clearTimeout);
    };
  }, []);
  return null;
}
