import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

/**
 * The launch film's caption type: words written in a rotating set of handwritten faces, a face per letter, with the
 * key word broken out in a heavy display face inside a thin tracking box (corner ticks, a small mono readout).
 */
const HANDS = [
  { family: "'Caveat'", weight: 700, k: 1.18 },
  { family: "'Shadows Into Light'", weight: 400, k: 1.02 },
  { family: "'Indie Flower'", weight: 400, k: 0.98 },
  { family: "'Gloria Hallelujah'", weight: 400, k: 0.86 },
  { family: "'Patrick Hand'", weight: 400, k: 1.04 },
  { family: "'Gochi Hand'", weight: 400, k: 1.0 },
] as const;

/** Deterministic 0..1 from a string, so server and client draw the same letters. */
function rand(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967295;
}

const bare = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '');

export function Hand({
  text,
  hot,
  tag = 'TRK 01  0.97',
  display = 'archivo',
  as: Tag = 'h2',
  animate = false,
  className,
}: {
  text: string;
  /** The word that breaks out (matched without punctuation). */
  hot: string;
  /** The readout at the tracking box's top-right corner. */
  tag?: string;
  display?: 'archivo' | 'abril';
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
          const archivo = display === 'archivo';
          return (
            <span key={wi} aria-hidden className="relative mx-[0.12em] inline-block" style={delay}>
              <span
                className={cn('inline-block px-[0.1em] leading-[1.05] whitespace-nowrap', anim)}
                style={{
                  ...delay,
                  fontFamily: archivo ? "'Archivo Black'" : "'Abril Fatface'",
                  fontStyle: archivo ? 'italic' : 'normal',
                  fontSize: archivo ? '1.08em' : '1.2em',
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
          <span key={wi} aria-hidden className={cn('inline-block whitespace-nowrap', anim)} style={delay}>
            {[...word].map((ch, k) => {
              const hand = HANDS[Math.floor(rand(`h-${wi}-${k}-${word}`) * HANDS.length)]!;
              const lift = (rand(`y-${wi}-${k}-${word}`) - 0.5) * 0.09;
              const tilt = (rand(`t-${wi}-${k}-${word}`) - 0.5) * 7;
              const big = 0.94 + rand(`s-${wi}-${k}-${word}`) * 0.14;
              return (
                <span
                  key={k}
                  className="inline-block"
                  style={{
                    fontFamily: hand.family,
                    fontWeight: hand.weight,
                    fontSize: `${(hand.k * big).toFixed(3)}em`,
                    lineHeight: 1,
                    transform: `translateY(${lift.toFixed(3)}em) rotate(${tilt.toFixed(1)}deg)`,
                  }}
                >
                  {ch}
                </span>
              );
            })}
          </span>
        );
      })}
    </Tag>
  );
}
