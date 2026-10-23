import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Wordmark as in the launch film: DM Sans 700, tight tracking, the full stop in red. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-dm font-bold tracking-[-0.05em]', className)}>
      kinetograph<span className="text-flag">.</span>
    </span>
  );
}

/** Small uppercase label with the film's wide tracking. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('font-dm text-[12px] font-medium tracking-[0.32em] text-mute uppercase', className)}>{children}</p>;
}

/** Hairline display headline. */
export function Display({ children, className, as: Tag = 'h2' }: { children: ReactNode; className?: string; as?: 'h1' | 'h2' }) {
  return (
    <Tag className={cn('font-dm text-[clamp(40px,6vw,88px)] font-extralight tracking-[-0.04em] text-balance text-ink', className, 'leading-[1.05]')}>
      {children}
    </Tag>
  );
}

export const shell = 'mx-auto w-full max-w-[1200px] px-[clamp(20px,5vw,64px)]';
export const section = 'pb-[clamp(88px,13vw,200px)]';
export const body = 'font-dm text-[17px] leading-[1.6] font-normal tracking-[-0.01em] text-ink/75';
export const link = 'underline decoration-ink/25 underline-offset-4 transition-colors hover:decoration-flag';
