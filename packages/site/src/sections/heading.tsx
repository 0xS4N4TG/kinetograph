import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

/**
 * Headings in the launch film's end-card face (DM Sans 700, tight tracking), with one hot word in a thin cobalt
 * tracking box (corner ticks, a small mono readout) like the film's captions.
 */
const bare = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '');

export function Heading({
  lines,
  hot,
  tag = 'TRK 01  0.97',
  as: Tag = 'h2',
  animate = false,
  className,
}: {
  /** The heading's lines; each line may still wrap on a narrow screen. */
  lines: string[];
  /** The word that gets the tracking box (matched without punctuation). */
  hot: string;
  /** The readout at the tracking box's top-right corner. */
  tag?: string;
  as?: 'h1' | 'h2';
  /** Words resolve one by one, then the tracking box eases onto the hot word. */
  animate?: boolean;
  className?: string;
}) {
  let n = 0;
  return (
    <Tag aria-label={lines.join(' ')} className={cn('font-dm leading-[1.12] font-bold tracking-[-0.045em] text-ink', className)}>
      {lines.map((line, li) => (
        <span key={li} aria-hidden className="flex flex-wrap items-baseline gap-x-[0.26em] gap-y-[0.2em]">
          {line.split(' ').map((word) => {
            const wi = n++;
            const delay: CSSProperties = animate ? { animationDelay: `${wi * 90}ms` } : {};
            const anim = animate ? 'kg-in' : '';
            if (bare(word) !== bare(hot)) {
              return (
                <span key={wi} className={cn('inline-block whitespace-nowrap', anim)} style={delay}>
                  {word}
                </span>
              );
            }
            return (
              <span key={wi} className="relative mx-[0.08em] inline-block">
                <span className={cn('inline-block px-[0.12em] whitespace-nowrap italic', anim)} style={delay}>
                  {word}
                </span>
                <span
                  className={cn('pointer-events-none absolute inset-0 border border-cobalt', animate && 'kg-box')}
                  style={animate ? { animationDelay: `${wi * 90 + 350}ms` } : undefined}
                >
                  {['-left-[3px] -top-[3px]', '-right-[3px] -top-[3px]', '-bottom-[3px] -left-[3px]', '-right-[3px] -bottom-[3px]'].map((p) => (
                    <i key={p} className={cn('absolute block size-[5px] bg-cobalt', p)} />
                  ))}
                  <span className="absolute right-0 bottom-full mb-1.5 font-jb text-[10px] leading-none font-normal tracking-[0.04em] whitespace-nowrap text-cobalt not-italic">
                    {tag}
                  </span>
                </span>
              </span>
            );
          })}
        </span>
      ))}
    </Tag>
  );
}
