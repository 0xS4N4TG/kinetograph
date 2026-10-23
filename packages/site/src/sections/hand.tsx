import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

/**
 * The launch film's caption type, cut down to two faces for the site: words in one handwritten face (Caveat), the key
 * word broken out in Archivo Black italic inside a thin tracking box (corner ticks, a small mono readout).
 */
const bare = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '');

export function Hand({
  text,
  hot,
  tag = 'TRK 01  0.97',
  as: Tag = 'h2',
  animate = false,
  className,
}: {
  text: string;
  /** The word that breaks out (matched without punctuation). */
  hot: string;
  /** The readout at the tracking box's top-right corner. */
  tag?: string;
  as?: 'h1' | 'h2' | 'p';
  /** Words resolve one by one, then the tracking box eases onto the hot word. */
  animate?: boolean;
  className?: string;
}) {
  const words = text.split(' ');
  return (
    <Tag aria-label={text} className={cn('flex flex-wrap items-baseline gap-x-[0.32em] gap-y-[0.22em] leading-[1.15] text-ink', className)}>
      {words.map((word, wi) => {
        const delay: CSSProperties = animate ? { animationDelay: `${wi * 90}ms` } : {};
        const anim = animate ? 'kg-in' : '';
        if (bare(word) === bare(hot)) {
          return (
            <span key={wi} aria-hidden className="relative mx-[0.12em] inline-block" style={delay}>
              <span
                className={cn('inline-block px-[0.1em] leading-[1.05] whitespace-nowrap', anim)}
                style={{
                  ...delay,
                  fontFamily: "'Archivo Black'",
                  fontStyle: 'italic',
                  fontSize: '1.08em',
                }}
              >
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
        }
        return (
          <span
            key={wi}
            aria-hidden
            className={cn('inline-block whitespace-nowrap', anim)}
            style={{ ...delay, fontFamily: "'Caveat'", fontWeight: 700, fontSize: '1.18em', lineHeight: 1 }}
          >
            {word}
          </span>
        );
      })}
    </Tag>
  );
}
