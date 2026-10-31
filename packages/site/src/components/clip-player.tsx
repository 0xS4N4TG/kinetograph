'use client';

import { useEffect, useRef, useState } from 'react';

import type { Clip } from '@/lib/catalog';
import { cn } from '@/lib/utils';

/**
 * A muted, looping clip with its poster. It starts when it scrolls into view and pauses when it leaves. Under
 * prefers-reduced-motion it never starts: the poster shows with controls. The width and height reserve the aspect ratio.
 * With `play="hover"` (the index tiles) a desktop pointer or keyboard focus on the nearest `[data-tile]` starts it and
 * leaving rewinds it; on touch the card that is in view plays. Tiles carry no controls: the card is a link.
 */
export function ClipPlayer({ clip, label, className, play = 'view' }: { clip: Clip; label: string; className?: string; play?: 'view' | 'hover' }) {
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
    if (play === 'hover' && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      const root = video.closest('[data-tile]') ?? video;
      const start = () => void video.play().catch(() => {});
      const stop = () => {
        video.pause();
        video.currentTime = 0;
      };
      root.addEventListener('pointerenter', start);
      root.addEventListener('pointerleave', stop);
      root.addEventListener('focusin', start);
      root.addEventListener('focusout', stop);
      return () => {
        root.removeEventListener('pointerenter', start);
        root.removeEventListener('pointerleave', stop);
        root.removeEventListener('focusin', start);
        root.removeEventListener('focusout', stop);
      };
    }
    const watch = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void video.play().catch(() => {});
        else video.pause();
      },
      { threshold: play === 'hover' ? 0.6 : 0.25 },
    );
    watch.observe(video);
    return () => watch.disconnect();
  }, [play]);

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
      controls={still && play === 'view'}
      aria-label={label}
      className={cn('block h-auto w-full bg-ink/5', className)}
    />
  );
}
