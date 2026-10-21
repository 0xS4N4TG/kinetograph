import Lenis from 'lenis';

let lenis: Lenis | null = null;

/** Starts Lenis smooth scrolling and returns a teardown. Skipped when the visitor prefers reduced motion. */
export function startSmoothScroll() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  lenis = new Lenis({ anchors: true });
  let raf = requestAnimationFrame(function tick(time) {
    lenis?.raf(time);
    raf = requestAnimationFrame(tick);
  });
  return () => {
    cancelAnimationFrame(raf);
    lenis?.destroy();
    lenis = null;
  };
}

/** Scrolls to the top, eased by Lenis when it is running and by the browser otherwise. */
export function scrollToTop() {
  if (lenis) lenis.scrollTo(0);
  else window.scrollTo({ top: 0, behavior: 'smooth' });
}
