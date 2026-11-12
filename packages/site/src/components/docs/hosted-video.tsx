'use client';

import { useState } from 'react';

/**
 * A hosted clip with a poster. If the clip cannot load (the browser's own "cannot play" icon is all a reader would
 * otherwise see), the poster stays with a link to the file. `muted` is set as a property too: React leaves the attribute
 * out of the server HTML, and iOS refuses to autoplay a clip that is not muted by the time it loads.
 */
export function HostedVideo({ src, poster, label, silent = false, autoPlay = false, className }: { src: string; poster: string; label: string; silent?: boolean; autoPlay?: boolean; className: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className={`relative overflow-hidden ${className}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={poster} alt={label} className="size-full object-cover" />
        <a href={src} className="absolute inset-x-0 bottom-0 bg-black/70 px-3 py-2 text-center text-sm text-white">
          The video did not load. Open the file.
        </a>
      </div>
    );
  }
  return (
    <video
      ref={(v) => {
        if (!v) return;
        if (silent) v.muted = true;
        if (v.error) setFailed(true); // the error event can fire before hydration
      }}
      className={className}
      src={src}
      poster={poster}
      aria-label={label}
      playsInline
      preload="metadata"
      controls={!silent}
      muted={silent}
      loop={silent}
      autoPlay={silent || autoPlay}
      onError={() => setFailed(true)}
    />
  );
}
