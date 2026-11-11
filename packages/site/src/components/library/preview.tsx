'use client';

import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';
import { VIDEO_BASE } from '@/sections/links';

/** The URL of an item's preview clip: `catalog-<name>.mp4` next to the docs' clips (see `VIDEO_BASE`). */
export const previewUrl = (name: string) => `${VIDEO_BASE}catalog-${name}.mp4`;

/**
 * An item's preview: a muted loop with the poster under it. Nothing of the clip loads until it scrolls into view, and it
 * pauses when it leaves or when `paused` is set. Under prefers-reduced-motion it stays on the poster. A wide poster fills the
 * frame; a portrait or squarish one is matted inside it, on the frame's own surface (`MATTED`).
 */
/** Posters narrower than this (width over height) are matted, not cropped to fill a 16:9 frame. */
export const MATTED = 1.5;

export function Preview({ name, poster, ratio, paused = false, className }: { name: string; poster: string; ratio: number; paused?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const visible = useRef(false);
  const still = useRef(false);

  const sync = (video: HTMLVideoElement, off: boolean) => {
    if (off || still.current || !visible.current) video.pause();
    else void video.play().catch(() => {});
  };

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.muted = true;
    still.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const watch = new IntersectionObserver(
      ([entry]) => {
        visible.current = entry.isIntersecting;
        sync(video, paused);
      },
      { threshold: 0.25 },
    );
    watch.observe(video);
    return () => watch.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ref.current) sync(ref.current, paused);
  }, [paused]);

  return (
    <video
      ref={ref}
      src={previewUrl(name)}
      poster={poster}
      muted
      loop
      playsInline
      preload="none"
      aria-hidden="true"
      className={cn('block size-full', ratio < MATTED ? 'bg-fd-muted object-contain' : 'bg-night object-cover', className)}
    />
  );
}
