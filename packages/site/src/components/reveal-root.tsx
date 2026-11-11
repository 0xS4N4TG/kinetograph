'use client';

import { useEffect } from 'react';

/**
 * Sets `data-in` on every `[data-reveal]` element the first time it scrolls into view; index.css fades it up 8px, 45ms
 * apart by `--i`. One observer for the page, so the sections stay server components. Renders nothing.
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
    return () => io.disconnect();
  }, []);
  return null;
}
