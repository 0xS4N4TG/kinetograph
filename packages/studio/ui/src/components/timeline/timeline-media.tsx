import { useEffect, useMemo, useState } from 'react';

import type { Waveform as WaveformData } from '@/api';

/** Peaks come in power-of-two bucket counts, so a zoom step does not ask for new ones every time. */
const MIN_BUCKETS = 64;
const MAX_BUCKETS = 2048;
const PX_PER_BUCKET = 3;

export function bucketsFor(widthPx: number): number {
  let n = MIN_BUCKETS;
  while (n < MAX_BUCKETS && n * PX_PER_BUCKET < widthPx) n *= 2;
  return n;
}

/** The peaks of one sound from the server, in `buckets`; the ones on show stay until newer ones arrive. */
export function useWaveform(load: (clip: string | undefined, buckets: number) => Promise<WaveformData>, clip: string, buckets: number): WaveformData | null {
  const [data, setData] = useState<WaveformData | null>(null);
  useEffect(() => {
    let cancelled = false;
    load(clip, buckets).then(
      (next) => !cancelled && setData(next),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [load, clip, buckets]);
  return data;
}

/** A sound drawn as thin mirrored lines, one per peak, in the row's colour. */
export function WaveformLine({ peaks, width, height }: { peaks: number[]; width: number; height: number }) {
  const d = useMemo(() => {
    const mid = height / 2;
    const step = width / Math.max(1, peaks.length);
    let path = '';
    peaks.forEach((peak, i) => {
      const half = Math.max(0.5, peak * (mid - 1));
      const x = (i + 0.5) * step;
      path += `M${x.toFixed(2)} ${(mid - half).toFixed(2)}V${(mid + half).toFixed(2)}`;
    });
    return path;
  }, [peaks, width, height]);
  return (
    <svg data-testid="waveform" width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="text-chart-1 pointer-events-none absolute top-1/2 left-0 -translate-y-1/2" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth={Math.min(1.5, Math.max(0.75, width / Math.max(1, peaks.length) - 0.5))} strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** A video clip's film strip: small pictures of evenly spaced frames across its bar; the browser loads the ones in view. */
export function VideoStrip({
  first,
  end,
  width,
  height,
  thumbnailUrl,
}: {
  /** The clip's first frame, and the one after its last. */
  first: number;
  end: number;
  width: number;
  height: number;
  thumbnailUrl: (frame: number, height: number) => string | null;
}) {
  const tile = Math.round(height * (16 / 9));
  const count = Math.max(1, Math.min(60, Math.ceil(width / tile)));
  const frames = end - first;
  return (
    <div data-testid="video-strip" className="pointer-events-none absolute inset-0 flex overflow-hidden opacity-80" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => {
        const src = thumbnailUrl(Math.min(end - 1, first + Math.floor(((i + 0.5) / count) * frames)), height * 2);
        return (
          <div key={i} className="relative h-full min-w-0 flex-1 overflow-hidden">
            {src && <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
          </div>
        );
      })}
    </div>
  );
}
