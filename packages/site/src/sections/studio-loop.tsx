'use client';

import { useEffect, useRef } from 'react';

/** A muted looping clip that plays only while it is in view; under reduced motion it stays on its poster. */
export function StudioLoop({ src, poster, label, width, height }: { src: string; poster: string; label: string; width: number; height: number }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) void el.play().catch(() => {});
      else el.pause();
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <video
      ref={video}
      className="block h-auto w-full bg-black"
      style={{ aspectRatio: `${width} / ${height}` }}
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      preload="none"
      aria-label={label}
    />
  );
}
