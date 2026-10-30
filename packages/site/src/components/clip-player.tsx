'use client';

import { useEffect, useRef, useState } from 'react';

import type { Clip } from '@/lib/catalog';
import { cn } from '@/lib/utils';

/**
 * A muted, looping clip with its poster. It starts when it scrolls into view and pauses when it leaves. Under
 * prefers-reduced-motion it never starts: the poster shows with controls. The width and height reserve the aspect ratio.
 */
export function ClipPlayer({ clip, label, className }: { clip: Clip; label: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [still, setStill] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.muted = true;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStill(true);
      return;
    }
    const watch = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.25 },
    );
    watch.observe(video);
    return () => watch.disconnect();
  }, []);

  return (
    <video
      ref={ref}
      src={clip.video}
      poster={clip.src}
      width={clip.w}
      height={clip.h}
      muted
      loop
      playsInline
      preload="metadata"
      controls={still}
      aria-label={label}
      className={cn('block h-auto w-full bg-ink/5', className)}
    />
  );
}
