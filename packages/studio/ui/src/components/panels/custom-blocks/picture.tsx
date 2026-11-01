import { PauseIcon, PlayIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { useBuildId, useStudioContext } from '@/lib/studio-context';

import { frameSrc } from '../frame-src';
import type { Block } from '../types';
import { BlockShell } from './shell';

/** A frame of a composition in a box that shows a skeleton until it has loaded, and says so when it cannot be drawn. */
export function FrameImage({ comp, frame, scale = 0.5, alt, className }: { comp: string; frame: number; scale?: number; alt: string; className?: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const src = frameSrc(comp, frame, scale, useBuildId());
  useEffect(() => setState('loading'), [src]);
  return (
    <div className={cn('bg-muted relative overflow-hidden rounded-md', state !== 'ready' && 'aspect-video', className)}>
      <img
        src={src}
        alt={alt}
        draggable={false}
        loading="lazy"
        onLoad={() => setState('ready')}
        onError={() => setState('error')}
        className={cn('block h-auto w-full', state !== 'ready' && 'invisible absolute inset-0 size-full')}
      />
      {state === 'loading' ? <Skeleton data-testid="frame-skeleton" className="absolute inset-0 rounded-none" /> : null}
      {state === 'error' ? (
        <div role="alert" className="text-muted-foreground absolute inset-0 flex items-center justify-center p-3 text-center text-xs">
          Could not draw {comp} at frame {frame}.
        </div>
      ) : null}
    </div>
  );
}

export function StillBlock({ block }: { block: Extract<Block, { type: 'still' }> }) {
  return (
    <BlockShell block={block}>
      <figure className="flex flex-col gap-1.5">
        <FrameImage comp={block.comp} frame={block.frame} alt={block.caption ?? `${block.comp} at frame ${block.frame}`} />
        {block.caption ? <figcaption className="text-muted-foreground text-xs">{block.caption}</figcaption> : null}
      </figure>
    </BlockShell>
  );
}

/** Pictures a second, at most: a clip shows about 6 frames a second, each from the frame route, and waits for each to load. */
const SHOWN_PER_SECOND = 6;

export function ClipBlock({ block }: { block: Extract<Block, { type: 'clip' }> }) {
  const studio = useStudioContext();
  const fps = studio?.compositions.find((c) => c.id === block.comp)?.fps ?? 30;
  const step = Math.max(1, Math.round(fps / SHOWN_PER_SECOND));
  const [frame, setFrame] = useState(block.from);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const src = frameSrc(block.comp, frame, 0.5, useBuildId());

  // The next picture is asked for once the one on show has loaded, for as long as the frame would have lasted.
  useEffect(() => {
    if (!playing || loaded !== frame) return;
    const timer = setTimeout(() => setFrame((f) => (f + step > block.to ? block.from : f + step)), (step / fps) * 1000);
    return () => clearTimeout(timer);
  }, [playing, loaded, frame, step, fps, block.from, block.to]);

  return (
    <BlockShell block={block}>
      <figure className="flex flex-col gap-1.5">
        <div className="bg-muted relative aspect-video overflow-hidden rounded-md">
          {/* One element for the whole clip, so the last picture stays up while the next one loads. */}
          <img
            src={src}
            alt={block.caption ?? `${block.comp}, frames ${block.from} to ${block.to}`}
            draggable={false}
            onLoad={() => {
              setLoaded(frame);
              setFailed(false);
            }}
            onError={() => {
              setFailed(true);
              setPlaying(false);
            }}
            className="block size-full object-contain"
          />
          {loaded === null && !failed ? <Skeleton data-testid="frame-skeleton" className="absolute inset-0 rounded-none" /> : null}
          {failed ? (
            <div role="alert" className="bg-muted text-muted-foreground absolute inset-0 flex items-center justify-center p-3 text-center text-xs">
              Could not draw {block.comp} at frame {frame}.
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon-sm" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((p) => !p)}>
            {playing ? <PauseIcon /> : <PlayIcon />}
          </Button>
          <Slider
            aria-label="Position in the clip"
            getAriaLabel={() => 'Position in the clip'}
            min={block.from}
            max={block.to}
            step={1}
            value={frame}
            onValueChange={(v) => {
              setPlaying(false);
              setFrame(Array.isArray(v) ? (v[0] ?? block.from) : v);
            }}
          />
          <span className="text-muted-foreground w-16 shrink-0 text-right text-xs tabular-nums">{frame}</span>
        </div>
        {block.caption ? <figcaption className="text-muted-foreground text-xs">{block.caption}</figcaption> : null}
      </figure>
    </BlockShell>
  );
}
